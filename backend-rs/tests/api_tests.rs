/// Integration tests for the Host CRUD API.
///
/// Uses a temporary in-memory SQLite database to test the full HTTP stack.
mod common;
#[cfg(test)]
mod api_tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::Router;
    use serde_json::{json, Value};
    use tower::ServiceExt; // for `oneshot`

    async fn setup_app() -> (Router, String, sqlx::SqlitePool) {
        let (app, token, pool, _) = setup_app_with_state().await;
        (app, token, pool)
    }

    async fn setup_app_with_state() -> (
        Router,
        String,
        sqlx::SqlitePool,
        netrix_backend::auth::AppState,
    ) {
        use netrix_backend::auth::AppState;
        use netrix_backend::routers;
        use netrix_backend::ssh::{SessionManager, SftpManager};
        use netrix_backend::vault;

        crate::common::init();

        // Use a unique in-memory database per test.
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect to in-memory db");

        for schema in [
            include_str!("../migrations/001_initial_schema.sql"),
            include_str!("../migrations/003_add_host_capabilities.sql"),
            include_str!("../migrations/004_add_local_shell_fields.sql"),
            include_str!("../migrations/006_host_revisions.sql"),
            include_str!("../migrations/007_terminal_colors.sql"),
            include_str!("../migrations/008_terminal_appearance.sql"),
        ] {
            sqlx::raw_sql(schema)
                .execute(&pool)
                .await
                .expect("apply schema");
        }

        let token = "test-token-12345".to_string();
        let state = AppState {
            database_encryption: None,
            security: netrix_backend::security::AppSecurity::default(),
            db: pool.clone(),
            vault: vault::new_vault(),
            api_token: token.clone(),
            sessions: SessionManager::new(),
            sftp: SftpManager::new(),
            quick_connect_tickets: netrix_backend::auth::QuickConnectTicketStore::new(),
            vault_unlock_limiter: netrix_backend::auth::VaultUnlockLimiter::new(),
        };

        let app = Router::new()
            .merge(routers::health::router())
            .merge(routers::security::router())
            .merge(routers::hosts::router())
            .merge(routers::sessions::router())
            .merge(routers::sftp::router())
            .merge(routers::vault::router())
            .layer(axum::middleware::from_fn_with_state(
                state.clone(),
                netrix_backend::auth::auth_middleware,
            ))
            .with_state(state.clone());

        (app, token, pool, state)
    }

    #[tokio::test]
    async fn application_lock_blocks_every_window_and_requires_password_reauthentication() {
        let (app, token, _, st) = setup_app_with_state().await;
        let correct = json!({"master_password":"App-lock-test-password"});
        let response = app
            .clone()
            .oneshot(json_request(
                "POST",
                "/vault/unlock",
                &token,
                Some(correct.clone()),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (ticket, _) = st
            .quick_connect_tickets
            .issue(json!({"hostname":"example.test"}), None)
            .await;
        let response = app
            .clone()
            .oneshot(json_request("POST", "/security/lock", &token, None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["locked"], true);
        assert!(!netrix_backend::vault::is_unlocked(&st.vault).await);
        assert!(st.quick_connect_tickets.consume(&ticket).await.is_none());

        // Any authenticated window sees the same lock; no vault/reset/policy bypass.
        for (method, path, body) in [
            ("GET", "/hosts", None),
            ("POST", "/vault/unlock", Some(correct.clone())),
            (
                "POST",
                "/vault/reset",
                Some(json!({"confirmation":"RESET VAULT"})),
            ),
            (
                "POST",
                "/security/policy",
                Some(json!({"app_timeout_seconds":null,"vault_timeout_seconds":null})),
            ),
            ("POST", "/security/activity", None),
        ] {
            let response = app
                .clone()
                .oneshot(json_request(method, path, &token, body))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::LOCKED, "{path}");
        }
        let response = app
            .clone()
            .oneshot(json_request("GET", "/security/status", "wrong-token", None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        let response = app
            .clone()
            .oneshot(json_request(
                "POST",
                "/security/unlock",
                &token,
                Some(json!({"master_password":"incorrect"})),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(st.security.is_locked());
        let response = app
            .clone()
            .oneshot(json_request("GET", "/security/status", &token, None))
            .await
            .unwrap();
        assert_eq!(body_json(response).await["locked"], true);

        let response = app
            .clone()
            .oneshot(json_request(
                "POST",
                "/security/unlock",
                &token,
                Some(correct),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["locked"], false);
        let response = app
            .oneshot(json_request("GET", "/hosts", &token, None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn application_unlock_shares_the_vault_password_rate_limit() {
        let (app, token, _, st) = setup_app_with_state().await;
        netrix_backend::vault::unlock(&st.vault, &st.db, "Rate-limit-test-password")
            .await
            .unwrap();
        st.security.lock_now(&st).await.unwrap();
        for _ in 0..5 {
            st.vault_unlock_limiter.record_failure().await;
        }
        let response = app
            .oneshot(json_request(
                "POST",
                "/security/unlock",
                &token,
                Some(json!({"master_password":"Rate-limit-test-password"})),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(st.security.is_locked());
        assert!(!netrix_backend::vault::is_unlocked(&st.vault).await);
    }

    #[tokio::test]
    async fn application_lock_requires_an_existing_master_password_and_valid_policy() {
        let (app, token, _, _) = setup_app_with_state().await;
        for path in ["/security/lock", "/security/unlock"] {
            let response = app
                .clone()
                .oneshot(json_request(
                    "POST",
                    path,
                    &token,
                    Some(json!({"master_password":"Cannot-set-password-on-lock-screen"})),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        for seconds in [0, 59, 3601] {
            let response = app
                .clone()
                .oneshot(json_request(
                    "POST",
                    "/security/policy",
                    &token,
                    Some(json!({"app_timeout_seconds":seconds,"vault_timeout_seconds":null})),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    fn json_request(method: &str, uri: &str, token: &str, body: Option<Value>) -> Request<Body> {
        let builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .header("X-API-Token", token);

        if let Some(b) = body {
            builder
                .body(Body::from(serde_json::to_string(&b).unwrap()))
                .unwrap()
        } else {
            builder.body(Body::empty()).unwrap()
        }
    }

    fn raw_request(method: &str, uri: &str, token: &str, body: &'static [u8]) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/octet-stream")
            .header("X-API-Token", token)
            .body(Body::from(body))
            .unwrap()
    }

    fn websocket_like_request(
        method: &str,
        uri: &str,
        api_token: Option<&str>,
        websocket_token: Option<&str>,
        body: Option<Value>,
    ) -> Request<Body> {
        let mut builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("connection", "upgrade")
            .header("upgrade", "websocket")
            .header("sec-websocket-version", "13")
            .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
            .header("content-type", "application/json");

        if let Some(token) = api_token {
            builder = builder.header("X-API-Token", token);
        }
        if let Some(token) = websocket_token {
            builder = builder.header(
                "sec-websocket-protocol",
                format!("netrix.v1, netrix-token.{token}"),
            );
        }

        let body = body
            .map(|value| Body::from(serde_json::to_string(&value).unwrap()))
            .unwrap_or_else(Body::empty);
        builder.body(body).unwrap()
    }

    async fn body_json(response: axum::http::Response<Body>) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn test_list_hosts_empty() {
        let (app, token, _) = setup_app().await;
        let req = json_request("GET", "/hosts", &token, None);
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert!(body.is_array());
        assert_eq!(body.as_array().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_health_requires_authentication() {
        let (app, token, _) = setup_app().await;

        let authenticated = json_request("GET", "/health", &token, None);
        let authenticated_response = app.clone().oneshot(authenticated).await.unwrap();
        assert_eq!(authenticated_response.status(), StatusCode::OK);
        assert_eq!(body_json(authenticated_response).await["status"], "ok");

        let unauthenticated = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let unauthenticated_response = app.oneshot(unauthenticated).await.unwrap();
        assert_eq!(unauthenticated_response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn test_create_host() {
        let (app, token, _) = setup_app().await;
        let host = json!({
            "name": "test-host",
            "hostname": "192.168.1.1",
            "port": 22,
            "username": "admin",
            "connection_type": "ssh"
        });
        let req = json_request("POST", "/hosts", &token, Some(host));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = body_json(resp).await;
        assert_eq!(body["name"], "test-host");
        assert_eq!(body["hostname"], "192.168.1.1");
        assert_eq!(body["has_password"], false);
    }

    #[tokio::test]
    async fn test_auth_middleware_rejects_invalid_token() {
        let (app, _, _) = setup_app().await;
        let req = json_request("GET", "/hosts", "wrong-token", None);
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn test_spoofed_websocket_upgrade_does_not_bypass_http_auth() {
        let (app, token, _) = setup_app().await;

        let requests = [
            websocket_like_request("GET", "/hosts", None, Some(&token), None),
            websocket_like_request("GET", "/hosts", Some("wrong-token"), None, None),
            websocket_like_request("GET", "/hosts", Some("wrong-token"), Some(&token), None),
            websocket_like_request("POST", "/hosts", None, Some(&token), Some(json!({}))),
            websocket_like_request("POST", "/hosts", Some("wrong-token"), None, Some(json!({}))),
            websocket_like_request(
                "POST",
                "/hosts",
                Some("wrong-token"),
                Some(&token),
                Some(json!({})),
            ),
        ];

        for request in requests {
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn test_http_token_remains_valid_with_spoofed_upgrade_header() {
        let (app, token, _) = setup_app().await;
        let request =
            websocket_like_request("GET", "/hosts", Some(&token), Some("wrong-token"), None);

        let response = app.oneshot(request).await.unwrap();

        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_websocket_missing_or_wrong_token_is_rejected_before_upgrade() {
        let (app, token, _) = setup_app().await;

        for (api_token, websocket_token) in [
            (None, None),
            (None, Some("wrong-token")),
            (Some(token.as_str()), None),
            (Some(token.as_str()), Some("wrong-token")),
        ] {
            let request = websocket_like_request(
                "GET",
                "/ws/quick-connect",
                api_token,
                websocket_token,
                None,
            );
            let response = app.clone().oneshot(request).await.unwrap();

            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
    }

    #[tokio::test]
    async fn test_valid_websocket_token_reaches_upgrade_extractor() {
        let (app, token, _) = setup_app().await;
        let request = websocket_like_request(
            "GET",
            "/ws/quick-connect",
            Some("wrong-token"),
            Some(&token),
            None,
        );

        // `oneshot` has no Hyper upgrade state, so Axum returns 426 after auth succeeds.
        // A forbidden response here would mean the valid WS subprotocol token was rejected.
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UPGRADE_REQUIRED);
    }

    #[tokio::test]
    async fn test_delete_session_returns_termination_status() {
        let (app, token, _) = setup_app().await;
        let req = json_request("DELETE", "/sessions/424242", &token, None);
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["ok"], true);
        assert_eq!(body["terminated"], false);
    }

    #[tokio::test]
    async fn test_quick_connect_ticket_does_not_echo_credentials() {
        let (app, token, _) = setup_app().await;
        let req = json_request(
            "POST",
            "/sessions/quick-connect-tickets",
            &token,
            Some(json!({
                "hostname": "192.168.1.10",
                "port": 22,
                "username": "admin",
                "password": "super-secret",
                "private_key": "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
                "passphrase": "secret-phrase",
                "type": "ssh"
            })),
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert!(body["ticket"].as_str().unwrap_or_default().len() >= 32);
        assert_eq!(body.get("password"), None);
        assert_eq!(body.get("private_key"), None);
        assert_eq!(body.get("key"), None);
        assert_eq!(body.get("passphrase"), None);
    }

    #[tokio::test]
    async fn test_create_host_invalid_port() {
        let (app, token, _) = setup_app().await;
        let host = json!({
            "name": "bad-host",
            "hostname": "10.0.0.1",
            "port": 99999,
            "connection_type": "ssh"
        });
        let req = json_request("POST", "/hosts", &token, Some(host));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_create_host_empty_name() {
        let (app, token, _) = setup_app().await;
        let host = json!({
            "name": "",
            "hostname": "10.0.0.1",
            "port": 22,
            "connection_type": "ssh"
        });
        let req = json_request("POST", "/hosts", &token, Some(host));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_create_host_invalid_connection_type() {
        let (app, token, _) = setup_app().await;
        let host = json!({
            "name": "bad-type",
            "hostname": "10.0.0.1",
            "port": 22,
            "connection_type": "ftp"
        });
        let req = json_request("POST", "/hosts", &token, Some(host));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_create_serial_host_allows_zero_port() {
        let (app, token, _) = setup_app().await;
        let host = json!({
            "name": "serial-host",
            "hostname": "localhost",
            "port": 0,
            "connection_type": "serial",
            "serial_port": "COM3",
            "serial_speed": 9600
        });
        let req = json_request("POST", "/hosts", &token, Some(host));
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::CREATED);
        let body = body_json(resp).await;
        assert_eq!(body["connection_type"], "serial");
        assert_eq!(body["port"], 0);
        assert_eq!(body["serial_port"], "COM3");
    }

    #[tokio::test]
    async fn test_sftp_capability_unknown_for_ssh_host() {
        let (app, token, pool) = setup_app().await;

        let host_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type) VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("sftp-unknown")
        .bind("10.10.20.10")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/capability"),
            &token,
            None,
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["capability"], "sftp");
        assert_eq!(body["status"], "unknown");
        assert_eq!(body["can_probe"], true);
    }

    #[tokio::test]
    async fn test_sftp_capability_unsupported_for_telnet_host() {
        let (app, token, pool) = setup_app().await;

        let host_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type) VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("telnet-no-sftp")
        .bind("10.10.20.11")
        .bind(23_i64)
        .bind("admin")
        .bind("telnet")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/capability"),
            &token,
            None,
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["capability"], "sftp");
        assert_eq!(body["status"], "unsupported");
        assert_eq!(body["can_probe"], false);
    }

    #[tokio::test]
    async fn test_sftp_file_operations_reject_non_ssh_hosts() {
        let (app, token, pool) = setup_app().await;

        let host_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type) VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("telnet-no-files")
        .bind("10.10.20.12")
        .bind(23_i64)
        .bind("admin")
        .bind("telnet")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let list_req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/list?path=."),
            &token,
            None,
        );
        let list_resp = app.clone().oneshot(list_req).await.unwrap();
        assert_eq!(list_resp.status(), StatusCode::BAD_REQUEST);

        let download_req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/download?path=file.txt"),
            &token,
            None,
        );
        let download_resp = app.clone().oneshot(download_req).await.unwrap();
        assert_eq!(download_resp.status(), StatusCode::BAD_REQUEST);

        let upload_req = raw_request(
            "POST",
            &format!("/sftp/hosts/{host_id}/upload?path=file.txt"),
            &token,
            b"hello",
        );
        let upload_resp = app.oneshot(upload_req).await.unwrap();
        assert_eq!(upload_resp.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_sftp_upload_and_download_validate_before_network_io() {
        let (app, token, pool) = setup_app().await;

        let host_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type) VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("ssh-files-validation")
        .bind("10.10.20.13")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let upload_req = raw_request(
            "POST",
            &format!("/sftp/hosts/{host_id}/upload?path=/tmp/"),
            &token,
            b"hello",
        );
        let upload_resp = app.clone().oneshot(upload_req).await.unwrap();
        assert_eq!(upload_resp.status(), StatusCode::BAD_REQUEST);
        let upload_body = body_json(upload_resp).await;
        assert_eq!(
            upload_body["detail"],
            "SFTP upload path must include a file name"
        );

        let download_req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/download?path=file.txt&max_bytes=0"),
            &token,
            None,
        );
        let download_resp = app.oneshot(download_req).await.unwrap();
        assert_eq!(download_resp.status(), StatusCode::BAD_REQUEST);
        let download_body = body_json(download_resp).await;
        assert_eq!(download_body["detail"], "Invalid SFTP read limit");
    }

    #[tokio::test]
    async fn test_sftp_transfer_jobs_validate_confirmations_and_cancel_without_io() {
        let (app, token, pool) = setup_app().await;
        let host: (i64,) = sqlx::query_as("INSERT INTO hosts (name, hostname, port, connection_type) VALUES ('jobs', '127.0.0.1', 1, 'ssh') RETURNING id")
            .fetch_one(&pool).await.unwrap();
        let uri = format!("/sftp/hosts/{}/transfers", host.0);
        for body in [
            json!({"kind":"upload","path":"/file","overwrite":true}),
            json!({"kind":"upload","path":"/file","bytes_total":134217729}),
            json!({"kind":"upload","path":"/folder/.."}),
            json!({"kind":"invalid","path":"/file"}),
        ] {
            let response = app
                .clone()
                .oneshot(json_request("POST", &uri, &token, Some(body)))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = app
            .clone()
            .oneshot(json_request(
                "POST",
                &uri,
                &token,
                Some(json!({"kind":"upload","path":"/file","bytes_total":3})),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let job = body_json(response).await;
        let id = job["id"].as_str().unwrap();
        assert_eq!(job["status"], "queued");
        let response = app
            .clone()
            .oneshot(json_request(
                "POST",
                &format!("/sftp/transfers/{id}/cancel"),
                &token,
                None,
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(body_json(response).await["status"], "cancelled");
        let response = app
            .oneshot(raw_request(
                "POST",
                &format!("/sftp/hosts/{}/upload?path=/file&transfer_id={id}", host.0),
                &token,
                b"abc",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn test_sftp_mutations_reject_invalid_and_unconfirmed_requests() {
        let (app, token, pool) = setup_app().await;
        let host: (i64,) = sqlx::query_as("INSERT INTO hosts (name, hostname, port, connection_type) VALUES ('mutations', '127.0.0.1', 1, 'ssh') RETURNING id")
            .fetch_one(&pool).await.unwrap();
        for body in [
            json!({"action":"delete","path":"/file"}),
            json!({"action":"delete","path":"/","confirmation":"/"}),
            json!({"action":"rename","path":"/file","destination":"/.."}),
            json!({"action":"chmod","path":"/file","permissions":"888"}),
            json!({"action":"chmod","path":"/file","permissions":"4755"}),
            json!({"action":"remove-recursive","path":"/folder"}),
        ] {
            let response = app
                .clone()
                .oneshot(json_request(
                    "POST",
                    &format!("/sftp/hosts/{}/operations", host.0),
                    &token,
                    Some(body),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
        let response = app
            .oneshot(json_request("GET", "/sftp/transfers", "wrong-token", None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn test_sftp_capability_ignores_expired_cache() {
        let (app, token, pool) = setup_app().await;

        let host_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type) VALUES (?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("sftp-expired-cache")
        .bind("10.10.20.14")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        sqlx::query(
            r#"INSERT INTO host_capabilities
               (host_id, capability, status, reason, checked_at, expires_at)
               VALUES (?, 'sftp', 'supported', NULL, datetime('now', '-13 hours'), datetime('now', '-1 hour'))"#,
        )
        .bind(host_id)
        .execute(&pool)
        .await
        .unwrap();

        let req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/capability"),
            &token,
            None,
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["capability"], "sftp");
        assert_eq!(body["status"], "unknown");
        assert_eq!(body["can_probe"], true);
    }

    #[tokio::test]
    async fn test_sftp_locked_vault_marks_capability_auth_failed() {
        let (app, token, pool) = setup_app().await;

        let credential_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("cred:sftp-locked")
        .bind(vec![1_u8, 2, 3])
        .bind(r#"{"type":"host_credentials"}"#)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let host_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type, credential_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("sftp-locked-vault")
        .bind("10.10.20.15")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(credential_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let list_req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/list?path=."),
            &token,
            None,
        );
        let list_resp = app.clone().oneshot(list_req).await.unwrap();
        assert_eq!(list_resp.status(), StatusCode::UNAUTHORIZED);
        let list_body = body_json(list_resp).await;
        assert_eq!(
            list_body["detail"],
            "Vault is locked. Unlock the vault, then reconnect."
        );

        let capability_req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/capability"),
            &token,
            None,
        );
        let capability_resp = app.oneshot(capability_req).await.unwrap();
        assert_eq!(capability_resp.status(), StatusCode::OK);
        let capability_body = body_json(capability_resp).await;
        assert_eq!(capability_body["status"], "auth_failed");
        assert_eq!(
            capability_body["reason"],
            "Vault is locked. Unlock the vault, then reconnect."
        );
    }

    #[tokio::test]
    async fn test_delete_host_cleans_orphan_credential() {
        let (app, token, pool) = setup_app().await;

        let credential_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("cred:orphan")
        .bind(vec![1_u8, 2, 3])
        .bind("{}")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let host_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type, credential_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("orphan-host")
        .bind("10.10.10.10")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(credential_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let req = json_request("DELETE", &format!("/hosts/{host_id}"), &token, None);
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let remaining =
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items WHERE id = ?")
                .bind(credential_id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .0;
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn test_delete_host_keeps_shared_credential() {
        let (app, token, pool) = setup_app().await;

        let credential_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("cred:shared")
        .bind(vec![4_u8, 5, 6])
        .bind("{}")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        let host1 = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO hosts (name, hostname, port, username, connection_type, credential_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
        )
        .bind("shared-host-1")
        .bind("10.10.10.11")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(credential_id)
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        sqlx::query(
            "INSERT INTO hosts (name, hostname, port, username, connection_type, credential_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("shared-host-2")
        .bind("10.10.10.12")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(credential_id)
        .execute(&pool)
        .await
        .unwrap();

        let req = json_request("DELETE", &format!("/hosts/{host1}"), &token, None);
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let remaining =
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items WHERE id = ?")
                .bind(credential_id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .0;
        assert_eq!(remaining, 1);
    }

    #[tokio::test]
    async fn test_update_host_can_clear_stored_credential() {
        let (app, token, pool) = setup_app().await;

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "ClearCreds123!" })),
        );
        let unlock_resp = app.clone().oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::OK);

        let host = json!({
            "name": "clear-creds-host",
            "hostname": "10.10.10.16",
            "port": 22,
            "username": "admin",
            "connection_type": "ssh",
            "password": "secret-password"
        });
        let create_req = json_request("POST", "/hosts", &token, Some(host));
        let create_resp = app.clone().oneshot(create_req).await.unwrap();
        assert_eq!(create_resp.status(), StatusCode::CREATED);
        let create_body = body_json(create_resp).await;
        let host_id = create_body["id"].as_i64().unwrap();
        let credential_id = create_body["credential_id"].as_i64().unwrap();
        assert_eq!(create_body["has_password"], true);

        let update = json!({
            "name": "clear-creds-host",
            "hostname": "10.10.10.16",
            "port": 22,
            "username": "admin",
            "connection_type": "ssh",
            "group": "Default",
            "clear_credentials": true
        });
        let update_req = json_request("PUT", &format!("/hosts/{host_id}"), &token, Some(update));
        let update_resp = app.oneshot(update_req).await.unwrap();
        assert_eq!(update_resp.status(), StatusCode::OK);
        let update_body = body_json(update_resp).await;
        assert_eq!(update_body["credential_id"], Value::Null);
        assert_eq!(update_body["has_password"], false);
        assert_eq!(update_body["has_private_key"], false);

        let remaining =
            sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items WHERE id = ?")
                .bind(credential_id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .0;
        assert_eq!(remaining, 0);
    }

    #[tokio::test]
    async fn test_reset_vault_requires_exact_confirmation() {
        let (app, token, pool) = setup_app().await;

        let credential_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("cred:keep")
        .bind(vec![7_u8, 8, 9])
        .bind("{}")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        sqlx::query(
            "INSERT INTO hosts (name, hostname, port, username, connection_type, credential_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("locked-host")
        .bind("10.10.10.13")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(credential_id)
        .execute(&pool)
        .await
        .unwrap();

        let req = json_request(
            "POST",
            "/vault/reset",
            &token,
            Some(json!({ "confirmation": "RESET" })),
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let item_count = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        assert_eq!(item_count, 1);

        let host_credential =
            sqlx::query_as::<_, (Option<i64>,)>("SELECT credential_id FROM hosts WHERE name = ?")
                .bind("locked-host")
                .fetch_one(&pool)
                .await
                .unwrap()
                .0;
        assert_eq!(host_credential, Some(credential_id));
    }

    #[tokio::test]
    async fn test_reset_vault_detaches_hosts_and_wipes_items() {
        let (app, token, pool) = setup_app().await;

        let credential_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("cred:wipe")
        .bind(vec![10_u8, 11, 12])
        .bind("{}")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        sqlx::query_as::<_, (i64,)>(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("__netrix_vault_check__")
        .bind(vec![13_u8, 14, 15])
        .bind("{\"type\":\"vault_check\"}")
        .fetch_one(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO hosts (name, hostname, port, username, connection_type, credential_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("wipe-host")
        .bind("10.10.10.14")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(credential_id)
        .execute(&pool)
        .await
        .unwrap();

        let req = json_request(
            "POST",
            "/vault/reset",
            &token,
            Some(json!({ "confirmation": "RESET VAULT" })),
        );
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["reset"], true);
        assert_eq!(body["detached_hosts"], 1);
        assert_eq!(body["deleted_items"], 2);

        let item_count = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items")
            .fetch_one(&pool)
            .await
            .unwrap()
            .0;
        assert_eq!(item_count, 0);

        let host_credential =
            sqlx::query_as::<_, (Option<i64>,)>("SELECT credential_id FROM hosts WHERE name = ?")
                .bind("wipe-host")
                .fetch_one(&pool)
                .await
                .unwrap()
                .0;
        assert_eq!(host_credential, None);
    }

    #[tokio::test]
    async fn test_vault_status_reports_counts() {
        let (app, token, pool) = setup_app().await;

        let credential_id = sqlx::query_as::<_, (i64,)>(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("cred:status")
        .bind(vec![21_u8, 22, 23])
        .bind("{}")
        .fetch_one(&pool)
        .await
        .unwrap()
        .0;

        sqlx::query("INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?)")
            .bind("__netrix_vault_check__")
            .bind(vec![24_u8, 25, 26])
            .bind("{\"type\":\"vault_check\"}")
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            "INSERT INTO hosts (name, hostname, port, username, connection_type, credential_id) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("status-host")
        .bind("10.10.10.15")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(credential_id)
        .execute(&pool)
        .await
        .unwrap();

        let req = json_request("GET", "/vault/status", &token, None);
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["unlocked"], false);
        assert_eq!(body["initialized"], true);
        assert_eq!(body["secret_items"], 1);
        assert_eq!(body["linked_hosts"], 1);
    }

    #[tokio::test]
    async fn test_clean_vault_reports_uninitialized_until_first_unlock() {
        let (app, token, _) = setup_app().await;

        let status_req = json_request("GET", "/vault/status", &token, None);
        let status_resp = app.clone().oneshot(status_req).await.unwrap();
        assert_eq!(status_resp.status(), StatusCode::OK);
        let status_body = body_json(status_resp).await;
        assert_eq!(status_body["initialized"], false);
        assert_eq!(status_body["secret_items"], 0);

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "FirstPass123!" })),
        );
        let unlock_resp = app.clone().oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::OK);
        let unlock_body = body_json(unlock_resp).await;
        assert_eq!(unlock_body["unlocked"], true);
        assert_eq!(unlock_body["initialized"], true);
        assert_eq!(unlock_body["bootstrapped"], true);

        let status_req = json_request("GET", "/vault/status", &token, None);
        let status_resp = app.oneshot(status_req).await.unwrap();
        assert_eq!(status_resp.status(), StatusCode::OK);
        let status_body = body_json(status_resp).await;
        assert_eq!(status_body["initialized"], true);
    }

    #[tokio::test]
    async fn test_first_unlock_rejects_short_master_password() {
        let (app, token, _) = setup_app().await;

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "short" })),
        );
        let unlock_resp = app.clone().oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::BAD_REQUEST);
        let unlock_body = body_json(unlock_resp).await;
        assert!(unlock_body["detail"]
            .as_str()
            .unwrap_or_default()
            .contains("at least 10 characters"));

        let status_req = json_request("GET", "/vault/status", &token, None);
        let status_resp = app.oneshot(status_req).await.unwrap();
        assert_eq!(status_resp.status(), StatusCode::OK);
        let status_body = body_json(status_resp).await;
        assert_eq!(status_body["initialized"], false);
        assert_eq!(status_body["unlocked"], false);
    }

    #[tokio::test]
    async fn test_vault_lock_blocks_secret_access_until_reunlock() {
        let (app, token, _, st) = setup_app_with_state().await;

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "LockCycle123!" })),
        );
        let unlock_resp = app.clone().oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::OK);
        let unlock_body = body_json(unlock_resp).await;
        assert_eq!(unlock_body["bootstrapped"], true);

        let create_req = json_request(
            "POST",
            "/vault/items",
            &token,
            Some(json!({
                "name": "cred:lock-cycle",
                "plaintext": "secret-after-lock",
                "metadata": { "type": "test" }
            })),
        );
        let create_resp = app.clone().oneshot(create_req).await.unwrap();
        assert_eq!(create_resp.status(), StatusCode::CREATED);
        let item_id = body_json(create_resp).await["id"].as_i64().unwrap();

        let lock_req = json_request("POST", "/vault/lock", &token, None);
        let lock_resp = app.clone().oneshot(lock_req).await.unwrap();
        assert_eq!(lock_resp.status(), StatusCode::OK);
        let lock_body = body_json(lock_resp).await;
        assert_eq!(lock_body["unlocked"], false);

        let locked_get_req = json_request("GET", &format!("/vault/items/{item_id}"), &token, None);
        let locked_get_resp = app.clone().oneshot(locked_get_req).await.unwrap();
        assert_eq!(locked_get_resp.status(), StatusCode::NOT_FOUND);
        assert!(matches!(
            netrix_backend::vault::retrieve_secret(&st.vault, &st.db, item_id).await,
            Err(netrix_backend::vault::VaultError::Locked)
        ));

        let locked_create_req = json_request(
            "POST",
            "/vault/items",
            &token,
            Some(json!({
                "name": "cred:blocked",
                "plaintext": "should-not-store",
                "metadata": { "type": "test" }
            })),
        );
        let locked_create_resp = app.clone().oneshot(locked_create_req).await.unwrap();
        assert_eq!(locked_create_resp.status(), StatusCode::UNAUTHORIZED);

        let reunlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "LockCycle123!" })),
        );
        let reunlock_resp = app.clone().oneshot(reunlock_req).await.unwrap();
        assert_eq!(reunlock_resp.status(), StatusCode::OK);
        let reunlock_body = body_json(reunlock_resp).await;
        assert_eq!(reunlock_body["bootstrapped"], false);

        let unlocked_get_req =
            json_request("GET", &format!("/vault/items/{item_id}"), &token, None);
        let unlocked_get_resp = app.oneshot(unlocked_get_req).await.unwrap();
        assert_eq!(unlocked_get_resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            netrix_backend::vault::retrieve_secret(&st.vault, &st.db, item_id)
                .await
                .unwrap(),
            b"secret-after-lock"
        );
    }

    #[tokio::test]
    async fn test_vault_unlock_rate_limits_repeated_invalid_passwords() {
        let (app, token, _) = setup_app().await;

        let bootstrap_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "CorrectPass123!" })),
        );
        let bootstrap_resp = app.clone().oneshot(bootstrap_req).await.unwrap();
        assert_eq!(bootstrap_resp.status(), StatusCode::OK);

        let lock_req = json_request("POST", "/vault/lock", &token, None);
        let lock_resp = app.clone().oneshot(lock_req).await.unwrap();
        assert_eq!(lock_resp.status(), StatusCode::OK);

        for _ in 0..5 {
            let bad_req = json_request(
                "POST",
                "/vault/unlock",
                &token,
                Some(json!({ "master_password": "WrongPass123!" })),
            );
            let bad_resp = app.clone().oneshot(bad_req).await.unwrap();
            assert_eq!(bad_resp.status(), StatusCode::UNAUTHORIZED);
        }

        let limited_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "CorrectPass123!" })),
        );
        let limited_resp = app.oneshot(limited_req).await.unwrap();
        assert_eq!(limited_resp.status(), StatusCode::TOO_MANY_REQUESTS);
        let limited_body = body_json(limited_resp).await;
        assert!(limited_body["detail"]
            .as_str()
            .unwrap()
            .contains("Too many failed vault unlock attempts"));
    }

    #[tokio::test]
    async fn test_saved_host_credential_survives_lock_unlock_without_plaintext_leak() {
        let (app, token, pool, st) = setup_app_with_state().await;

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "HostCreds123!" })),
        );
        let unlock_resp = app.clone().oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::OK);

        let host = json!({
            "name": "vault-backed-host",
            "hostname": "10.10.10.30",
            "port": 22,
            "username": "admin",
            "connection_type": "ssh",
            "password": "host-secret-password",
            "private_key": "-----BEGIN PRIVATE KEY-----\nhost-secret-key\n-----END PRIVATE KEY-----",
            "passphrase": "host-secret-passphrase"
        });
        let create_req = json_request("POST", "/hosts", &token, Some(host));
        let create_resp = app.clone().oneshot(create_req).await.unwrap();
        assert_eq!(create_resp.status(), StatusCode::CREATED);
        let create_body = body_json(create_resp).await;
        let host_id = create_body["id"].as_i64().unwrap();
        let credential_id = create_body["credential_id"].as_i64().unwrap();
        assert_eq!(create_body["has_password"], true);
        assert_eq!(create_body["has_private_key"], true);
        assert_eq!(create_body.get("password"), None);
        assert_eq!(create_body.get("private_key"), None);
        assert_eq!(create_body.get("passphrase"), None);

        let stored_host = sqlx::query_as::<_, (Option<String>, Option<String>)>(
            "SELECT password, private_key FROM hosts WHERE id = ?",
        )
        .bind(host_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored_host, (None, None));

        let ciphertext =
            sqlx::query_as::<_, (Vec<u8>,)>("SELECT ciphertext FROM vault_items WHERE id = ?")
                .bind(credential_id)
                .fetch_one(&pool)
                .await
                .unwrap()
                .0;
        let ciphertext_text = String::from_utf8_lossy(&ciphertext);
        assert!(!ciphertext_text.contains("host-secret-password"));
        assert!(!ciphertext_text.contains("host-secret-key"));
        assert!(!ciphertext_text.contains("host-secret-passphrase"));

        let list_req = json_request("GET", "/hosts", &token, None);
        let list_resp = app.clone().oneshot(list_req).await.unwrap();
        assert_eq!(list_resp.status(), StatusCode::OK);
        let list_body = body_json(list_resp).await;
        let listed_host = &list_body.as_array().unwrap()[0];
        assert_eq!(listed_host["credential_id"], credential_id);
        assert_eq!(listed_host["has_password"], true);
        assert_eq!(listed_host["has_private_key"], true);
        assert_eq!(listed_host.get("password"), None);
        assert_eq!(listed_host.get("private_key"), None);

        let lock_req = json_request("POST", "/vault/lock", &token, None);
        let lock_resp = app.clone().oneshot(lock_req).await.unwrap();
        assert_eq!(lock_resp.status(), StatusCode::OK);

        let locked_get_req = json_request(
            "GET",
            &format!("/vault/items/{credential_id}"),
            &token,
            None,
        );
        let locked_get_resp = app.clone().oneshot(locked_get_req).await.unwrap();
        assert_eq!(locked_get_resp.status(), StatusCode::NOT_FOUND);

        let reunlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "HostCreds123!" })),
        );
        let reunlock_resp = app.clone().oneshot(reunlock_req).await.unwrap();
        assert_eq!(reunlock_resp.status(), StatusCode::OK);

        let get_secret_req = json_request(
            "GET",
            &format!("/vault/items/{credential_id}"),
            &token,
            None,
        );
        let get_secret_resp = app.oneshot(get_secret_req).await.unwrap();
        assert_eq!(get_secret_resp.status(), StatusCode::NOT_FOUND);
        let credential_payload: Value = serde_json::from_slice(
            &netrix_backend::vault::retrieve_secret(&st.vault, &st.db, credential_id)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(credential_payload["password"], "host-secret-password");
        assert_eq!(
            credential_payload["private_key"],
            "-----BEGIN PRIVATE KEY-----\nhost-secret-key\n-----END PRIVATE KEY-----"
        );
        assert_eq!(credential_payload["passphrase"], "host-secret-passphrase");
    }

    #[tokio::test]
    async fn test_change_vault_password_reencrypts_secrets() {
        let (app, token, _, st) = setup_app_with_state().await;

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "OldPass123!" })),
        );
        let unlock_resp = app.clone().oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::OK);

        let create_req = json_request(
            "POST",
            "/vault/items",
            &token,
            Some(
                json!({ "name": "cred:rotate", "plaintext": "super-secret", "metadata": { "type": "test" } }),
            ),
        );
        let create_resp = app.clone().oneshot(create_req).await.unwrap();
        assert_eq!(create_resp.status(), StatusCode::CREATED);
        let create_body = body_json(create_resp).await;
        let item_id = create_body["id"].as_i64().unwrap();

        let change_req = json_request(
            "POST",
            "/vault/change-password",
            &token,
            Some(json!({ "current_password": "OldPass123!", "new_password": "NewPass456!" })),
        );
        let change_resp = app.clone().oneshot(change_req).await.unwrap();
        assert_eq!(change_resp.status(), StatusCode::OK);
        let change_body = body_json(change_resp).await;
        assert_eq!(change_body["changed"], true);
        assert_eq!(change_body["unlocked"], true);

        let lock_req = json_request("POST", "/vault/lock", &token, None);
        let lock_resp = app.clone().oneshot(lock_req).await.unwrap();
        assert_eq!(lock_resp.status(), StatusCode::OK);

        let old_unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "OldPass123!" })),
        );
        let old_unlock_resp = app.clone().oneshot(old_unlock_req).await.unwrap();
        assert_eq!(old_unlock_resp.status(), StatusCode::UNAUTHORIZED);

        let new_unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "NewPass456!" })),
        );
        let new_unlock_resp = app.clone().oneshot(new_unlock_req).await.unwrap();
        assert_eq!(new_unlock_resp.status(), StatusCode::OK);

        let get_req = json_request("GET", &format!("/vault/items/{item_id}"), &token, None);
        let get_resp = app.oneshot(get_req).await.unwrap();
        assert_eq!(get_resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            netrix_backend::vault::retrieve_secret(&st.vault, &st.db, item_id)
                .await
                .unwrap(),
            b"super-secret"
        );
    }

    #[tokio::test]
    async fn test_unlock_atomically_migrates_legacy_plaintext_credentials() {
        use netrix_backend::vault;

        let (app, token, pool, st) = setup_app_with_state().await;
        let master_password = "LegacyMigration123!";
        let key = vault::derive_key(master_password).unwrap();

        let check_ciphertext = vault::encrypt(b"netrix-vault-check-v1", &key).unwrap();
        sqlx::query("INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?)")
            .bind("__netrix_vault_check__")
            .bind(check_ciphertext)
            .bind(r#"{"type":"vault_check"}"#)
            .execute(&pool)
            .await
            .unwrap();

        let valid_payload = json!({
            "password": "encrypted-authoritative",
            "private_key": null,
            "passphrase": "encrypted-passphrase",
        });
        let valid_ciphertext = vault::encrypt(valid_payload.to_string().as_bytes(), &key).unwrap();
        let (valid_credential_id,): (i64,) = sqlx::query_as(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("host:already-linked")
        .bind(valid_ciphertext)
        .bind(r#"{"type":"host_credentials"}"#)
        .fetch_one(&pool)
        .await
        .unwrap();

        let (broken_credential_id,): (i64,) = sqlx::query_as(
            "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
        )
        .bind("host:broken-link")
        .bind(vec![1_u8, 2, 3])
        .bind(r#"{"type":"host_credentials"}"#)
        .fetch_one(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT INTO hosts
               (name, hostname, port, username, connection_type, password, private_key)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind("legacy-only")
        .bind("legacy-only.example")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind("legacy-password")
        .bind("legacy-private-key")
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT INTO hosts
               (name, hostname, port, username, connection_type, credential_id, password, private_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind("already-linked")
        .bind("already-linked.example")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(valid_credential_id)
        .bind("redundant-password")
        .bind("redundant-private-key")
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            r#"INSERT INTO hosts
               (name, hostname, port, username, connection_type, credential_id, password, private_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind("broken-link")
        .bind("broken-link.example")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(broken_credential_id)
        .bind("recoverable-password")
        .bind("recoverable-private-key")
        .execute(&pool)
        .await
        .unwrap();

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": master_password })),
        );
        let unlock_resp = app.clone().oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::OK);
        let unlock_body = body_json(unlock_resp).await;
        assert_eq!(unlock_body["migrated_legacy_hosts"], 3);
        assert_eq!(unlock_body["preserved_existing_credential_links"], 1);

        let legacy_row: (Option<i64>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT credential_id, password, private_key FROM hosts WHERE name = ?")
                .bind("legacy-only")
                .fetch_one(&pool)
                .await
                .unwrap();
        let legacy_credential_id = legacy_row.0.expect("legacy credential should be linked");
        assert_eq!(legacy_row.1, None);
        assert_eq!(legacy_row.2, None);

        let linked_row: (Option<i64>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT credential_id, password, private_key FROM hosts WHERE name = ?")
                .bind("already-linked")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(linked_row.0, Some(valid_credential_id));
        assert_eq!(linked_row.1, None);
        assert_eq!(linked_row.2, None);

        let linked_get_req = json_request(
            "GET",
            &format!("/vault/items/{valid_credential_id}"),
            &token,
            None,
        );
        let linked_get_resp = app.clone().oneshot(linked_get_req).await.unwrap();
        assert_eq!(linked_get_resp.status(), StatusCode::NOT_FOUND);
        let linked_payload: Value = serde_json::from_slice(
            &vault::retrieve_secret(&st.vault, &st.db, valid_credential_id)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(linked_payload["password"], "encrypted-authoritative");
        assert_eq!(linked_payload["passphrase"], "encrypted-passphrase");
        assert_eq!(
            linked_payload["_netrix_legacy_plaintext_backup"]["password"],
            "redundant-password"
        );
        assert_eq!(
            linked_payload["_netrix_legacy_plaintext_backup"]["private_key"],
            "redundant-private-key"
        );

        let repaired_row: (Option<i64>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT credential_id, password, private_key FROM hosts WHERE name = ?")
                .bind("broken-link")
                .fetch_one(&pool)
                .await
                .unwrap();
        let repaired_credential_id = repaired_row.0.expect("broken link should be replaced");
        assert_ne!(repaired_credential_id, broken_credential_id);
        assert_eq!(repaired_row.1, None);
        assert_eq!(repaired_row.2, None);

        let old_broken_item_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM vault_items WHERE id = ?")
                .bind(broken_credential_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(old_broken_item_count.0, 1, "old vault data is retained");

        for (credential_id, expected_password, expected_private_key) in [
            (
                legacy_credential_id,
                "legacy-password",
                "legacy-private-key",
            ),
            (
                repaired_credential_id,
                "recoverable-password",
                "recoverable-private-key",
            ),
        ] {
            let get_req = json_request(
                "GET",
                &format!("/vault/items/{credential_id}"),
                &token,
                None,
            );
            let get_resp = app.clone().oneshot(get_req).await.unwrap();
            assert_eq!(get_resp.status(), StatusCode::NOT_FOUND);
            let payload: Value = serde_json::from_slice(
                &vault::retrieve_secret(&st.vault, &st.db, credential_id)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(payload["password"], expected_password);
            assert_eq!(payload["private_key"], expected_private_key);
            assert_eq!(payload["passphrase"], Value::Null);
        }
    }

    #[tokio::test]
    async fn test_first_unlock_bootstraps_vault_and_migrates_legacy_credentials() {
        let (app, token, pool) = setup_app().await;
        sqlx::query(
            r#"INSERT INTO hosts
               (name, hostname, port, username, connection_type, password)
               VALUES (?, ?, ?, ?, ?, ?)"#,
        )
        .bind("legacy-first-unlock")
        .bind("legacy-first-unlock.example")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind("first-unlock-password")
        .execute(&pool)
        .await
        .unwrap();

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "FirstLegacyPass123!" })),
        );
        let unlock_resp = app.oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::OK);
        let unlock_body = body_json(unlock_resp).await;
        assert_eq!(unlock_body["bootstrapped"], true);
        assert_eq!(unlock_body["migrated_legacy_hosts"], 1);

        let row: (Option<i64>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT credential_id, password, private_key FROM hosts WHERE name = ?")
                .bind("legacy-first-unlock")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(row.0.is_some());
        assert_eq!(row.1, None);
        assert_eq!(row.2, None);

        let item_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM vault_items")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(item_count.0, 2, "check item plus migrated credential");
    }

    #[tokio::test]
    async fn test_failed_unlock_keeps_legacy_plaintext_unchanged() {
        use netrix_backend::vault;

        let (app, token, pool) = setup_app().await;
        let key = vault::derive_key("CorrectLegacyPass123!").unwrap();
        let check_ciphertext = vault::encrypt(b"netrix-vault-check-v1", &key).unwrap();
        sqlx::query("INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?)")
            .bind("__netrix_vault_check__")
            .bind(check_ciphertext)
            .bind(r#"{"type":"vault_check"}"#)
            .execute(&pool)
            .await
            .unwrap();

        sqlx::query(
            r#"INSERT INTO hosts
               (name, hostname, port, username, connection_type, password, private_key)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind("legacy-preserved")
        .bind("legacy-preserved.example")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind("do-not-lose-password")
        .bind("do-not-lose-private-key")
        .execute(&pool)
        .await
        .unwrap();

        let unlock_req = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "WrongLegacyPass123!" })),
        );
        let unlock_resp = app.oneshot(unlock_req).await.unwrap();
        assert_eq!(unlock_resp.status(), StatusCode::UNAUTHORIZED);

        let row: (Option<i64>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT credential_id, password, private_key FROM hosts WHERE name = ?")
                .bind("legacy-preserved")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row.0, None);
        assert_eq!(row.1.as_deref(), Some("do-not-lose-password"));
        assert_eq!(row.2.as_deref(), Some("do-not-lose-private-key"));

        let item_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM vault_items")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(item_count.0, 1);
    }

    #[tokio::test]
    async fn test_locked_host_updates_preserve_legacy_credentials_and_reject_new_secrets() {
        let (app, token, pool) = setup_app().await;
        let (host_id,): (i64,) = sqlx::query_as(
            r#"INSERT INTO hosts
               (name, hostname, port, username, connection_type, password, private_key)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               RETURNING id"#,
        )
        .bind("legacy-update")
        .bind("before.example")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind("preserved-password")
        .bind("preserved-private-key")
        .fetch_one(&pool)
        .await
        .unwrap();

        let metadata_update = json_request(
            "PUT",
            &format!("/hosts/{host_id}"),
            &token,
            Some(json!({
                "name": "legacy-update",
                "hostname": "after.example",
                "port": 22,
                "username": "admin",
                "connection_type": "ssh"
            })),
        );
        let metadata_response = app.clone().oneshot(metadata_update).await.unwrap();
        assert_eq!(metadata_response.status(), StatusCode::OK);

        let rejected_secret_update = json_request(
            "PUT",
            &format!("/hosts/{host_id}"),
            &token,
            Some(json!({
                "name": "legacy-update",
                "hostname": "must-not-apply.example",
                "port": 22,
                "username": "admin",
                "connection_type": "ssh",
                "password": "new-secret"
            })),
        );
        let rejected_response = app.clone().oneshot(rejected_secret_update).await.unwrap();
        assert_eq!(rejected_response.status(), StatusCode::UNAUTHORIZED);

        let row: (String, Option<i64>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT hostname, credential_id, password, private_key FROM hosts WHERE id = ?",
        )
        .bind(host_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.0, "after.example");
        assert_eq!(row.1, None);
        assert_eq!(row.2.as_deref(), Some("preserved-password"));
        assert_eq!(row.3.as_deref(), Some("preserved-private-key"));

        let sftp_req = json_request(
            "GET",
            &format!("/sftp/hosts/{host_id}/list?path=."),
            &token,
            None,
        );
        let sftp_resp = app.oneshot(sftp_req).await.unwrap();
        assert_eq!(sftp_resp.status(), StatusCode::UNAUTHORIZED);
        let sftp_body = body_json(sftp_resp).await;
        assert!(sftp_body["detail"]
            .as_str()
            .unwrap()
            .contains("migrate this host's legacy credentials"));
    }

    #[tokio::test]
    async fn test_failed_host_create_rolls_back_new_vault_item() {
        let (app, token, pool) = setup_app().await;

        let unlock = json_request(
            "POST",
            "/vault/unlock",
            &token,
            Some(json!({ "master_password": "transaction-test-password" })),
        );
        assert_eq!(
            app.clone().oneshot(unlock).await.unwrap().status(),
            StatusCode::OK
        );

        let first_host = json_request(
            "POST",
            "/hosts",
            &token,
            Some(json!({
                "name": "transaction-host",
                "hostname": "first.example",
                "port": 22,
                "username": "admin",
                "connection_type": "ssh"
            })),
        );
        assert_eq!(
            app.clone().oneshot(first_host).await.unwrap().status(),
            StatusCode::CREATED
        );

        let before_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM vault_items")
            .fetch_one(&pool)
            .await
            .unwrap();
        let duplicate_with_secret = json_request(
            "POST",
            "/hosts",
            &token,
            Some(json!({
                "name": "transaction-host",
                "hostname": "duplicate.example",
                "port": 22,
                "username": "admin",
                "connection_type": "ssh",
                "password": "must-roll-back"
            })),
        );
        let response = app.oneshot(duplicate_with_secret).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);

        let after_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM vault_items")
            .fetch_one(&pool)
            .await
            .unwrap();
        let leaked_items: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM vault_items WHERE name = 'host:transaction-host'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let host_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM hosts WHERE name = 'transaction-host'")
                .fetch_one(&pool)
                .await
                .unwrap();

        assert_eq!(after_count, before_count);
        assert_eq!(leaked_items.0, 0);
        assert_eq!(host_count.0, 1);
    }
}
