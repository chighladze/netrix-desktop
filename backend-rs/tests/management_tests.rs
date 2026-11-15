//! Isolated API tests for credentials, import and portable encrypted backups.
mod common;
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use netrix_backend::{auth, routers, ssh, vault};
use serde_json::{json, Value};
use tower::ServiceExt;
async fn setup() -> (Router, auth::AppState) {
    common::init();
    let db = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&db)
        .await
        .unwrap();
    for schema in [
        include_str!("../migrations/001_initial_schema.sql"),
        include_str!("../migrations/002_add_group_index.sql"),
        include_str!("../migrations/003_add_host_capabilities.sql"),
        include_str!("../migrations/004_add_local_shell_fields.sql"),
        include_str!("../migrations/005_ssh_tunnels.sql"),
        include_str!("../migrations/006_host_revisions.sql"),
        include_str!("../migrations/007_terminal_colors.sql"),
        include_str!("../migrations/008_terminal_appearance.sql"),
    ] {
        sqlx::raw_sql(schema).execute(&db).await.unwrap();
    }
    let state = auth::AppState {
        database_encryption: None,
        security: netrix_backend::security::AppSecurity::default(),
        db,
        vault: vault::new_vault(),
        api_token: "management-test-token".into(),
        sessions: ssh::SessionManager::new(),
        sftp: ssh::SftpManager::new(),
        quick_connect_tickets: auth::QuickConnectTicketStore::new(),
        vault_unlock_limiter: auth::VaultUnlockLimiter::new(),
    };
    let app = Router::new()
        .merge(routers::hosts::router())
        .merge(routers::vault::router())
        .merge(routers::credentials::router())
        .merge(routers::backups::router())
        .merge(routers::ssh_config::router())
        .merge(routers::tunnels::router())
        .merge(routers::local_files::router())
        .merge(routers::sftp::router())
        .merge(routers::snippets::router())
        .merge(routers::recent_connections::router())
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::workspace_middleware,
        ))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state.clone());
    (app, state)
}
async fn call(app: &Router, method: &str, path: &str, body: Value) -> (StatusCode, Value) {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("X-API-Token", "management-test-token")
        .header("Content-Type", "application/json")
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 32 * 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        },
    )
}

async fn folder_host(app: &Router, name: &str, group: &str) -> Value {
    let (status, host) = call(
        app,
        "POST",
        "/hosts",
        json!({"name":name,"hostname":"example.test","group":group}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    host
}

#[tokio::test]
async fn host_folder_move_is_atomic_and_preserves_host_identity() {
    let (app, state) = setup().await;
    let first = folder_host(&app, "database", " / Ops_50% // DB / ").await;
    let second = folder_host(&app, "web", "Ops_50%/Web").await;
    let unrelated = folder_host(&app, "other", "Ops_50%extra").await;
    // Cover legacy, noncanonical rows too; SQL wildcard characters are literal.
    sqlx::query("UPDATE hosts SET \"group\" = ? WHERE id = ?")
        .bind(" / Ops_50% // DB / ")
        .bind(first["id"].as_i64().unwrap())
        .execute(&state.db)
        .await
        .unwrap();
    let (_, first) = call(&app, "GET", &format!("/hosts/{}", first["id"]), Value::Null).await;
    let (status, moved) = call(&app, "POST", "/host-groups/move", json!({
        "source":"Ops_50%", "destination":"Production/თბილისი",
        "hosts":[{"id":first["id"],"revision":first["revision"]},{"id":second["id"],"revision":second["revision"]}]
    })).await;
    assert_eq!(status, StatusCode::OK, "{moved}");
    assert_eq!(moved.as_array().unwrap().len(), 2);
    for host in moved.as_array().unwrap() {
        let previous = if host["id"] == first["id"] {
            &first
        } else {
            &second
        };
        assert_eq!(host["name"], previous["name"]);
        assert_eq!(host["hostname"], previous["hostname"]);
        assert_eq!(host["credential_id"], previous["credential_id"]);
        assert!(host["revision"].as_i64().unwrap() > previous["revision"].as_i64().unwrap());
        assert!(host["group"]
            .as_str()
            .unwrap()
            .starts_with("Production/თბილისი/"));
        assert!(host.get("password").is_none());
        assert!(host.get("private_key").is_none());
    }
    let (_, unchanged) = call(
        &app,
        "GET",
        &format!("/hosts/{}", unrelated["id"]),
        Value::Null,
    )
    .await;
    assert_eq!(unchanged, unrelated);
}

#[tokio::test]
async fn host_folder_move_rejects_stale_membership_revisions_and_collisions() {
    let (app, _) = setup().await;
    let first = folder_host(&app, "one", "Prod/DB").await;
    let second = folder_host(&app, "two", "Prod/Web").await;
    folder_host(&app, "destination", "Existing/Child").await;
    let members = json!([{"id":first["id"],"revision":first["revision"]},{"id":second["id"],"revision":second["revision"]}]);
    for (destination, status) in [
        ("Existing", StatusCode::CONFLICT),
        ("Prod/Child", StatusCode::BAD_REQUEST),
        ("../Bad", StatusCode::BAD_REQUEST),
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                "/host-groups/move",
                json!({"source":"Prod","destination":destination,"hosts":members})
            )
            .await
            .0,
            status
        );
    }
    for revisions in [
        json!([]),
        json!([{"id":first["id"],"revision":first["revision"]}]),
        json!([{"id":first["id"],"revision":0},{"id":second["id"],"revision":second["revision"]}]),
    ] {
        assert_eq!(
            call(
                &app,
                "POST",
                "/host-groups/move",
                json!({"source":"Prod","destination":"Live","hosts":revisions})
            )
            .await
            .0,
            StatusCode::CONFLICT
        );
    }
    let (_, unchanged) = call(&app, "GET", &format!("/hosts/{}", first["id"]), Value::Null).await;
    assert_eq!(unchanged, first);
    let (_, unchanged) = call(
        &app,
        "GET",
        &format!("/hosts/{}", second["id"]),
        Value::Null,
    )
    .await;
    assert_eq!(unchanged, second);
}

#[tokio::test]
async fn host_folder_move_validates_all_descendants_before_writing_and_authenticates() {
    let (app, state) = setup().await;
    let first = folder_host(&app, "parent", "Prod").await;
    let second = folder_host(&app, "child", "Prod/Child").await;
    let body = json!({"source":"Prod","destination":"x".repeat(99),"hosts":[{"id":first["id"],"revision":first["revision"]},{"id":second["id"],"revision":second["revision"]}]});
    assert_eq!(
        call(&app, "POST", "/host-groups/move", body.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (_, unchanged) = call(&app, "GET", &format!("/hosts/{}", first["id"]), Value::Null).await;
    assert_eq!(unchanged, first);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/host-groups/move")
                .header("Content-Type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        call(
            &app,
            "POST",
            "/host-groups/move",
            json!({"source":"Empty","destination":"Prod","hosts":[]})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &app,
            "POST",
            "/host-groups/move",
            json!({"source":"Empty","destination":"Renamed empty","hosts":[]})
        )
        .await,
        (StatusCode::OK, json!([]))
    );
    unlock(&app, "folder-test-password").await;
    state.security.lock_now(&state).await.unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            "/host-groups/move",
            json!({"source":"Empty","destination":"After lock","hosts":[]})
        )
        .await
        .0,
        StatusCode::LOCKED
    );
}
async fn unlock(app: &Router, password: &str) {
    assert_eq!(
        call(
            app,
            "POST",
            "/vault/unlock",
            json!({"master_password":password})
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn host_terminal_colors_persist_validate_and_reset_independently() {
    let (app, _) = setup().await;
    let (status, host) = call(
        &app,
        "POST",
        "/hosts",
        json!({
            "name":"colored-host", "hostname":"example.test", "terminal_theme":"nord",
            "terminal_background":"#112233", "terminal_foreground":"#aabbcc"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{host}");
    let path = format!("/hosts/{}", host["id"]);
    let (_, loaded) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(loaded["terminal_background"], "#112233");
    assert_eq!(loaded["terminal_foreground"], "#aabbcc");
    let (status, changed) = call(
        &app,
        "PATCH",
        &path,
        json!({
            "revision":loaded["revision"], "terminal_foreground":"#ffffff"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{changed}");
    assert_eq!(changed["terminal_background"], "#112233");
    assert_eq!(changed["terminal_foreground"], "#ffffff");
    for field in ["terminal_background", "terminal_foreground"] {
        for invalid in ["", "#fff", "#gggggg", "red", "rgb(0,0,0)", "#00000000"] {
            let mut patch = json!({"revision":changed["revision"]});
            patch[field] = json!(invalid);
            assert_eq!(
                call(&app, "PATCH", &path, patch).await.0,
                StatusCode::BAD_REQUEST
            );
        }
    }
    let (_, unchanged) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(unchanged["revision"], changed["revision"]);
    let (status, reset) = call(
        &app,
        "PATCH",
        &path,
        json!({
            "revision":changed["revision"], "terminal_background":null
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reset["terminal_background"], Value::Null);
    assert_eq!(reset["terminal_foreground"], "#ffffff");
    let (_, listed) = call(&app, "GET", "/hosts", Value::Null).await;
    assert_eq!(listed[0]["terminal_foreground"], "#ffffff");
}

#[tokio::test]
async fn host_terminal_appearance_persists_validates_and_resets() {
    let (app, _) = setup().await;
    let mut appearance = json!({"font_family":"Consolas","font_weight":500,"font_weight_bold":800,
        "line_height":1.4,"letter_spacing":0.2,"cursor_style":"bar","cursor_blink":false,
        "bold_bright":false,"colors":{"green":"#aabbcc","cyan":"#112233","cursor":"#ffffff","selectionBackground":"#4488aa"}});
    for (index, key) in [
        "black",
        "red",
        "green",
        "yellow",
        "blue",
        "magenta",
        "cyan",
        "white",
        "brightBlack",
        "brightRed",
        "brightGreen",
        "brightYellow",
        "brightBlue",
        "brightMagenta",
        "brightCyan",
        "brightWhite",
    ]
    .iter()
    .enumerate()
    {
        appearance["colors"][*key] = json!(format!("#{:06x}", 0x223344 + index * 0x030303));
    }
    let (status, host) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"formatted","hostname":"example.test","terminal_appearance":appearance}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{host}");
    assert_eq!(host["terminal_appearance"], appearance);
    let path = format!("/hosts/{}", host["id"]);
    let (_, listed) = call(&app, "GET", "/hosts", Value::Null).await;
    assert_eq!(listed[0]["terminal_appearance"], appearance);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/recent-connections/{}", host["id"]),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, recent) = call(&app, "GET", "/recent-connections", Value::Null).await;
    assert_eq!(recent[0]["host"]["terminal_appearance"], appearance);
    let (_, changed) = call(
        &app,
        "PATCH",
        &path,
        json!({"revision":host["revision"],"terminal_foreground":"#abcdef"}),
    )
    .await;
    assert_eq!(changed["terminal_appearance"], appearance);
    for invalid in [
        json!({"font_family":""}),
        json!({"font_family":"bad\nfont"}),
        json!({"font_family":"bad\u{0085}font"}),
        json!({"font_family":"Ш".repeat(129)}),
        json!({"font_weight":450}),
        json!({"line_height":0.5}),
        json!({"letter_spacing":10}),
        json!({"cursor_style":"circle"}),
        json!({"colors":{"unknown":"#ffffff"}}),
        json!({"colors":{"green":"not-a-color"}}),
    ] {
        assert_eq!(
            call(
                &app,
                "PATCH",
                &path,
                json!({"revision":changed["revision"],"terminal_appearance":invalid})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    let (_, loaded) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(loaded["terminal_appearance"], appearance);
    assert_eq!(loaded["revision"], changed["revision"]);
    let (status, reset) = call(
        &app,
        "PATCH",
        &path,
        json!({"revision":changed["revision"],"terminal_appearance":null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reset["terminal_appearance"], Value::Null);
    assert_eq!(reset["terminal_foreground"], "#abcdef");
    // HTML maxlength and frontend string.length use UTF-16 code units, not UTF-8 bytes.
    let boundary = json!({"font_family":"Ш".repeat(128),"font_weight":100,"font_weight_bold":900,
        "line_height":1.0,"letter_spacing":-1.0,"cursor_style":"underline","cursor_blink":false,"bold_bright":false});
    let (status, replaced) = call(
        &app,
        "PATCH",
        &path,
        json!({"revision":reset["revision"],"terminal_appearance":boundary}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert_eq!(replaced["terminal_appearance"], boundary);
    // A replacement does not silently retain palette keys removed by the user.
    let (status, replaced) = call(
        &app,
        "PATCH",
        &path,
        json!({"revision":replaced["revision"],"terminal_appearance":{"letter_spacing":0}}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{replaced}");
    assert_eq!(
        replaced["terminal_appearance"],
        json!({"letter_spacing":0.0})
    );
}

#[tokio::test]
async fn snippet_partial_updates_preserve_metadata_and_validate_before_writing() {
    let (app, _) = setup().await;
    let (_, host) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"snippet-host","hostname":"example.test"}),
    )
    .await;
    let (status, snippet) = call(&app, "POST", "/snippets", json!({"title":"Original","template":"echo {{ name }}\n", "variables":{"name":"default"},"host_id":host["id"]})).await;
    assert_eq!(status, StatusCode::CREATED);
    let path = format!("/snippets/{}", snippet["id"]);
    let (status, renamed) = call(&app, "PATCH", &path, json!({"title":"Renamed"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed["template"], snippet["template"]);
    assert_eq!(renamed["variables"], snippet["variables"]);
    assert_eq!(renamed["host_id"], host["id"]);
    // Legacy PUT clients omitting fields also preserve them.
    let (_, updated) = call(
        &app,
        "PUT",
        &path,
        json!({"title":"Renamed","template":"  echo changed\n"}),
    )
    .await;
    assert_eq!(updated["variables"], snippet["variables"]);
    assert_eq!(updated["host_id"], host["id"]);
    for body in [
        json!({"title":"  "}),
        json!({"template":"x\0y"}),
        json!({"template":"x".repeat(65537)}),
        json!({"variables":[]}),
        json!({"host_id":99999}),
    ] {
        assert_eq!(
            call(&app, "PATCH", &path, body).await.0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(call(&app, "GET", &path, Value::Null).await.1, updated);
    }
    let (_, cleared) = call(
        &app,
        "PATCH",
        &path,
        json!({"variables":null,"host_id":null}),
    )
    .await;
    assert_eq!(cleared["variables"], json!({}));
    assert!(cleared["host_id"].is_null());
    assert_eq!(
        call(
            &app,
            "POST",
            "/snippets",
            json!({"title":"x","template":"echo ok","host_id":99999})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, "PATCH", "/snippets/99999", json!({"title":"x"}))
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

async fn assert_saved_host_rejected(
    app: &Router,
    id: i64,
    tunnel_id: &str,
    snippet_id: i64,
    status: StatusCode,
    message: &str,
) {
    for (method, path) in [
        ("GET", format!("/sftp/hosts/{id}/list?path=.")),
        ("POST", format!("/sftp/hosts/{id}/probe")),
        ("POST", format!("/tunnels/{tunnel_id}/start")),
    ] {
        let (actual, body) = call(app, method, &path, json!({})).await;
        // Capability probes intentionally return auth_failed as a capability DTO.
        if path.ends_with("/probe") && status == StatusCode::UNAUTHORIZED {
            assert_eq!(actual, StatusCode::OK);
            assert_eq!(body["status"], "auth_failed");
            assert!(body["reason"].as_str().unwrap().contains(message));
        } else {
            assert_eq!(actual, status, "{path}: {body}");
            assert!(body["detail"].as_str().unwrap().contains(message), "{body}");
        }
        assert!(!body.to_string().contains("do-not-disclose"));
    }
    let (status, results) = call(
        app,
        "POST",
        &format!("/snippets/{snippet_id}/run"),
        json!({"host_ids":[id]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        results[0]["error"].as_str().unwrap().contains(message),
        "{results}"
    );
    assert!(!results.to_string().contains("do-not-disclose"));
}

#[tokio::test]
async fn saved_host_runtime_rejects_invalid_credentials_and_jump_routes_before_network_io() {
    let (app, state) = setup().await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (_, host) = call(&app, "POST", "/hosts", json!({"name":"blocked","hostname":"127.0.0.1","port":listener.local_addr().unwrap().port()})).await;
    let id = host["id"].as_i64().unwrap();
    let (_, tunnel) = call(
        &app,
        "POST",
        "/tunnels",
        json!({"name":"blocked","host_id":id,"kind":"dynamic","bind_port":0}),
    )
    .await;
    let tunnel = tunnel["id"].as_str().unwrap();
    let (_, snippet) = call(
        &app,
        "POST",
        "/snippets",
        json!({"title":"blocked","template":"echo ok"}),
    )
    .await;
    let snippet = snippet["id"].as_i64().unwrap();
    let (_, gateway) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"gateway","hostname":"gateway.test"}),
    )
    .await;
    sqlx::query("UPDATE hosts SET jump_host_id=? WHERE id=?")
        .bind(gateway["id"].as_i64().unwrap())
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    assert_saved_host_rejected(
        &app,
        id,
        tunnel,
        snippet,
        StatusCode::BAD_REQUEST,
        "Jump host",
    )
    .await;
    assert_eq!(
        call(
            &app,
            "GET",
            &format!("/sftp/hosts/{id}/capability"),
            Value::Null
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    sqlx::query("UPDATE hosts SET jump_host_id=NULL, password='do-not-disclose' WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    assert_saved_host_rejected(
        &app,
        id,
        tunnel,
        snippet,
        StatusCode::UNAUTHORIZED,
        "migrate this host's legacy credentials",
    )
    .await;
    unlock(&app, "Runtime-test-password").await;
    let (credential_id,): (i64,) = sqlx::query_as("SELECT credential_id FROM hosts WHERE id=?")
        .bind(id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    let key = vault::derive_key("Runtime-test-password").unwrap();
    for payload in [
        b"invalid do-not-disclose".as_slice(),
        br#"{"password":["do-not-disclose"]}"#,
        br#"{"unrelated":"do-not-disclose"}"#,
        br#"{"password":"valid","passphrase":"do-not-disclose"}"#,
    ] {
        let ciphertext = vault::encrypt(payload, &key).unwrap();
        sqlx::query("UPDATE vault_items SET ciphertext=? WHERE id=?")
            .bind(ciphertext)
            .bind(credential_id)
            .execute(&state.db)
            .await
            .unwrap();
        assert_saved_host_rejected(
            &app,
            id,
            tunnel,
            snippet,
            StatusCode::CONFLICT,
            "Repair or replace",
        )
        .await;
    }
    sqlx::query("UPDATE vault_items SET ciphertext=x'00' WHERE id=?")
        .bind(credential_id)
        .execute(&state.db)
        .await
        .unwrap();
    assert_saved_host_rejected(
        &app,
        id,
        tunnel,
        snippet,
        StatusCode::CONFLICT,
        "Repair or replace",
    )
    .await;
    // Simulate a historical dangling link without weakening production FKs.
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("DELETE FROM vault_items WHERE id=?")
        .bind(credential_id)
        .execute(&state.db)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&state.db)
        .await
        .unwrap();
    assert_saved_host_rejected(
        &app,
        id,
        tunnel,
        snippet,
        StatusCode::CONFLICT,
        "Repair or replace",
    )
    .await;
    vault::lock(&state.vault).await;
    assert_saved_host_rejected(
        &app,
        id,
        tunnel,
        snippet,
        StatusCode::UNAUTHORIZED,
        "Vault is locked",
    )
    .await;
    assert!(state.sessions.is_empty().await);
    assert!(state.sessions.tunnels().is_empty().await);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
            .await
            .is_err(),
        "Rejected operations must never contact the destination"
    );
}
fn alter_archive(archive: &Value, mutate: impl FnOnce(&mut Value)) -> Value {
    use base64::Engine;
    let base64 = base64::engine::general_purpose::STANDARD;
    let salt = base64.decode(archive["salt"].as_str().unwrap()).unwrap();
    let mut key = [0; 32];
    let params = argon2::Params::new(65536, 3, 4, Some(32)).unwrap();
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
        .hash_password_into(b"portable-backup-password", &salt, &mut key)
        .unwrap();
    let plain = vault::decrypt(
        &base64
            .decode(archive["ciphertext"].as_str().unwrap())
            .unwrap(),
        &key,
    )
    .unwrap();
    let mut data: Value = serde_json::from_slice(&plain).unwrap();
    mutate(&mut data);
    let mut result = archive.clone();
    result["ciphertext"] =
        json!(base64.encode(vault::encrypt(&serde_json::to_vec(&data).unwrap(), &key).unwrap()));
    result
}
fn archive_with_invalid_reference(archive: &Value) -> Value {
    alter_archive(archive, |data| {
        data["tables"]["hosts"][0]["jump_host_id"] = json!(999999)
    })
}
#[tokio::test]
async fn host_patches_preserve_omitted_fields_reject_stale_edits_and_clear_explicit_nulls() {
    let (app, state) = setup().await;
    let (_, jump) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"gateway","hostname":"gateway.test"}),
    )
    .await;
    let (_, host) = call(&app, "POST", "/hosts", json!({"name":"server","hostname":"server.test","group":" / Prod // DB / ","jump_host_id":jump["id"]})).await;
    let path = format!("/hosts/{}", host["id"]);
    assert_eq!(host["username"], "");
    assert_eq!(host["group"], "Prod/DB");
    let (status, updated) = call(
        &app,
        "PATCH",
        &path,
        json!({"revision":host["revision"],"terminal_font_size":18}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["jump_host_id"], jump["id"]);
    assert_eq!(updated["group"], "Prod/DB");
    assert_eq!(updated["hostname"], "server.test");
    assert!(updated["revision"].as_i64().unwrap() > host["revision"].as_i64().unwrap());
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            json!({"revision":host["revision"],"group":"wrong"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(&app, "PATCH", &path, json!({"group":"missing version"}))
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    let (status, compatible) = call(
        &app,
        "PUT",
        &path,
        json!({"name":"renamed","hostname":"server.test"}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{compatible}");
    assert_eq!(compatible["jump_host_id"], jump["id"]);
    assert_eq!(compatible["terminal_font_size"], 18);
    let (first, second) = tokio::join!(
        call(
            &app,
            "PATCH",
            &path,
            json!({"revision":compatible["revision"],"group":"First"})
        ),
        call(
            &app,
            "PATCH",
            &path,
            json!({"revision":compatible["revision"],"group":"Second"})
        ),
    );
    assert!(matches!(
        (first.0, second.0),
        (StatusCode::OK, StatusCode::CONFLICT) | (StatusCode::CONFLICT, StatusCode::OK)
    ));
    let latest = call(&app, "GET", &path, Value::Null).await.1;
    let (status, cleared) = call(
        &app,
        "PATCH",
        &path,
        json!({"revision":latest["revision"],"group":null,"jump_host_id":null}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{cleared}");
    assert!(cleared["group"].is_null());
    assert!(cleared["jump_host_id"].is_null());
    assert_eq!(cleared["terminal_font_size"], 18);
    for group in ["Prod/../DB", "Prod/DB\u{0}"] {
        assert_eq!(
            call(
                &app,
                "PATCH",
                &path,
                json!({"revision":cleared["revision"],"group":group})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            json!({"revision":cleared["revision"],"jump_host_id":host["id"]})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        call(&app, "DELETE", &path, Value::Null).await.0,
        StatusCode::NO_CONTENT
    );
    // AUTOINCREMENT prevents normal POSTs from reusing IDs. Restore/import
    // explicitly supplies them; exercise that insertion path here.
    sqlx::query("INSERT INTO hosts(id,name,hostname) VALUES(?,'replacement','new.test')")
        .bind(host["id"].as_i64().unwrap())
        .execute(&state.db)
        .await
        .unwrap();
    let (_, replacement) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(replacement["id"], host["id"]);
    assert!(replacement["revision"].as_i64().unwrap() > cleared["revision"].as_i64().unwrap());
    assert_eq!(
        call(
            &app,
            "PATCH",
            &path,
            json!({"revision":cleared["revision"],"name":"stale deleted profile"})
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn host_delete_reports_dependencies_and_preserves_records_until_reassigned() {
    let (app, state) = setup().await;
    let (_, jump) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"gateway","hostname":"jump.test"}),
    )
    .await;
    let (_, child) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"child","hostname":"child.test","jump_host_id":jump["id"]}),
    )
    .await;
    sqlx::query("INSERT INTO snippets(title,template,host_id) VALUES('Keep snippet','echo ok',?)")
        .bind(jump["id"].as_i64().unwrap())
        .execute(&state.db)
        .await
        .unwrap();
    let path = format!("/hosts/{}", jump["id"]);
    let (status, error) = call(&app, "DELETE", &path, Value::Null).await;
    assert_eq!(status, StatusCode::CONFLICT, "{error}");
    assert!(error["detail"].as_str().unwrap().contains("1 jump host"));
    assert!(error["detail"].as_str().unwrap().contains("1 snippet"));
    assert_eq!(
        call(&app, "GET", &path, Value::Null).await.0,
        StatusCode::OK
    );
    call(
        &app,
        "PATCH",
        &format!("/hosts/{}", child["id"]),
        json!({"revision":child["revision"],"jump_host_id":null}),
    )
    .await;
    assert_eq!(
        call(&app, "DELETE", &path, Value::Null).await.0,
        StatusCode::CONFLICT
    );
    sqlx::query("DELETE FROM snippets")
        .execute(&state.db)
        .await
        .unwrap();
    assert_eq!(
        call(&app, "DELETE", &path, Value::Null).await.0,
        StatusCode::NO_CONTENT
    );
}

#[tokio::test]
async fn credential_flags_are_exact_while_locked_and_legacy_metadata_is_repaired_on_unlock() {
    let (app, state) = setup().await;
    unlock(&app, "host-flags-password").await;
    let (_, host) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"password-only","hostname":"server.test","password":"saved-secret"}),
    )
    .await;
    assert_eq!(host["has_password"], true);
    assert_eq!(host["has_private_key"], false);
    vault::lock(&state.vault).await;
    let path = format!("/hosts/{}", host["id"]);
    let (_, locked) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(locked["has_password"], true);
    assert_eq!(locked["has_private_key"], false);
    sqlx::query("UPDATE vault_items SET item_metadata='{}' WHERE id=?")
        .bind(host["credential_id"].as_i64().unwrap())
        .execute(&state.db)
        .await
        .unwrap();
    unlock(&app, "host-flags-password").await;
    let (_, repaired) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(repaired["has_password"], true);
    assert_eq!(repaired["has_private_key"], false);
    let (_, credential) = call(
        &app,
        "POST",
        "/credentials",
        json!({"name":"Shared identity","password":"one"}),
    )
    .await;
    let credential_path = format!("/credentials/{}", credential["id"]);
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("{credential_path}/hosts/{}", host["id"]),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, bound) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(
        call(
            &app,
            "PUT",
            &credential_path,
            json!({"name":"Shared identity","password":"two"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let (_, changed) = call(&app, "GET", &path, Value::Null).await;
    assert!(changed["revision"].as_i64().unwrap() > bound["revision"].as_i64().unwrap());
    assert_eq!(changed["has_password"], true);
    assert_eq!(changed["has_private_key"], false);
    assert!(!changed.to_string().contains("saved-secret"));
}
#[tokio::test]
async fn new_endpoints_require_authentication_and_credentials_require_unlocked_vault() {
    let (app, _) = setup().await;
    for path in [
        "/credentials",
        "/known-hosts",
        "/tunnels",
        "/local-files",
        "/local-files/content",
    ] {
        let response = app
            .clone()
            .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{path}");
    }
    assert_eq!(
        call(
            &app,
            "POST",
            "/credentials",
            json!({"name":"locked","password":"test"})
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
}
#[tokio::test]
async fn workspace_replacement_rejects_new_mutations_instead_of_applying_them_to_new_ids() {
    let (app, state) = setup().await;
    let lease = state.sessions.workspace_gate().write_owned().await;
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        call(
            &app,
            "POST",
            "/hosts",
            json!({"name":"blocked","hostname":"example.test"}),
        ),
    )
    .await
    .unwrap();
    assert_eq!(response.0, StatusCode::CONFLICT);
    drop(lease);
    assert!(call(&app, "GET", "/hosts", Value::Null)
        .await
        .1
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        call(
            &app,
            "POST",
            "/hosts",
            json!({"name":"after-restore","hostname":"example.test"})
        )
        .await
        .0,
        StatusCode::CREATED
    );
}
#[tokio::test]
async fn generated_key_roundtrips_encryption_and_public_dtos_never_expose_secrets() {
    let (app, state) = setup().await;
    unlock(&app, "test-vault-password").await;
    let (status,result)=call(&app,"POST","/credentials",json!({"name":"Generated key","username":"admin","generate":"ed25519","passphrase":"test-key-passphrase"})).await;
    assert_eq!(status, StatusCode::CREATED, "{result}");
    let id = result["id"].as_i64().unwrap();
    let secret = vault::retrieve_secret(&state.vault, &state.db, id)
        .await
        .unwrap();
    let secret: Value = serde_json::from_slice(&secret).unwrap();
    let key = russh::keys::decode_secret_key(
        secret["private_key"].as_str().unwrap(),
        Some("test-key-passphrase"),
    )
    .unwrap();
    vault::store_secret(&state.vault,&state.db,"Unsafe metadata",b"not-an-ssh-credential",Some(r#"{"password":"must-not-leak","private_key":"must-not-leak","public_key":"PRIVATE KEY","type":{"unexpected":true}}"#)).await.unwrap();
    let (_, items) = call(&app, "GET", "/credentials", Value::Null).await;
    assert_eq!(
        items[0]["metadata"]["public_key"],
        key.public_key().to_openssh().unwrap()
    );
    let serialized = items.to_string();
    assert!(!serialized.contains("test-key-passphrase"));
    assert!(!serialized.contains("PRIVATE KEY"));
    assert!(!serialized.contains("must-not-leak"));
    let (_, host) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"server","hostname":"example.test","username":"old"}),
    )
    .await;
    let host_id = host["id"].as_i64().unwrap();
    assert_eq!(
        call(
            &app,
            "POST",
            &format!("/credentials/{id}/hosts/{host_id}"),
            Value::Null
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, "DELETE", &format!("/credentials/{id}"), Value::Null)
            .await
            .0,
        StatusCode::CONFLICT
    );
    let (_, host) = call(&app, "GET", &format!("/hosts/{host_id}"), Value::Null).await;
    assert_eq!(host["username"], "admin");
    assert!(host.get("private_key").is_none());
    assert_eq!(
        call(
            &app,
            "PUT",
            &format!("/credentials/{id}"),
            json!({"name":"New identity","password":"rotated-test-password"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let linked: (i64,) = sqlx::query_as("SELECT credential_id FROM hosts WHERE id=?")
        .bind(host_id)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(linked.0, id);
    assert_eq!(
        call(&app, "DELETE", &format!("/hosts/{host_id}"), Value::Null)
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert!(
        vault::retrieve_secret(&state.vault, &state.db, id)
            .await
            .is_ok(),
        "Managed credentials survive deletion of their last host"
    );
}
#[tokio::test]
async fn rsa_generation_is_real_and_invalid_key_import_is_rejected() {
    let (app, state) = setup().await;
    unlock(&app, "test-vault-password").await;
    let (status, result) = call(
        &app,
        "POST",
        "/credentials",
        json!({"name":"RSA key","generate":"rsa"}),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{result}");
    let secret = vault::retrieve_secret(&state.vault, &state.db, result["id"].as_i64().unwrap())
        .await
        .unwrap();
    let secret: Value = serde_json::from_slice(&secret).unwrap();
    let key =
        russh::keys::decode_secret_key(secret["private_key"].as_str().unwrap(), None).unwrap();
    assert!(matches!(
        key.algorithm(),
        russh::keys::ssh_key::Algorithm::Rsa { .. }
    ));
    assert_eq!(
        call(
            &app,
            "POST",
            "/credentials",
            json!({"name":"Invalid","private_key":"invalid-key"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
}
#[tokio::test]
async fn encrypted_backup_restores_under_a_different_vault_password_and_failures_leave_target_intact(
) {
    let (source, source_state) = setup().await;
    unlock(&source, "source-vault-password").await;
    let (_, host) = call(
        &source,
        "POST",
        "/hosts",
        json!({"name":"source-host","hostname":"example.test","password":"source-secret-password","terminal_background":"#112233","terminal_foreground":"#ddeeff","terminal_appearance":{"font_family":"Consolas","line_height":1.4,"colors":{"green":"#aabbcc"}}}),
    )
    .await;
    sqlx::query("INSERT INTO network_maps(id,name) VALUES('map','Portable map')")
        .execute(&source_state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO map_nodes(id,map_id,host_id) VALUES('node','map',?)")
        .bind(host["id"].as_i64().unwrap())
        .execute(&source_state.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO ssh_tunnels(id,name,host_id,kind,bind_port) VALUES('proxy','Portable proxy',?,'dynamic',1080)").bind(host["id"].as_i64().unwrap()).execute(&source_state.db).await.unwrap();
    // Force a backup request above the app-wide 2 MiB limit to exercise the
    // explicit backup route limit as well as the ordinary small-payload path.
    sqlx::query("INSERT INTO audit_logs(event_type,details) VALUES('test',?)")
        .bind("x".repeat(2 * 1024 * 1024))
        .execute(&source_state.db)
        .await
        .unwrap();
    let (status,archive)=call(&source,"POST","/backups/export",json!({"password":"portable-backup-password","preferences":{"settings":{"terminal":{"fontSize":16}}}})).await;
    assert_eq!(status, StatusCode::OK, "{:?}", archive.get("detail"));
    assert!(!archive.to_string().contains("source-secret-password"));
    let (target, target_state) = setup().await;
    unlock(&target, "target-vault-password").await;
    call(
        &target,
        "POST",
        "/hosts",
        json!({"name":"keep-until-success","hostname":"target.test"}),
    )
    .await;
    let (status, _) = call(
        &target,
        "POST",
        "/backups/restore",
        json!({"password":"wrong-password","archive":archive,"confirmation":"RESTORE BACKUP"}),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        call(&target, "GET", "/hosts", Value::Null).await.1[0]["name"],
        "keep-until-success"
    );
    let invalid = archive_with_invalid_reference(&archive);
    let (status,result)=call(&target,"POST","/backups/restore",json!({"password":"portable-backup-password","archive":invalid,"confirmation":"RESTORE BACKUP"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    let invalid_group = alter_archive(&archive, |data| {
        data["tables"]["hosts"][0]["group"] = json!(123)
    });
    let (status, result) = call(&target,"POST","/backups/restore",json!({"password":"portable-backup-password","archive":invalid_group,"confirmation":"RESTORE BACKUP"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{result}");
    let invalid_color = alter_archive(&archive, |data| {
        data["tables"]["hosts"][0]["terminal_background"] = json!("not-a-color")
    });
    let (status, _) = call(&target, "POST", "/backups/restore", json!({"password":"portable-backup-password","archive":invalid_color,"confirmation":"RESTORE BACKUP"})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        call(&target, "GET", "/hosts", Value::Null).await.1[0]["name"],
        "keep-until-success",
        "A commit-time FK failure must roll back all deletes and inserts"
    );
    let invalid_appearance = alter_archive(&archive, |data| {
        data["tables"]["hosts"][0]["terminal_appearance"] = json!(r#"{"line_height":99}"#);
    });
    assert_eq!(call(&target, "POST", "/backups/restore", json!({"password":"portable-backup-password","archive":invalid_appearance,"confirmation":"RESTORE BACKUP"})).await.0, StatusCode::BAD_REQUEST);
    assert_eq!(
        call(&target, "GET", "/hosts", Value::Null).await.1[0]["name"],
        "keep-until-success"
    );
    let (status,result)=call(&target,"POST","/backups/restore",json!({"password":"portable-backup-password","archive":archive,"confirmation":"RESTORE BACKUP"})).await;
    assert_eq!(status, StatusCode::OK, "{result}");
    assert_eq!(
        result["preferences"]["settings"]["terminal"]["fontSize"],
        16
    );
    let (_, hosts) = call(&target, "GET", "/hosts", Value::Null).await;
    assert_eq!(hosts.as_array().unwrap().len(), 1);
    assert_eq!(hosts[0]["name"], "source-host");
    assert_eq!(hosts[0]["terminal_background"], "#112233");
    assert_eq!(hosts[0]["terminal_foreground"], "#ddeeff");
    assert_eq!(hosts[0]["terminal_appearance"]["font_family"], "Consolas");
    assert_eq!(
        hosts[0]["terminal_appearance"]["colors"]["green"],
        "#aabbcc"
    );
    assert!(hosts[0]["revision"].as_i64().unwrap() > host["revision"].as_i64().unwrap());
    assert_eq!(hosts[0]["has_password"], true);
    assert_eq!(hosts[0]["has_private_key"], false);
    // The previous snapshot format is upgraded transactionally, including
    // canonical groups and metadata repaired from the encrypted secret.
    for schema_version in [5, 6, 7] {
        let legacy_archive = alter_archive(&archive, |data| {
            assert_eq!(data["schema_version"], 8);
            data["schema_version"] = json!(schema_version);
            for host in data["tables"]["hosts"].as_array_mut().unwrap() {
                if schema_version == 5 {
                    host.as_object_mut().unwrap().remove("revision");
                }
                if schema_version < 7 {
                    host.as_object_mut().unwrap().remove("terminal_background");
                    host.as_object_mut().unwrap().remove("terminal_foreground");
                }
                host.as_object_mut().unwrap().remove("terminal_appearance");
                host["group"] = json!(" / Prod // DB / ");
            }
            for item in data["tables"]["vault_items"].as_array_mut().unwrap() {
                item["item_metadata"] = json!(
                    r#"{"type":"host_credentials","has_password":false,"has_private_key":true}"#
                );
            }
        });
        let (status, restored) = call(&target,"POST","/backups/restore",json!({"password":"portable-backup-password","archive":legacy_archive,"confirmation":"RESTORE BACKUP"})).await;
        assert_eq!(status, StatusCode::OK, "{restored}");
        let (_, upgraded) = call(&target, "GET", "/hosts", Value::Null).await;
        assert_eq!(upgraded[0]["group"], "Prod/DB");
        assert_eq!(upgraded[0]["has_password"], true);
        assert_eq!(upgraded[0]["has_private_key"], false);
        assert_eq!(upgraded[0]["terminal_appearance"], Value::Null);
        if schema_version < 7 {
            assert_eq!(upgraded[0]["terminal_background"], Value::Null);
            assert_eq!(upgraded[0]["terminal_foreground"], Value::Null);
        } else {
            assert_eq!(upgraded[0]["terminal_background"], "#112233");
            assert_eq!(upgraded[0]["terminal_foreground"], "#ddeeff");
        }
    }
    let (status, _) = call(
        &target,
        "PATCH",
        &format!("/hosts/{}", hosts[0]["id"]),
        json!({"revision":hosts[0]["revision"],"name":"stale editor"}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let graph: (String, i64) =
        sqlx::query_as("SELECT map_id,host_id FROM map_nodes WHERE id='node'")
            .fetch_one(&target_state.db)
            .await
            .unwrap();
    assert_eq!(graph.0, "map");
    assert_eq!(graph.1, hosts[0]["id"].as_i64().unwrap());
    assert_eq!(
        call(&target, "GET", "/tunnels", Value::Null).await.1[0]["active"],
        false,
        "Restoring must not start remote connections"
    );
    let cid = hosts[0]["credential_id"].as_i64().unwrap();
    let plain = vault::retrieve_secret(&target_state.vault, &target_state.db, cid)
        .await
        .unwrap();
    assert!(String::from_utf8(plain)
        .unwrap()
        .contains("source-secret-password"));
    vault::lock(&target_state.vault).await;
    assert!(vault::unlock(
        &target_state.vault,
        &target_state.db,
        "source-vault-password"
    )
    .await
    .is_err());
    assert!(vault::unlock(
        &target_state.vault,
        &target_state.db,
        "target-vault-password"
    )
    .await
    .is_ok());
    assert_eq!(host["name"], "source-host");
    drop(source_state);
}
#[tokio::test]
async fn ssh_config_import_is_selected_idempotent_and_never_executes_proxy_commands() {
    let (app, state) = setup().await;
    let content="Host prod\n HostName production.example\n User admin\n IdentityFile ~/.ssh/prod\nHost jump-only\n ProxyCommand echo should-not-run\n";
    let (_, preview) = call(
        &app,
        "POST",
        "/ssh-config/preview",
        json!({"content":content}),
    )
    .await;
    assert_eq!(preview["hosts"].as_array().unwrap().len(), 2);
    assert_eq!(call(&app,"POST","/ssh-config/import",json!({"content":"Host prod\n HostName changed.example","aliases":["prod"],"revision":preview["revision"]})).await.0,StatusCode::CONFLICT);
    assert_eq!(
        call(
            &app,
            "POST",
            "/ssh-config/import",
            json!({"content":content,"aliases":["jump-only"]})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    for expected in [1, 0] {
        let (status, result) = call(
            &app,
            "POST",
            "/ssh-config/import",
            json!({"content":content,"aliases":["prod"]}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{result}");
        assert_eq!(result["imported"], expected);
    }
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM hosts")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(count.0, 1);
}
#[tokio::test]
async fn local_files_are_read_only_bounded_and_tunnel_rules_are_ssh_only() {
    let (app, _) = setup().await;
    let dir = std::env::temp_dir().join(format!("netrix-local-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let file = dir.join("test.txt");
    std::fs::write(&file, b"local-test-bytes").unwrap();
    let path = format!(
        "/local-files?path={}",
        dir.to_string_lossy().replace('\\', "/").replace(' ', "%20")
    );
    let (status, list) = call(&app, "GET", &path, Value::Null).await;
    assert_eq!(status, StatusCode::OK, "{list}");
    assert_eq!(list["entries"][0]["name"], "test.txt");
    let content_path = format!(
        "/local-files/content?path={}",
        file.to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "%20")
    );
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(content_path)
                .header("X-API-Token", "management-test-token")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        to_bytes(response.into_body(), 100).await.unwrap().as_ref(),
        b"local-test-bytes"
    );
    let (_, host) = call(
        &app,
        "POST",
        "/hosts",
        json!({"name":"telnet","hostname":"example.test","connection_type":"telnet","port":23}),
    )
    .await;
    assert_eq!(call(&app,"POST","/tunnels",json!({"name":"invalid","host_id":host["id"],"kind":"local","bind_port":12345,"destination_host":"127.0.0.1","destination_port":5432})).await.0,StatusCode::BAD_REQUEST);
    std::fs::remove_file(file).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
