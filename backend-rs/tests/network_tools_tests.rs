mod common;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use netrix_backend::{
    auth::{AppState, QuickConnectTicketStore, VaultUnlockLimiter},
    routers,
    ssh::{SessionManager, SftpManager},
    vault,
};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn app() -> Router {
    common::init();
    let state = AppState {
        database_encryption: None,
        security: netrix_backend::security::AppSecurity::default(),
        db: sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap(),
        vault: vault::new_vault(),
        api_token: "network-tool-test-token".into(),
        sessions: SessionManager::new(),
        sftp: SftpManager::new(),
        quick_connect_tickets: QuickConnectTicketStore::new(),
        vault_unlock_limiter: VaultUnlockLimiter::new(),
    };
    routers::network_tools::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            netrix_backend::auth::auth_middleware,
        ))
        .with_state(state)
}
async fn call(app: &Router, path: &str, token: &str, body: Value) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .header("X-API-Token", token)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn tools_require_auth_and_reject_invalid_targets_without_dialing() {
    let app = app().await;
    for path in ["/network-tools/scan/tcp", "/network-tools/tls/inspect"] {
        assert_eq!(
            call(&app, path, "incorrect", json!({"target":"127.0.0.1"}))
                .await
                .0,
            StatusCode::FORBIDDEN
        );
        let (status, error) = call(
            &app,
            path,
            "network-tool-test-token",
            json!({"target":"http://127.0.0.1"}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["detail"]
            .as_str()
            .unwrap()
            .contains("invalid characters"));
    }
}

#[tokio::test]
async fn malformed_requests_do_not_exhaust_scan_rate_limit() {
    let app = app().await;
    for _ in 0..6 {
        assert_eq!(
            call(
                &app,
                "/network-tools/scan/tcp",
                "network-tool-test-token",
                json!({"target":"127.0.0.1","ports":"1-65535"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let bound = tokio::net::TcpSocket::new_v4().unwrap();
    bound.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let body = json!({"target":"127.0.0.1","ports":bound.local_addr().unwrap().port().to_string(),"timeout_ms":50});
    for _ in 0..5 {
        let (status, result) = call(
            &app,
            "/network-tools/scan/tcp",
            "network-tool-test-token",
            body.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(result["scanned_ports"], 1);
    }
    assert_eq!(
        call(
            &app,
            "/network-tools/scan/tcp",
            "network-tool-test-token",
            body
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}
