//! Loopback-only tests of the actual Axum/WebSocket/transport boundary.
mod common;
use futures::{SinkExt, StreamExt};
use netrix_backend::{auth, routers, ssh, vault};
use serde_json::json;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
    MaybeTlsStream, WebSocketStream,
};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start_api() -> (auth::AppState, u16, tokio::task::JoinHandle<()>) {
    common::init();
    let known_hosts = ssh::known_hosts::KnownHostsStore::from_path(
        netrix_backend::config::SETTINGS
            .app_data_dir
            .join(format!("known_hosts-{}", uuid::Uuid::new_v4())),
    );
    let state = auth::AppState {
        database_encryption: None,
        security: netrix_backend::security::AppSecurity::default(),
        db: sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap(),
        vault: vault::new_vault(),
        api_token: "wire-test-token".into(),
        sessions: ssh::SessionManager::with_known_hosts(known_hosts.clone()),
        sftp: ssh::SftpManager::with_known_hosts(known_hosts),
        quick_connect_tickets: auth::QuickConnectTicketStore::new(),
        vault_unlock_limiter: auth::VaultUnlockLimiter::new(),
    };
    let app = routers::sessions::router()
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (state, port, task)
}

async fn open(
    state: &auth::AppState,
    port: u16,
    target: serde_json::Value,
    sid: Option<i64>,
) -> Socket {
    let (ticket, _) = state.quick_connect_tickets.issue(target, sid).await;
    let mut request = format!("ws://127.0.0.1:{port}/ws/quick-connect?ticket={ticket}")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "netrix.v1, netrix-token.wire-test-token".parse().unwrap(),
    );
    connect_async(request).await.unwrap().0
}

async fn next(socket: &mut Socket) -> Message {
    tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
}

async fn open_resume(port: u16, sid: i64, after: u64) -> Socket {
    open_exact_session(port, sid, &format!("?after={after}")).await
}

async fn open_exact_session(port: u16, sid: i64, query: &str) -> Socket {
    let mut request = format!("ws://127.0.0.1:{port}/ws/sessions/{sid}{query}")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "netrix.v1, netrix-token.wire-test-token".parse().unwrap(),
    );
    connect_async(request).await.unwrap().0
}

#[tokio::test]
async fn application_lock_discards_terminal_input_without_disconnect_or_replay() {
    let (state, port, api) = start_api().await;
    saved_host_schema(&state).await;
    vault::unlock(&state.vault, &state.db, "Wire-lock-test-password")
        .await
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"connection_type":"telnet","cols":80,"rows":24,"term":"xterm"});
    let mut socket = open(&state, port, target, None).await;
    let (mut remote, _) = listener.accept().await.unwrap();
    let sid = connected(&mut socket).await;
    state.security.lock_now(&state).await.unwrap();
    let mut request = format!("ws://127.0.0.1:{port}/ws/sessions/{sid}")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "netrix.v1, netrix-token.wire-test-token".parse().unwrap(),
    );
    let error = connect_async(request).await.unwrap_err();
    assert!(
        matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status().as_u16() == 423)
    );
    socket
        .send(Message::Binary(b"blocked-command\r"[..].into()))
        .await
        .unwrap();
    socket
        .send(Message::Text("{\"type\":\"terminate\"}".into()))
        .await
        .unwrap();
    // A roundtrip proves the bridge has processed the preceding frames.
    socket
        .send(Message::Text("{\"type\":\"heartbeat\"}".into()))
        .await
        .unwrap();
    assert!(next(&mut socket).await.to_text().unwrap().contains("pong"));
    assert!(state.sessions.get(sid).await.is_some());
    let mut bytes = [0; 64];
    assert!(
        tokio::time::timeout(Duration::from_millis(100), remote.read(&mut bytes))
            .await
            .is_err()
    );
    {
        let _guard = state.security.transition().await;
        vault::unlock(&state.vault, &state.db, "Wire-lock-test-password")
            .await
            .unwrap();
        state.security.unlock_after_verification().await;
    }
    socket
        .send(Message::Binary(b"allowed\r"[..].into()))
        .await
        .unwrap();
    let mut accepted = [0; 8];
    tokio::time::timeout(Duration::from_secs(3), remote.read_exact(&mut accepted))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&accepted, b"allowed\r");
    state.sessions.cleanup(sid).await;
    api.abort();
}

#[tokio::test]
async fn handoff_resumes_an_active_transport_from_an_exact_checkpoint() {
    let (state, port, api) = start_api().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"connection_type":"telnet","cols":80,"rows":24,"term":"xterm"});
    let mut source = open(&state, port, target, None).await;
    let (mut remote, _) = listener.accept().await.unwrap();
    let sid = connected(&mut source).await;
    remote.write_all(b"before-after").await.unwrap();
    let mut output = Vec::new();
    while output.len() < 12 {
        if let Message::Binary(bytes) = next(&mut source).await {
            output.extend(bytes);
        }
    }
    let mut destination = open_resume(port, sid, 7).await;
    assert_eq!(connected(&mut destination).await, sid);
    assert_eq!(
        next(&mut destination).await,
        Message::Binary(b"after"[..].into())
    );
    let Message::Text(end) = next(&mut destination).await else {
        panic!("replay acknowledgement required")
    };
    assert!(end.contains("replay_end"));
    assert!(end.contains("12"));
    let mut invalid = open_resume(port, sid, 13).await;
    let Message::Text(error) = next(&mut invalid).await else {
        panic!("future cursor must fail")
    };
    assert!(error.contains("too quickly"));
    // Cancelling a speculative destination must not disconnect the source.
    destination
        .send(Message::Text("{\"type\":\"detach\"}".into()))
        .await
        .unwrap();
    source
        .send(Message::Binary(b"still-here"[..].into()))
        .await
        .unwrap();
    let mut actual = [0; 10];
    tokio::time::timeout(Duration::from_secs(3), remote.read_exact(&mut actual))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&actual, b"still-here");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err(),
        "handoff must never open another connection"
    );
    state.sessions.cleanup(sid).await;
    api.abort();
}

#[tokio::test]
async fn handoff_requires_authentication_and_never_creates_a_missing_session() {
    let (state, port, api) = start_api().await;
    let mut missing = open_resume(port, 404, 0).await;
    let Message::Text(error) = next(&mut missing).await else {
        panic!("missing session must fail")
    };
    assert!(error.contains("has ended"));
    assert!(state.sessions.get(404).await.is_none());
    let request = format!("ws://127.0.0.1:{port}/ws/sessions/404?after=0")
        .into_client_request()
        .unwrap();
    let error = connect_async(request).await.unwrap_err();
    assert!(
        matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 403)
    );
    api.abort();
}

async fn connected(socket: &mut Socket) -> i64 {
    connected_descriptor(socket).await["session_id"]
        .as_i64()
        .unwrap()
}

async fn connected_descriptor(socket: &mut Socket) -> serde_json::Value {
    let mut descriptor = None;
    loop {
        if let Message::Text(text) = next(socket).await {
            if let Some(json) = text.strip_prefix("__JSON__") {
                let value: serde_json::Value = serde_json::from_str(json).unwrap();
                if value["type"] == "connect" {
                    let session_id = value["session_id"].as_i64();
                    socket
                        .send(Message::Text(
                            json!({"type":"ready", "session_id":session_id})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                    descriptor = Some(value.clone());
                }
                if value["type"] == "replay_start" {
                    return descriptor.expect("connection descriptor before replay");
                }
                assert_ne!(value["type"], "error", "{value}");
            }
        }
    }
}

async fn delete_session_http(port: u16, sid: i64, authenticated: bool) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let token = if authenticated {
        "X-API-Token: wire-test-token\r\n"
    } else {
        ""
    };
    let request = format!("DELETE /sessions/{sid} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{token}Connection: close\r\nContent-Length: 0\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = String::new();
    tokio::time::timeout(Duration::from_secs(3), stream.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    response
}

#[tokio::test]
async fn http_close_after_broken_websocket_terminates_only_the_exact_transport_and_can_be_retried()
{
    let (state, port, api) = start_api().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"connection_type":"telnet"});
    let mut first = open(&state, port, target.clone(), None).await;
    let (mut first_remote, _) = listener.accept().await.unwrap();
    let first_id = connected(&mut first).await;
    let mut second = open(&state, port, target, None).await;
    let (mut second_remote, _) = listener.accept().await.unwrap();
    let second_id = connected(&mut second).await;
    // No terminate frame can be delivered after this transport disappears.
    drop(first);
    assert!(delete_session_http(port, first_id, false)
        .await
        .starts_with("HTTP/1.1 403"));
    assert!(state.sessions.get(first_id).await.is_some());
    let response = delete_session_http(port, first_id, true).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert!(state.sessions.get(first_id).await.is_none());
    let mut drain = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), first_remote.read_to_end(&mut drain))
        .await
        .unwrap()
        .unwrap();
    assert!(delete_session_http(port, first_id, true)
        .await
        .contains("\"terminated\":false"));
    second
        .send(Message::Binary(b"still connected"[..].into()))
        .await
        .unwrap();
    let mut actual = [0; 15];
    tokio::time::timeout(
        Duration::from_secs(3),
        second_remote.read_exact(&mut actual),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(&actual, b"still connected");
    assert!(state.sessions.get(second_id).await.is_some());
    // WebSocket terminate and HTTP DELETE are allowed to arrive together.
    second
        .send(Message::Text("{\"type\":\"terminate\"}".into()))
        .await
        .unwrap();
    assert!(delete_session_http(port, second_id, true)
        .await
        .starts_with("HTTP/1.1 200"));
    assert!(state.sessions.is_empty().await);
    tokio::time::timeout(
        Duration::from_secs(3),
        second_remote.read_to_end(&mut drain),
    )
    .await
    .unwrap()
    .unwrap();
    api.abort();
}

#[tokio::test]
async fn closing_before_receiving_a_new_session_id_never_leaves_an_orphan() {
    let (state, port, api) = start_api().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"connection_type":"telnet"});
    let mut socket = open(&state, port, target, None).await;
    let (mut remote, _) = listener.accept().await.unwrap();
    // Receive connect without acknowledging it, as if the tab closed before
    // its onmessage handler could save the ID.
    let Message::Text(connect) = next(&mut socket).await else {
        panic!("expected connect")
    };
    assert!(connect.contains("\"type\":\"connect\""));
    drop(socket);
    tokio::time::timeout(Duration::from_secs(3), async {
        while !state.sessions.is_empty().await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut drain = Vec::new();
    tokio::time::timeout(Duration::from_secs(3), remote.read_to_end(&mut drain))
        .await
        .unwrap()
        .unwrap();
    api.abort();
}

async fn saved_host_schema(state: &auth::AppState) {
    for schema in [
        include_str!("../migrations/001_initial_schema.sql"),
        include_str!("../migrations/004_add_local_shell_fields.sql"),
        include_str!("../migrations/005_ssh_tunnels.sql"),
        include_str!("../migrations/006_host_revisions.sql"),
        include_str!("../migrations/007_terminal_colors.sql"),
        include_str!("../migrations/008_terminal_appearance.sql"),
    ] {
        sqlx::raw_sql(schema).execute(&state.db).await.unwrap();
    }
}

async fn open_saved(port: u16, query: &str) -> Socket {
    let mut request = format!("ws://127.0.0.1:{port}/ws/terminal/1{query}")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        "netrix.v1, netrix-token.wire-test-token".parse().unwrap(),
    );
    connect_async(request).await.unwrap().0
}

async fn detach_and_wait(state: &auth::AppState, socket: &mut Socket, sid: i64) {
    socket
        .send(Message::Text("{\"type\":\"detach\"}".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let handle = state.sessions.get(sid).await.unwrap();
            if handle.read().await.state == ssh::manager::SessionState::Detached {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn edited_profile_reports_the_actual_transport_on_resume_and_new_session() {
    let (state, port, api) = start_api().await;
    saved_host_schema(&state).await;
    let first_target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let second_target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let first_port = first_target.local_addr().unwrap().port();
    let second_port = second_target.local_addr().unwrap().port();
    sqlx::query("INSERT INTO hosts(id,name,hostname,port,username,connection_type) VALUES(1,'profile','127.0.0.1',?,'alice','telnet')")
        .bind(i64::from(first_port)).execute(&state.db).await.unwrap();
    let mut first = open_saved(port, "").await;
    let (mut first_remote, _) = tokio::time::timeout(Duration::from_secs(3), first_target.accept())
        .await
        .unwrap()
        .unwrap();
    let original = connected_descriptor(&mut first).await;
    let sid = original["session_id"].as_i64().unwrap();
    assert_eq!(original["connection"]["port"], first_port);
    sqlx::query("UPDATE hosts SET port=?, username='bob', revision=revision+1 WHERE id=1")
        .bind(i64::from(second_port))
        .execute(&state.db)
        .await
        .unwrap();
    detach_and_wait(&state, &mut first, sid).await;
    let mut resumed = open_exact_session(port, sid, "").await;
    let resumed_info = connected_descriptor(&mut resumed).await;
    assert_eq!(resumed_info["connection"], original["connection"]);
    resumed
        .send(Message::Binary(b"to A"[..].into()))
        .await
        .unwrap();
    let mut bytes = [0; 4];
    tokio::time::timeout(Duration::from_secs(3), first_remote.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"to A");
    assert!(delete_session_http(port, sid, true)
        .await
        .starts_with("HTTP/1.1 200"));

    let mut replacement = open_saved(port, "").await;
    let (mut second_remote, _) =
        tokio::time::timeout(Duration::from_secs(3), second_target.accept())
            .await
            .unwrap()
            .unwrap();
    let replacement_info = connected_descriptor(&mut replacement).await;
    assert_ne!(replacement_info["session_id"], sid);
    assert_eq!(replacement_info["connection"]["port"], second_port);
    assert_eq!(replacement_info["connection"]["username"], "bob");
    assert_eq!(replacement_info["connection"]["connection_type"], "telnet");
    replacement
        .send(Message::Binary(b"to B"[..].into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), second_remote.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"to B");
    state
        .sessions
        .cleanup(replacement_info["session_id"].as_i64().unwrap())
        .await;
    api.abort();
}

#[tokio::test]
async fn same_host_terminals_resume_only_their_own_session_and_history() {
    let (state, port, api) = start_api().await;
    saved_host_schema(&state).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    sqlx::query("INSERT INTO hosts(id,name,hostname,port,username,connection_type) VALUES(1,'same','127.0.0.1',?,'same-user','telnet')")
        .bind(i64::from(listener.local_addr().unwrap().port())).execute(&state.db).await.unwrap();
    let mut first = open_saved(port, "").await;
    let (mut first_remote, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let first_id = connected(&mut first).await;
    first_remote.write_all(b"first-screen").await.unwrap();
    assert_eq!(
        next(&mut first).await,
        Message::Binary(b"first-screen"[..].into())
    );
    detach_and_wait(&state, &mut first, first_id).await;

    // No ID means a new connection, even when this exact host has a detached one.
    let mut second = open_saved(port, "").await;
    let (mut second_remote, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let second_id = connected(&mut second).await;
    assert_ne!(first_id, second_id);
    second_remote.write_all(b"second-screen").await.unwrap();
    assert_eq!(
        next(&mut second).await,
        Message::Binary(b"second-screen"[..].into())
    );
    detach_and_wait(&state, &mut second, second_id).await;

    // Resume in reverse order, including the legacy saved-host sid route.
    let mut second = open_exact_session(port, second_id, "").await;
    assert_eq!(connected(&mut second).await, second_id);
    assert_eq!(
        next(&mut second).await,
        Message::Binary(b"second-screen"[..].into())
    );
    let mut first = open_saved(port, &format!("?sid={first_id}")).await;
    assert_eq!(connected(&mut first).await, first_id);
    assert_eq!(
        next(&mut first).await,
        Message::Binary(b"first-screen"[..].into())
    );
    first
        .send(Message::Binary(b"one"[..].into()))
        .await
        .unwrap();
    second
        .send(Message::Binary(b"two"[..].into()))
        .await
        .unwrap();
    let mut actual = [0; 3];
    tokio::time::timeout(Duration::from_secs(3), first_remote.read_exact(&mut actual))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&actual, b"one");
    tokio::time::timeout(
        Duration::from_secs(3),
        second_remote.read_exact(&mut actual),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(&actual, b"two");
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    state.sessions.cleanup(first_id).await;
    state.sessions.cleanup(second_id).await;
    api.abort();
}

#[tokio::test]
async fn missing_explicit_sessions_never_create_or_borrow_a_connection() {
    let (state, port, api) = start_api().await;
    saved_host_schema(&state).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"username":"same-user","connection_type":"telnet"});
    sqlx::query("INSERT INTO hosts(id,name,hostname,port,username,connection_type) VALUES(1,'same','127.0.0.1',?,'same-user','telnet')")
        .bind(i64::from(listener.local_addr().unwrap().port())).execute(&state.db).await.unwrap();
    let mut original = open_saved(port, "").await;
    let (_remote, _) = tokio::time::timeout(Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let original_id = connected(&mut original).await;
    detach_and_wait(&state, &mut original, original_id).await;
    // Negative IDs are outside the allocator's range and unambiguously absent.
    let mut attempts = [
        open_exact_session(port, -404, "").await,
        open_saved(port, "?sid=-404").await,
        open(&state, port, target, Some(-404)).await,
    ];
    for socket in &mut attempts {
        let Message::Text(text) = next(socket).await else {
            panic!("Expected terminal error")
        };
        let error: serde_json::Value =
            serde_json::from_str(text.strip_prefix("__JSON__").unwrap()).unwrap();
        assert_eq!(error["code"], "session_unavailable");
        assert!(matches!(next(socket).await, Message::Close(_)));
    }
    assert!(state.sessions.get(-404).await.is_none());
    assert_eq!(
        state
            .sessions
            .get(original_id)
            .await
            .unwrap()
            .read()
            .await
            .state,
        ssh::manager::SessionState::Detached
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
    // An exact live session remains resumable after its saved profile is deleted.
    sqlx::query("DELETE FROM hosts WHERE id=1")
        .execute(&state.db)
        .await
        .unwrap();
    let mut resumed = open_saved(port, &format!("?sid={original_id}")).await;
    assert_eq!(connected(&mut resumed).await, original_id);
    state.sessions.cleanup(original_id).await;
    api.abort();
}

async fn assert_saved_ws_error(port: u16, message: &str, vault_locked: bool) {
    let mut socket = open_saved(port, "").await;
    let Message::Text(text) = next(&mut socket).await else {
        panic!("Expected error control")
    };
    let control: serde_json::Value =
        serde_json::from_str(text.strip_prefix("__JSON__").unwrap()).unwrap();
    assert_eq!(control["type"], "error");
    assert_eq!(control["vault_locked"], vault_locked);
    assert!(
        control["message"].as_str().unwrap().contains(message),
        "{control}"
    );
    assert!(!text.contains("do-not-disclose"));
    assert!(matches!(next(&mut socket).await, Message::Close(_)));
}

#[tokio::test]
async fn saved_websocket_rejects_unusable_credentials_and_jump_hosts_without_contacting_destination(
) {
    let (state, port, api) = start_api().await;
    saved_host_schema(&state).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    sqlx::query("INSERT INTO hosts(id,name,hostname,port,password) VALUES(1,'blocked','127.0.0.1',?,'do-not-disclose')")
        .bind(i64::from(listener.local_addr().unwrap().port())).execute(&state.db).await.unwrap();
    assert_saved_ws_error(port, "migrate this host's legacy credentials", true).await;
    vault::unlock(&state.vault, &state.db, "Wire-runtime-password")
        .await
        .unwrap();
    let (id,): (i64,) = sqlx::query_as("SELECT credential_id FROM hosts WHERE id=1")
        .fetch_one(&state.db)
        .await
        .unwrap();
    let key = vault::derive_key("Wire-runtime-password").unwrap();
    let malformed = vault::encrypt(br#"{"password":["do-not-disclose"]}"#, &key).unwrap();
    sqlx::query("UPDATE vault_items SET ciphertext=? WHERE id=?")
        .bind(malformed)
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    assert_saved_ws_error(port, "Repair or replace", false).await;
    sqlx::query("UPDATE vault_items SET ciphertext=x'00' WHERE id=?")
        .bind(id)
        .execute(&state.db)
        .await
        .unwrap();
    assert_saved_ws_error(port, "Repair or replace", false).await;
    vault::lock(&state.vault).await;
    assert_saved_ws_error(port, "Vault is locked", true).await;
    sqlx::query("INSERT INTO hosts(id,name,hostname) VALUES(2,'gateway','gateway.test'); UPDATE hosts SET jump_host_id=2 WHERE id=1")
        .execute(&state.db).await.unwrap();
    assert_saved_ws_error(port, "Jump host", false).await;
    assert!(state.sessions.is_empty().await);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
    api.abort();
}

#[tokio::test]
async fn locked_vault_allows_saved_ssh_reattach_but_blocks_a_new_connection() {
    let (state, port, api) = start_api().await;
    saved_host_schema(&state).await;
    vault::unlock(&state.vault, &state.db, "Wire-runtime-password")
        .await
        .unwrap();
    let credential_id = vault::store_secret(
        &state.vault,
        &state.db,
        "wire-test",
        br#"{"password":"test-only-password"}"#,
        None,
    )
    .await
    .unwrap();
    let (ssh_port, server) = start_ssh_server(ExecServer::default()).await;
    sqlx::query("INSERT INTO hosts(id,name,hostname,port,username,credential_id) VALUES(1,'saved','127.0.0.1',?,'test',?)")
        .bind(i64::from(ssh_port)).bind(credential_id).execute(&state.db).await.unwrap();
    let mut socket = open_saved(port, "").await;
    let sid = connected(&mut socket).await;
    socket
        .send(Message::Text("{\"type\":\"detach\"}".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while state.sessions.get(sid).await.unwrap().read().await.state
            != ssh::manager::SessionState::Detached
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    vault::lock(&state.vault).await;
    let mut reattached = open_saved(port, &format!("?sid={sid}")).await;
    assert_eq!(connected(&mut reattached).await, sid);
    reattached
        .send(Message::Binary(b"after-lock"[..].into()))
        .await
        .unwrap();
    assert_eq!(
        next(&mut reattached).await,
        Message::Binary(b"after-lock"[..].into())
    );
    state.sessions.cleanup(sid).await;
    // The vault boundary must reject a new connection before remote auth.
    assert_saved_ws_error(port, "Vault is locked", true).await;
    server.abort();
    api.abort();
}

#[tokio::test]
async fn binary_data_survives_control_markers_unicode_detach_and_reattach() {
    let (state, port, api) = start_api().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"connection_type":"telnet","cols":80,"rows":24,"term":"xterm"});
    let mut socket = open(&state, port, target.clone(), None).await;
    let (mut remote, _) = listener.accept().await.unwrap();
    let sid = connected(&mut socket).await;
    let printed =
        "Привет 🌍 __JSON__{\"type\":\"error\"}\0NETRIX_SESSION_TRANSPORT_ENDED\0text".as_bytes();
    for byte in printed {
        remote.write_all(&[*byte]).await.unwrap();
    }
    let mut output = Vec::new();
    while output.len() < printed.len() {
        match next(&mut socket).await {
            Message::Binary(bytes) => output.extend(bytes),
            other => panic!("Terminal bytes must be binary: {other:?}"),
        }
    }
    assert_eq!(output, printed);
    let input = b"{\"type\":\"terminate\"}";
    socket
        .send(Message::Binary(input[..].into()))
        .await
        .unwrap();
    let mut actual = vec![0; input.len()];
    tokio::time::timeout(Duration::from_secs(3), remote.read_exact(&mut actual))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual, input);
    socket
        .send(Message::Text("{\"type\":\"detach\"}".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if state.sessions.get(sid).await.unwrap().read().await.state
                == ssh::manager::SessionState::Detached
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let mut reattached = open(&state, port, target, Some(sid)).await;
    assert_eq!(connected(&mut reattached).await, sid);
    let mut replay = Vec::new();
    while replay.len() < printed.len() {
        if let Message::Binary(bytes) = next(&mut reattached).await {
            replay.extend(bytes);
        }
    }
    assert_eq!(replay, printed);
    reattached
        .send(Message::Text("{\"type\":\"terminate\"}".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while state.sessions.get(sid).await.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    api.abort();
}

#[tokio::test]
async fn closing_during_ssh_handshake_cancels_the_pending_connection() {
    let (state, port, api) = start_api().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"username":"test","connection_type":"ssh"});
    let mut socket = open(&state, port, target, None).await;
    let (_remote, _) = listener.accept().await.unwrap();
    socket
        .send(Message::Text("{\"type\":\"terminate\"}".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !state.sessions.is_empty().await {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    api.abort();
}
#[tokio::test]
async fn a_websocket_opened_during_restore_is_rejected_before_loading_or_connecting_a_host() {
    let (state, port, api) = start_api().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"connection_type":"telnet"});
    let lease = state.sessions.workspace_gate().write_owned().await;
    let mut socket = open(&state, port, target, None).await;
    let Message::Text(error) = next(&mut socket).await else {
        panic!("Expected restore error")
    };
    assert!(error.contains("restore is in progress"));
    assert!(state.sessions.is_empty().await);
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
    drop(lease);
    api.abort();
}

#[tokio::test]
async fn immediate_telnet_eof_is_replayed_then_reported_as_disconnected() {
    let (state, port, api) = start_api().await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = json!({"hostname":"127.0.0.1","port":listener.local_addr().unwrap().port(),"connection_type":"telnet"});
    let mut socket = open(&state, port, target, None).await;
    let (mut remote, _) = listener.accept().await.unwrap();
    remote.write_all(b"bye").await.unwrap();
    drop(remote);
    let sid = connected(&mut socket).await;
    let mut output = Vec::new();
    loop {
        match next(&mut socket).await {
            Message::Binary(bytes) => output.extend(bytes),
            Message::Text(text) => {
                let value: serde_json::Value =
                    serde_json::from_str(text.strip_prefix("__JSON__").unwrap()).unwrap();
                assert_eq!(value["type"], "disconnect");
                break;
            }
            other => panic!("Expected output or disconnect: {other:?}"),
        }
    }
    assert_eq!(output, b"bye");
    tokio::time::timeout(Duration::from_secs(3), async {
        while state.sessions.get(sid).await.is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    api.abort();
}

#[derive(Clone, Default)]
struct ExecServer {
    auth_gate: Option<std::sync::Arc<tokio::sync::Notify>>,
    auth_entered: Option<std::sync::Arc<tokio::sync::Notify>>,
    direct_channels: std::collections::HashSet<russh::ChannelId>,
    closed: Option<std::sync::Arc<tokio::sync::Notify>>,
    is_client: bool,
}
impl Drop for ExecServer {
    fn drop(&mut self) {
        if self.is_client {
            if let Some(closed) = &self.closed {
                closed.notify_one();
            }
        }
    }
}
impl russh::server::Server for ExecServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        let mut handler = self.clone();
        handler.is_client = true;
        handler
    }
}
impl russh::server::Handler for ExecServer {
    type Error = russh::Error;
    async fn auth_publickey(
        &mut self,
        user: &str,
        _: russh::server::VerifiedPublicKey<'_>,
    ) -> Result<russh::server::Auth, Self::Error> {
        Ok(if user == "test" {
            russh::server::Auth::Accept
        } else {
            russh::server::Auth::reject()
        })
    }
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: russh::server::ChannelOpenHandle,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        if host != "127.0.0.1" && host != "localhost" {
            return Ok(()); // Dropping reply rejects the request.
        }
        let Ok(mut target) = TcpStream::connect(("127.0.0.1", port as u16)).await else {
            return Ok(());
        };
        self.direct_channels.insert(channel.id());
        reply.accept().await;
        let mut stream = channel.into_stream();
        tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
        });
        Ok(())
    }
    async fn auth_password(
        &mut self,
        user: &str,
        password: &str,
    ) -> Result<russh::server::Auth, Self::Error> {
        if let Some(entered) = &self.auth_entered {
            entered.notify_one();
        }
        if let Some(gate) = &self.auth_gate {
            gate.notified().await;
        }
        Ok(if user == "test" && password == "test-only-password" {
            russh::server::Auth::Accept
        } else {
            russh::server::Auth::reject()
        })
    }
    async fn channel_open_session(
        &mut self,
        _: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
    async fn shell_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
    async fn data(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        if !self.direct_channels.contains(&channel) {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        command: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        session.data(channel, "Привет\n".as_bytes().to_vec())?;
        session.extended_data(channel, 1, b"diagnostic\n".to_vec())?;
        session.exit_status_request(channel, if command == b"fail" { 7 } else { 0 })?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }
}

async fn start_ssh_server(server: ExecServer) -> (u16, tokio::task::JoinHandle<()>) {
    let keypair = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[42; 32]);
    let key = russh::keys::PrivateKey::new(keypair.into(), "loopback-test-only").unwrap();
    start_ssh_server_with_key(server, key).await
}

async fn start_ssh_server_with_key(
    mut server: ExecServer,
    key: russh::keys::PrivateKey,
) -> (u16, tokio::task::JoinHandle<()>) {
    use russh::server::Server as _;
    let config = std::sync::Arc::new(russh::server::Config {
        keys: vec![key],
        auth_rejection_time: Duration::ZERO,
        ..Default::default()
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        server.run_on_socket(config, &listener).await.unwrap();
    });
    (port, task)
}

#[tokio::test]
async fn corrupted_known_hosts_rejects_a_real_ssh_key_and_sftp_without_rewriting_trust() {
    let (_, _, api) = start_api().await;
    let (port, server) = start_ssh_server(ExecServer::default()).await;
    let path = netrix_backend::config::SETTINGS
        .app_data_dir
        .join(format!("corrupt-known-hosts-{}", uuid::Uuid::new_v4()));
    let mut original = format!("127.0.0.1:{port} ssh-ed25519 b2xkLWtleQ==\n").into_bytes();
    original.extend_from_slice(b"# damaged comment: \xff\n");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &original).unwrap();
    let trust = ssh::known_hosts::KnownHostsStore::from_path(path.clone());
    let manager = ssh::SessionManager::with_known_hosts(trust.clone());
    let handle = manager
        .create(json!({"hostname":"127.0.0.1","port":port,
        "username":"test","password":"test-only-password","connection_type":"ssh"}))
        .await;
    let error = tokio::time::timeout(Duration::from_secs(5), manager.connect(&handle))
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.contains("trust store could not be loaded"), "{error}");
    assert!(manager.is_empty().await);

    let sftp = ssh::SftpManager::with_known_hosts(trust);
    let error = sftp
        .probe(ssh::sftp::SftpProbeTarget {
            host_id: 1,
            hostname: "127.0.0.1".into(),
            port,
            username: "test".into(),
            password: Some("test-only-password".into()),
            private_key: None,
            passphrase: None,
            connect_timeout_secs: 5,
        })
        .await
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("trust store could not be loaded"),
        "{error}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), original);
    std::fs::remove_file(path).unwrap();
    server.abort();
    api.abort();
}

#[tokio::test]
async fn http_close_releases_the_remote_ssh_connection_after_websocket_loss() {
    let (state, port, api) = start_api().await;
    let closed = std::sync::Arc::new(tokio::sync::Notify::new());
    let server_config = ExecServer {
        closed: Some(closed.clone()),
        auth_gate: None,
        auth_entered: None,
        direct_channels: Default::default(),
        is_client: false,
    };
    let (ssh_port, server) = start_ssh_server(server_config).await;
    let target = json!({"hostname":"127.0.0.1","port":ssh_port,"username":"test","password":"test-only-password","connection_type":"ssh","keepalive_interval_secs":0});
    let mut socket = open(&state, port, target, None).await;
    let sid = connected(&mut socket).await;
    drop(socket);
    assert!(delete_session_http(port, sid, true)
        .await
        .starts_with("HTTP/1.1 200"));
    // Verify the real SSH server loses its client, even with keepalive disabled.
    tokio::time::timeout(Duration::from_secs(3), closed.notified())
        .await
        .unwrap();
    assert!(state.sessions.get(sid).await.is_none());
    server.abort();
    api.abort();
}

#[tokio::test]
async fn ssh_exec_reports_real_stdout_stderr_and_exit_status_without_a_shell() {
    let (state, _, api) = start_api().await;
    let (port, server) = start_ssh_server(ExecServer::default()).await;
    let target = json!({"hostname":"127.0.0.1","port":port,"username":"test","password":"test-only-password"});
    for (command, expected) in [("fail", 7), ("ok", 0)] {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            state.sessions.execute_ssh(&target, command, 1024),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(String::from_utf8(result.stdout).unwrap(), "Привет\n");
        assert_eq!(result.stderr, b"diagnostic\n");
        assert_eq!(result.exit_status, Some(expected));
        assert_eq!(result.error.is_some(), expected != 0);
        assert!(!result.timed_out);
    }
    server.abort();
    api.abort();
}

#[tokio::test]
async fn generated_ed25519_and_rsa_keys_authenticate_with_encrypted_openssh_private_keys() {
    let (state, _, api) = start_api().await;
    let (port, server) = start_ssh_server(ExecServer::default()).await;
    for algorithm in [
        russh::keys::ssh_key::Algorithm::Ed25519,
        russh::keys::ssh_key::Algorithm::Rsa { hash: None },
    ] {
        let private = tokio::task::spawn_blocking(move || {
            let mut rng = rand_latest::rng();
            russh::keys::PrivateKey::random(&mut rng, algorithm)
                .unwrap()
                .encrypt(&mut rng, "test-key-passphrase")
                .unwrap()
                .to_openssh(russh::keys::ssh_key::LineEnding::LF)
                .unwrap()
        })
        .await
        .unwrap();
        let target = json!({"hostname":"127.0.0.1","port":port,"username":"test","private_key":private.as_str(),"passphrase":"test-key-passphrase"});
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            state.sessions.execute_ssh(&target, "ok", 1024),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result.exit_status, Some(0));
        assert!(result.error.is_none());
    }
    server.abort();
    api.abort();
}

#[tokio::test]
async fn patched_rsa_preserves_pkcs8_authentication_and_strict_host_keys() {
    let (state, _, api) = start_api().await;
    let key = tokio::task::spawn_blocking(|| {
        russh::keys::PrivateKey::random(
            &mut rand_latest::rng(),
            russh::keys::ssh_key::Algorithm::Rsa { hash: None },
        )
        .unwrap()
    })
    .await
    .unwrap();
    let mut plain = Vec::new();
    let mut encrypted = Vec::new();
    russh::keys::encode_pkcs8_pem(&key, &mut plain).unwrap();
    russh::keys::encode_pkcs8_pem_encrypted(
        &key,
        "test-passphrase".as_bytes(),
        10_000,
        &mut encrypted,
    )
    .unwrap();
    let plain = String::from_utf8(plain).unwrap();
    let encrypted = String::from_utf8(encrypted).unwrap();
    assert_eq!(
        russh::keys::decode_secret_key(&plain, None)
            .unwrap()
            .public_key(),
        key.public_key()
    );
    assert_eq!(
        russh::keys::decode_secret_key(&encrypted, Some("test-passphrase"))
            .unwrap()
            .public_key(),
        key.public_key()
    );
    assert!(russh::keys::decode_secret_key(&encrypted, Some("wrong-passphrase")).is_err());
    let (port, server) = start_ssh_server_with_key(ExecServer::default(), key).await;
    let target = json!({"hostname":"127.0.0.1","port":port,"username":"test","private_key":encrypted,"passphrase":"test-passphrase"});
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        state.sessions.execute_ssh(&target, "ok", 1024),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.exit_status, Some(0));
    let trust = state.sessions.known_hosts();
    let accepted = trust.list().await.unwrap();
    assert!(accepted[0].1.starts_with("ssh-rsa "));
    assert!(trust
        .forget("127.0.0.1", port, &accepted[0].1)
        .await
        .unwrap());
    trust
        .check("127.0.0.1", port, "ssh-rsa", b"different-test-host-key")
        .await;
    let original = trust.list().await.unwrap();
    let error = tokio::time::timeout(
        Duration::from_secs(5),
        state.sessions.execute_ssh(&target, "ok", 1024),
    )
    .await
    .unwrap()
    .unwrap_err();
    assert!(error.to_lowercase().contains("key"), "{error}");
    assert_eq!(
        trust.list().await.unwrap(),
        original,
        "A changed RSA server key must never replace stored trust"
    );
    server.abort();
    api.abort();
}

#[tokio::test]
async fn input_sent_during_authentication_is_preserved_until_the_shell_is_ready() {
    let (state, port, api) = start_api().await;
    let gate = std::sync::Arc::new(tokio::sync::Notify::new());
    let (ssh_port, server) = start_ssh_server(ExecServer {
        auth_gate: Some(gate.clone()),
        auth_entered: None,
        closed: None,
        direct_channels: Default::default(),
        is_client: false,
    })
    .await;
    let target = json!({"hostname":"127.0.0.1","port":ssh_port,"username":"test","password":"test-only-password","connection_type":"ssh"});
    let mut socket = open(&state, port, target, None).await;
    let input = "Привет {\"type\":\"terminate\"}".as_bytes();
    socket.send(Message::Binary(input.into())).await.unwrap();
    socket
        .send(Message::Text(
            "{\"type\":\"heartbeat\",\"sent_at\":123}".into(),
        ))
        .await
        .unwrap();
    // The heartbeat proves the preceding input frame was processed while auth
    // was blocked; releasing the gate now cannot hide an early-input regression.
    let Message::Text(pong) = next(&mut socket).await else {
        panic!("Expected heartbeat during auth")
    };
    assert!(pong.contains("\"type\":\"pong\""));
    gate.notify_one();
    let sid = connected(&mut socket).await;
    let mut echo = Vec::new();
    while echo.len() < input.len() {
        let Message::Binary(bytes) = next(&mut socket).await else {
            panic!("Expected binary echo")
        };
        echo.extend(bytes);
    }
    assert_eq!(echo, input);
    state.sessions.cleanup(sid).await;
    server.abort();
    api.abort();
}

#[tokio::test]
async fn stop_and_deletion_cancel_pending_tunnels_without_stopping_other_hosts() {
    use axum::{body::Body, http::Request};
    use netrix_backend::ssh::tunnels::TunnelRule;
    use std::sync::Arc;
    use tokio::sync::Notify;
    use tower::ServiceExt;

    for operation in ["stop", "delete-rule", "delete-host"] {
        let (state, _, api) = start_api().await;
        saved_host_schema(&state).await;
        let entered = Arc::new(Notify::new());
        let gate = Arc::new(Notify::new());
        let closed = Arc::new(Notify::new());
        let (ssh_port, server) = start_ssh_server(ExecServer {
            auth_gate: Some(gate.clone()),
            auth_entered: Some(entered.clone()),
            closed: Some(closed.clone()),
            direct_channels: Default::default(),
            is_client: false,
        })
        .await;
        let reservation = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_port = reservation.local_addr().unwrap().port();
        drop(reservation);
        sqlx::query("INSERT INTO hosts(id,name,hostname,port,username,password) VALUES(1,'pending','127.0.0.1',?,'test','test-only-password')")
            .bind(i64::from(ssh_port)).execute(&state.db).await.unwrap();
        vault::unlock(&state.vault, &state.db, "Pending-tunnel-test-password")
            .await
            .unwrap();
        sqlx::query("INSERT INTO ssh_tunnels(id,name,host_id,kind,bind_port) VALUES('pending','pending',1,'dynamic',?)")
            .bind(i64::from(local_port)).execute(&state.db).await.unwrap();
        let app = routers::tunnels::router()
            .merge(routers::hosts::router())
            .with_state(state.clone());
        let pending_app = app.clone();
        let pending = tokio::spawn(async move {
            pending_app
                .oneshot(
                    Request::post("/tunnels/pending/start")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        assert!(
            !state.sessions.tunnels().is_empty().await,
            "Connecting jobs reserve their slot"
        );

        let (other_port, other_server) = start_ssh_server(ExecServer::default()).await;
        let other_rule = TunnelRule {
            id: "other".into(),
            name: "other".into(),
            host_id: 2,
            kind: "dynamic".into(),
            bind_port: 0,
            destination_host: None,
            destination_port: None,
        };
        let other_target = json!({"hostname":"127.0.0.1","port":other_port,"username":"test","password":"test-only-password"});
        let other_local = tokio::time::timeout(
            Duration::from_secs(5),
            state
                .sessions
                .tunnels()
                .start(&state.sessions, other_rule, other_target),
        )
        .await
        .unwrap()
        .unwrap();
        let request = match operation {
            "stop" => Request::post("/tunnels/pending/stop"),
            "delete-rule" => Request::delete("/tunnels/pending"),
            _ => Request::delete("/hosts/1"),
        }
        .body(Body::empty())
        .unwrap();
        let response = tokio::time::timeout(Duration::from_secs(5), app.clone().oneshot(request))
            .await
            .unwrap()
            .unwrap();
        assert!(
            response.status().is_success(),
            "{operation}: {}",
            response.status()
        );
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(5), pending)
                .await
                .unwrap()
                .unwrap()
                .status(),
            axum::http::StatusCode::BAD_REQUEST
        );
        gate.notify_one();
        tokio::time::timeout(Duration::from_secs(5), closed.notified())
            .await
            .unwrap();
        assert_eq!(state.sessions.tunnels().status("pending").await, None);
        let released = TcpListener::bind(("127.0.0.1", local_port)).await.unwrap();
        assert_eq!(
            state.sessions.tunnels().status("other").await,
            Some(other_local)
        );
        if operation != "stop" {
            let response = app
                .oneshot(
                    Request::post("/tunnels/pending/start")
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        }
        assert!(state.sessions.tunnels().stop("other").await);
        assert!(state.sessions.tunnels().is_empty().await);
        drop(released);
        server.abort();
        other_server.abort();
        api.abort();
    }
}

#[tokio::test]
async fn local_and_socks_tunnels_forward_real_tcp_and_stop_closes_clients_and_ports() {
    use netrix_backend::ssh::tunnels::TunnelRule;
    let (state, _, api) = start_api().await;
    let (ssh_port, server) = start_ssh_server(ExecServer::default()).await;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let echo_port = listener.local_addr().unwrap().port();
    let echo = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut read, mut write) = socket.split();
                let _ = tokio::io::copy(&mut read, &mut write).await;
            });
        }
    });
    let target = json!({"hostname":"127.0.0.1","port":ssh_port,"username":"test","password":"test-only-password"});
    for kind in ["local", "dynamic"] {
        let rule = TunnelRule {
            id: kind.into(),
            name: "test".into(),
            host_id: 1,
            kind: kind.into(),
            bind_port: 0,
            destination_host: Some("127.0.0.1".into()),
            destination_port: Some(i64::from(echo_port)),
        };
        let port = state
            .sessions
            .tunnels()
            .start(&state.sessions, rule, target.clone())
            .await
            .unwrap();
        assert!(
            state.sessions.is_empty().await,
            "Tunnels must not allocate interactive sessions"
        );
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        if kind == "dynamic" {
            socket.write_all(&[5, 1, 0]).await.unwrap();
            let mut greeting = [0; 2];
            socket.read_exact(&mut greeting).await.unwrap();
            assert_eq!(greeting, [5, 0]);
            let mut connect = vec![5, 1, 0, 3, 9];
            connect.extend_from_slice(b"localhost");
            connect.extend_from_slice(&echo_port.to_be_bytes());
            socket.write_all(&connect).await.unwrap();
            let mut reply = [0; 10];
            tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut reply))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(reply[1], 0);
        }
        let data = "tunnel Привет 🌍".as_bytes();
        socket.write_all(data).await.unwrap();
        let mut echoed = vec![0; data.len()];
        tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut echoed))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(echoed, data);
        assert!(state.sessions.tunnels().stop(kind).await);
        let mut byte = [0];
        let end = tokio::time::timeout(Duration::from_secs(3), socket.read(&mut byte))
            .await
            .unwrap();
        assert!(
            matches!(end, Ok(0) | Err(_)),
            "Stopped tunnels close existing streams"
        );
        assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    }
    assert!(state.sessions.tunnels().is_empty().await);
    echo.abort();
    server.abort();
    api.abort();
}
