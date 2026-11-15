/// WebSocket terminal endpoints.
///
/// - `/ws/terminal/{host_id}`: connect to a saved host profile
/// - `/ws/quick-connect`: connect using an ephemeral one-time ticket
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Path, Query, State, WebSocketUpgrade};
use axum::http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderMap};
use axum::response::IntoResponse;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use tokio::sync::broadcast;
use tracing::{error, info, warn};

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::Host;
use crate::ssh::manager::{SessionEvent, SessionHandle, SessionReplay};
use crate::ssh::saved_host;
use futures::{Sink, SinkExt, Stream, StreamExt};
use std::time::Duration;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/sessions/quick-connect-tickets",
            post(create_quick_connect_ticket),
        )
        .route("/sessions/{session_id}", delete(delete_session))
        .route("/ws/terminal/{host_id}", get(ws_upgrade))
        .route("/ws/quick-connect", get(ws_quick_upgrade))
        .route("/ws/sessions/{session_id}", get(ws_resume_upgrade))
}

#[derive(Deserialize)]
struct ResumeQuery {
    after: Option<u64>,
}

/// Reattachment is resume-only: it cannot load credentials or create a
/// replacement connection, even if the saved host was edited/deleted meanwhile.
async fn ws_resume_upgrade(
    State(st): State<AppState>,
    Path(session_id): Path<i64>,
    Query(q): Query<ResumeQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ws = ws.max_message_size(1024 * 1024).max_frame_size(1024 * 1024);
    let ws = if supports_netrix_protocol(&headers) {
        ws.protocols(["netrix.v1"])
    } else {
        ws
    };
    ws.on_upgrade(move |mut socket| async move {
        let Ok(guard) = st.sessions.workspace_gate().try_read_owned() else {
            send_ws_error_and_close(&mut socket, "Workspace restore is in progress.", false).await;
            return;
        };
        resume_ws_session(socket, st, session_id, q.after, guard).await;
    })
}

async fn resume_ws_session(
    mut ws: WebSocket,
    st: AppState,
    session_id: i64,
    after: Option<u64>,
    workspace_guard: tokio::sync::OwnedRwLockReadGuard<()>,
) {
    let Some(handle) = st.sessions.get(session_id).await else {
        send_session_unavailable(&mut ws).await;
        return;
    };
    st.sessions.attach_client(&handle).await;
    drop(workspace_guard);
    if !st.sessions.resume_live(&handle).await {
        send_session_unavailable(&mut ws).await;
        st.sessions.finish_client(&handle, false).await;
        return;
    }
    let terminate = bridge_ws_session(&mut ws, &st, &handle, session_id, after, false).await;
    st.sessions.finish_client(&handle, terminate).await;
}

async fn send_session_unavailable(ws: &mut WebSocket) {
    let payload = serde_json::json!({
        "type": "error", "code": "session_unavailable", "vault_locked": false,
        "message": "This terminal session has ended or is no longer available. Start a new session to reconnect.",
    });
    let _ = send_frame(ws, Message::Text(format!("__JSON__{payload}").into())).await;
    let _ = send_frame(ws, Message::Close(None)).await;
}

#[derive(Deserialize)]
struct WsQuery {
    #[serde(default = "default_cols")]
    cols: u32,
    #[serde(default = "default_rows")]
    rows: u32,
    #[serde(default = "default_term")]
    term: String,
    #[serde(default = "default_connect_timeout_secs")]
    timeout: u64,
    #[serde(default = "default_keepalive_interval_secs")]
    keepalive: u64,
    sid: Option<i64>,
}

#[derive(Deserialize)]
struct QuickWsQuery {
    ticket: Option<String>,
    #[serde(flatten)]
    params: QuickConnectParams,
}

#[derive(Debug, Clone, Deserialize)]
struct QuickConnectParams {
    hostname: Option<String>,
    #[serde(default)]
    port: u16,
    username: Option<String>,
    password: Option<String>,
    key: Option<String>,
    private_key: Option<String>,
    passphrase: Option<String>,
    #[serde(rename = "type", default = "default_ssh")]
    connection_type: String,
    serial_port: Option<String>,
    serial_speed: Option<u32>,
    local_command: Option<String>,
    /// JSON-encoded array of argv strings.
    local_args: Option<String>,
    local_cwd: Option<String>,
    #[serde(default = "default_cols")]
    cols: u32,
    #[serde(default = "default_rows")]
    rows: u32,
    #[serde(default = "default_term")]
    term: String,
    #[serde(default = "default_connect_timeout_secs")]
    timeout: u64,
    #[serde(default = "default_keepalive_interval_secs")]
    keepalive: u64,
    sid: Option<i64>,
}

fn default_cols() -> u32 {
    80
}
fn default_rows() -> u32 {
    24
}
fn default_term() -> String {
    "xterm-256color".into()
}
fn default_ssh() -> String {
    "ssh".into()
}
fn default_connect_timeout_secs() -> u64 {
    20
}
fn default_keepalive_interval_secs() -> u64 {
    10
}

fn sanitize_connect_timeout_secs(secs: u64) -> u64 {
    secs.clamp(5, 120)
}

fn sanitize_keepalive_interval_secs(secs: u64) -> u64 {
    secs.min(300)
}

fn resolve_saved_connection_type(raw: &str, port: i64) -> String {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "ssh" | "telnet" | "serial" | "local" => normalized,
        _ => {
            if port == 23 {
                "telnet".into()
            } else {
                "ssh".into()
            }
        }
    }
}

fn supports_netrix_protocol(headers: &HeaderMap) -> bool {
    headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|v| v.to_str().ok())
        .map(|raw| raw.split(',').any(|p| p.trim() == "netrix.v1"))
        .unwrap_or(false)
}

fn user_facing_connect_error(raw: &str) -> String {
    let normalized = raw.replace(['\n', '\r'], " ").trim().to_string();
    if normalized.is_empty() {
        return "unknown error".into();
    }

    let lower = normalized.to_ascii_lowercase();
    if lower.contains("host key mismatch") {
        return "SSH host key mismatch detected. Host key may have changed. Remove the stale key entry and reconnect.".into();
    }
    if lower.contains("authentication failed") {
        return "Authentication failed. Verify username, password/private key, and passphrase."
            .into();
    }
    if lower.contains("connection refused") {
        return "TCP connection refused. Verify SSH service is running and the port is correct."
            .into();
    }
    if lower.contains("timed out") {
        return "Connection timed out. Host is reachable but SSH port may be blocked or filtered."
            .into();
    }
    if lower.contains("no route to host")
        || lower.contains("network route")
        || lower.contains("network is unreachable")
    {
        return "Network route to host is unavailable. Check VPN, routing, and firewall rules."
            .into();
    }
    if lower.contains("circuit-breaker blocked") {
        return "Connection temporarily blocked after repeated failures. Wait and retry.".into();
    }

    if normalized.chars().count() > 220 {
        format!("{}...", normalized.chars().take(220).collect::<String>())
    } else {
        normalized
    }
}

fn quick_connect_has_query_credentials(params: &QuickConnectParams) -> bool {
    params.password.is_some()
        || params.key.is_some()
        || params.private_key.is_some()
        || params.passphrase.is_some()
}

fn build_quick_connect_target(
    params: QuickConnectParams,
) -> Result<(serde_json::Value, Option<i64>), String> {
    let QuickConnectParams {
        hostname,
        port,
        username,
        password,
        key,
        private_key,
        passphrase,
        connection_type,
        serial_port,
        serial_speed,
        local_command,
        local_args,
        local_cwd,
        cols,
        rows,
        term,
        timeout,
        keepalive,
        sid,
    } = params;

    let conn_type = connection_type.to_ascii_lowercase();
    if !["ssh", "telnet", "serial", "local"].contains(&conn_type.as_str()) {
        return Err(
            "Invalid connection type. Supported values: ssh, telnet, serial, local.".into(),
        );
    }

    let serial_port = serial_port
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let hostname = hostname.map(|s| s.trim().to_string()).unwrap_or_default();

    if conn_type == "serial" {
        if serial_port.is_none() {
            return Err("serial_port is required for serial quick connect".into());
        }
    } else if conn_type == "local" {
        // Local shell needs neither hostname nor port; the command (if
        // any) is validated by `local_pty::spawn` at connect time.
    } else if hostname.is_empty() {
        return Err("hostname is required for quick connect".into());
    }

    let resolved_port = match conn_type.as_str() {
        "serial" | "local" => 0,
        "telnet" => {
            if port == 0 {
                23
            } else {
                port
            }
        }
        _ => {
            if port == 0 {
                22
            } else {
                port
            }
        }
    };

    let resolved_username = if conn_type == "serial" || conn_type == "local" {
        None
    } else {
        username
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .or_else(|| Some("user".to_string()))
    };

    let resolved_private_key = key.or(private_key);

    // Parse local_args from JSON string into a Value for host_info.
    let parsed_local_args: serde_json::Value = local_args
        .as_deref()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| v.is_array())
        .unwrap_or(serde_json::Value::Array(vec![]));

    let display_hostname: String = match conn_type.as_str() {
        "serial" | "local" => "localhost".to_string(),
        _ => hostname.clone(),
    };

    let host_info = serde_json::json!({
        "hostname": display_hostname,
        "port": resolved_port,
        "username": resolved_username,
        "password": password,
        "private_key": resolved_private_key,
        "passphrase": passphrase,
        "connection_type": conn_type,
        "serial_port": serial_port,
        "serial_speed": serial_speed.unwrap_or(9600),
        "local_command": local_command,
        "local_args": parsed_local_args,
        "local_cwd": local_cwd,
        "cols": cols,
        "rows": rows,
        "term": term,
        "connect_timeout_secs": sanitize_connect_timeout_secs(timeout),
        "keepalive_interval_secs": sanitize_keepalive_interval_secs(keepalive),
    });

    Ok((host_info, sid))
}

async fn create_quick_connect_ticket(
    State(st): State<AppState>,
    Json(params): Json<QuickConnectParams>,
) -> AppResult<Json<serde_json::Value>> {
    let (host_info, sid) = build_quick_connect_target(params).map_err(AppError::BadRequest)?;
    let (ticket, expires_in_secs) = st.quick_connect_tickets.issue(host_info, sid).await;

    Ok(Json(serde_json::json!({
        "ticket": ticket,
        "expires_in_secs": expires_in_secs,
    })))
}

async fn delete_session(
    State(st): State<AppState>,
    Path(session_id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let terminated = st.sessions.cleanup(session_id).await;
    if st.sessions.get(session_id).await.is_some() {
        return Err(AppError::Internal("Terminal cleanup did not finish".into()));
    }
    Ok(Json(serde_json::json!({
        "ok": true,
        "terminated": terminated,
    })))
}

async fn send_ws_error_and_close<S: Sink<Message> + Unpin>(
    ws: &mut S,
    message: &str,
    vault_locked: bool,
) {
    let payload = serde_json::json!({
        "type": "error",
        "message": message,
        "vault_locked": vault_locked,
    });
    let _ = send_frame(ws, Message::Text(format!("__JSON__{payload}").into())).await;
    let _ = send_frame(ws, Message::Close(None)).await;
}

async fn send_ws_disconnect_and_close<S: Sink<Message> + Unpin>(ws: &mut S, message: &str) {
    let payload = serde_json::json!({
        "type": "disconnect",
        "message": message,
    });
    let _ = send_frame(ws, Message::Text(format!("__JSON__{payload}").into())).await;
    let _ = send_frame(ws, Message::Close(None)).await;
}

async fn run_ws_session(
    mut ws: WebSocket,
    st: AppState,
    host_info: serde_json::Value,
    workspace_guard: tokio::sync::OwnedRwLockReadGuard<()>,
) {
    let handle = st.sessions.create(host_info).await;
    let session_id = handle.read().await.id;
    // Count clients while connecting too: cancelling one window must not remove
    // a session that another window is still opening.
    st.sessions.attach_client(&handle).await;
    drop(workspace_guard);
    let mut pending_input = Vec::new();
    let input_revision = st.security.revision();

    let connect_result = {
        let connection = st.sessions.connect(&handle);
        tokio::pin!(connection);
        loop {
            tokio::select! {
                result = &mut connection => break Some(result),
                incoming = ws.recv() => match incoming {
                    Some(Ok(Message::Binary(data))) => {
                        if st.security.is_locked() { pending_input.clear(); continue; }
                        if pending_input.len() + data.len() > 64 * 1024 {
                            send_ws_error_and_close(&mut ws, "Too much terminal input before the connection is ready.", false).await;
                            break None;
                        }
                        pending_input.extend_from_slice(&data);
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(control) = serde_json::from_str::<TerminalControl>(&text) {
                            if st.security.is_locked() && matches!(control, TerminalControl::Terminate | TerminalControl::Resize { .. }) { continue; }
                            match control {
                                TerminalControl::Terminate => break None,
                                TerminalControl::Detach => break None,
                                TerminalControl::Heartbeat { sent_at } => {
                                    let reply = format!("__JSON__{}", serde_json::json!({"type":"pong", "sent_at":sent_at}));
                                    if !send_frame(&mut ws, Message::Text(reply.into())).await { break None; }
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                    _ => {}
                }
            }
        }
    };
    let Some(result) = connect_result else {
        // No client knows this new session ID yet: never leave it detached.
        st.sessions.finish_client(&handle, true).await;
        return;
    };
    if let Err(err_msg) = result {
        send_ws_error_and_close(
            &mut ws,
            &format!("Connection failed: {}", user_facing_connect_error(&err_msg)),
            false,
        )
        .await;
        info!("[WS {session_id}] connection failed");
        st.sessions.finish_client(&handle, true).await;
        return;
    }
    if st.security.is_locked() || st.security.revision() != input_revision {
        pending_input.clear();
    }
    if !pending_input.is_empty()
        && !matches!(
            tokio::time::timeout(
                Duration::from_secs(10),
                st.sessions.write(&handle, &pending_input)
            )
            .await,
            Ok(Ok(()))
        )
    {
        send_ws_disconnect_and_close(&mut ws, "Remote terminal session is not accepting input.")
            .await;
        st.sessions.finish_client(&handle, true).await;
        return;
    }
    run_attached_bridge(&mut ws, &st, &handle, session_id, true).await;
}

pub(crate) async fn run_attached_bridge<S>(
    ws: &mut S,
    st: &AppState,
    handle: &SessionHandle,
    session_id: i64,
    require_ready: bool,
) where
    S: Sink<Message> + Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let terminate = bridge_ws_session(ws, st, handle, session_id, None, require_ready).await;
    st.sessions.finish_client(handle, terminate).await;
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum TerminalControl {
    Ready { session_id: i64 },
    Resize { cols: u32, rows: u32 },
    Heartbeat { sent_at: Option<u64> },
    Detach,
    Terminate,
}

async fn send_frame<S: Sink<Message> + Unpin>(ws: &mut S, frame: Message) -> bool {
    matches!(
        tokio::time::timeout(Duration::from_secs(10), ws.send(frame)).await,
        Ok(Ok(()))
    )
}

/// Describe the transport snapshot, never a freshly read saved profile. Keep
/// this allowlist explicit: host_info also contains private connection inputs.
fn connection_descriptor(host_info: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "hostname": host_info["hostname"].as_str().unwrap_or_default(),
        "port": host_info["port"].as_u64().unwrap_or(22),
        "username": host_info["username"].as_str().unwrap_or_default(),
        "connection_type": host_info["connection_type"].as_str().unwrap_or("ssh"),
        "serial_port": host_info["serial_port"],
        "serial_speed": host_info["serial_speed"],
        "local_command": host_info["local_command"],
        "local_args": host_info["local_args"],
        "local_cwd": host_info["local_cwd"],
    })
}

/// Attachment cleanup belongs to the caller and covers every early return.
async fn bridge_ws_session<S>(
    ws: &mut S,
    st: &AppState,
    handle: &SessionHandle,
    session_id: i64,
    after: Option<u64>,
    require_ready: bool,
) -> bool
where
    S: Sink<Message> + Stream<Item = Result<Message, axum::Error>> + Unpin,
{
    let replay = {
        let session = handle.read().await;
        session.subscribe_after(after).map(|replay| {
            (
                replay,
                session.end_reason.clone(),
                connection_descriptor(&session.host_info),
            )
        })
    };
    let (
        SessionReplay {
            history,
            receiver: mut rx,
            start,
            end,
        },
        ended,
        connection,
    ) = match replay {
        Ok(replay) => replay,
        Err(message) => {
            send_ws_error_and_close(ws, message, false).await;
            return require_ready;
        }
    };
    let connect = format!(
        "__JSON__{}",
        serde_json::json!({"type":"connect", "session_id":session_id, "connection":connection})
    );
    if !send_frame(ws, Message::Text(connect.into())).await {
        return require_ready;
    }
    // A freshly created transport is resumable only once its owner has received
    // the ID. Closing during initialization must not orphan an unknown session.
    if require_ready {
        let mut pending_input = Vec::new();
        let input_revision = st.security.revision();
        let acknowledged = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match ws.next().await {
                    Some(Ok(Message::Binary(data))) => {
                        if st.security.is_locked() {
                            pending_input.clear();
                            continue;
                        }
                        if pending_input.len() + data.len() > 64 * 1024 {
                            return false;
                        }
                        pending_input.extend_from_slice(&data);
                    }
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<TerminalControl>(&text) {
                            Ok(TerminalControl::Ready { session_id: id }) => {
                                return id == session_id
                            }
                            Ok(
                                TerminalControl::Heartbeat { .. } | TerminalControl::Resize { .. },
                            ) => {}
                            _ => return false,
                        }
                    }
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                    _ => return false,
                }
            }
        })
        .await;
        if !matches!(acknowledged, Ok(true)) {
            return true;
        }
        if st.security.is_locked() || st.security.revision() != input_revision {
            pending_input.clear();
        }
        if !pending_input.is_empty() && st.sessions.write(handle, &pending_input).await.is_err() {
            return true;
        }
    }
    if !send_frame(
        ws,
        Message::Text(
            format!(
                "__JSON__{}",
                serde_json::json!({"type":"replay_start", "offset":start})
            )
            .into(),
        ),
    )
    .await
    {
        return false;
    }
    for chunk in history {
        if !send_frame(ws, Message::Binary(chunk)).await {
            return false;
        }
    }
    if after.is_some()
        && !send_frame(
            ws,
            Message::Text(
                format!(
                    "__JSON__{}",
                    serde_json::json!({"type":"replay_end", "offset":end})
                )
                .into(),
            ),
        )
        .await
    {
        return false;
    }
    if let Some(reason) = ended {
        send_ws_disconnect_and_close(ws, &reason).await;
        return false;
    }
    loop {
        tokio::select! {
            event = rx.recv() => match event {
                Ok(SessionEvent::Data(data)) => {
                    if !send_frame(ws, Message::Binary(data)).await { return false; }
                }
                Ok(SessionEvent::Ended(reason)) => {
                    send_ws_disconnect_and_close(ws, &reason).await;
                    return false;
                }
                Err(broadcast::error::RecvError::Closed) => return false,
                Err(broadcast::error::RecvError::Lagged(count)) => {
                    let warning = format!("__JSON__{}", serde_json::json!({"type":"output_gap", "chunks":count}));
                    if !send_frame(ws, Message::Text(warning.into())).await { return false; }
                }
            },
            incoming = ws.next() => match incoming {
                Some(Ok(Message::Binary(data))) => {
                    // Discard input while locked; never replay it on unlock.
                    if st.security.is_locked() { continue; }
                    if st.sessions.write(handle, &data).await.is_err() {
                        send_ws_disconnect_and_close(ws, "Remote terminal session is no longer accepting input.").await;
                        return false;
                    }
                }
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<TerminalControl>(&text) {
                    Ok(TerminalControl::Ready { session_id: id }) if id == session_id => {},
                    Ok(TerminalControl::Terminate) if st.security.is_locked() => {},
                    Ok(TerminalControl::Terminate) => return true,
                    Ok(TerminalControl::Detach) => return false,
                    Ok(TerminalControl::Resize { .. }) if st.security.is_locked() => {},
                    Ok(TerminalControl::Resize { cols, rows }) if (1..=4096).contains(&cols) && (1..=4096).contains(&rows) => {
                        let _ = st.sessions.resize(handle, cols, rows).await;
                    }
                    Ok(TerminalControl::Heartbeat { sent_at }) => {
                        let reply = format!("__JSON__{}", serde_json::json!({"type":"pong", "sent_at":sent_at}));
                        if !send_frame(ws, Message::Text(reply.into())).await { return false; }
                    }
                    _ => {
                        send_ws_error_and_close(ws, "Invalid terminal control. Update the app and reconnect.", false).await;
                        return false;
                    }
                },
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => return false,
                _ => {}
            }
        }
    }
}

async fn ws_upgrade(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
    Query(q): Query<WsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ws = ws.max_message_size(1024 * 1024).max_frame_size(1024 * 1024);
    let ws = if supports_netrix_protocol(&headers) {
        ws.protocols(["netrix.v1"])
    } else {
        ws
    };
    ws.on_upgrade(move |socket| handle_host_ws(socket, st, host_id, q))
}

async fn ws_quick_upgrade(
    State(st): State<AppState>,
    Query(q): Query<QuickWsQuery>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let ws = ws.max_message_size(1024 * 1024).max_frame_size(1024 * 1024);
    let ws = if supports_netrix_protocol(&headers) {
        ws.protocols(["netrix.v1"])
    } else {
        ws
    };
    ws.on_upgrade(move |socket| handle_quick_ws(socket, st, q))
}

async fn handle_host_ws(mut ws: WebSocket, st: AppState, host_id: i64, q: WsQuery) {
    let Ok(workspace_guard) = st.sessions.workspace_gate().try_read_owned() else {
        send_ws_error_and_close(
            &mut ws,
            "Workspace restore is in progress. Refresh the host list and reconnect.",
            false,
        )
        .await;
        return;
    };
    if let Some(sid) = q.sid {
        resume_ws_session(ws, st, sid, None, workspace_guard).await;
        return;
    }
    let host = match sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
        .bind(host_id)
        .fetch_optional(&st.db)
        .await
    {
        Ok(Some(h)) => h,
        Ok(None) => {
            warn!("[WS host={host_id}] Host not found");
            send_ws_error_and_close(&mut ws, "Host not found", false).await;
            return;
        }
        Err(e) => {
            error!("[WS host={host_id}] Database error: {e}");
            send_ws_error_and_close(&mut ws, "Database error", false).await;
            return;
        }
    };

    let mut credentials = match saved_host::load_credentials(&st, &host).await {
        Ok(credentials) => credentials,
        Err(error) => {
            let vault_locked = matches!(&error, AppError::Unauthorized(_));
            send_ws_error_and_close(&mut ws, &error.to_string(), vault_locked).await;
            return;
        }
    };

    let conn_type = resolve_saved_connection_type(&host.connection_type, host.port);
    if conn_type != host.connection_type.to_ascii_lowercase() {
        warn!(
            "[WS host={host_id}] Unsupported/empty connection_type '{}' for port {}. Falling back to '{}'.",
            host.connection_type,
            host.port,
            conn_type
        );
    }

    let host_info = serde_json::json!({
        "hostname": host.hostname,
        "port": host.port,
        "username": host.username,
        "password": credentials.password.take(),
        "private_key": credentials.private_key.take(),
        "passphrase": credentials.passphrase.take(),
        "connection_type": conn_type,
        "serial_port": host.serial_port,
        "serial_speed": host.serial_speed,
        "local_command": host.local_command,
        "local_args": host
            .local_args
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .unwrap_or(serde_json::Value::Array(vec![])),
        "local_cwd": host.local_cwd,
        "cols": q.cols,
        "rows": q.rows,
        "term": q.term,
        "connect_timeout_secs": sanitize_connect_timeout_secs(q.timeout),
        "keepalive_interval_secs": sanitize_keepalive_interval_secs(q.keepalive),
    });

    run_ws_session(ws, st, host_info, workspace_guard).await;
}

async fn handle_quick_ws(mut ws: WebSocket, st: AppState, q: QuickWsQuery) {
    let Ok(workspace_guard) = st.sessions.workspace_gate().try_read_owned() else {
        send_ws_error_and_close(
            &mut ws,
            "Workspace restore is in progress. Refresh the host list and reconnect.",
            false,
        )
        .await;
        return;
    };
    let (host_info, sid) = if let Some(ticket) = q.ticket {
        match st.quick_connect_tickets.consume(&ticket).await {
            Some(stored) => (stored.host_info, stored.sid),
            None => {
                warn!("[WS quick-connect] Missing or expired ticket");
                send_ws_error_and_close(
                    &mut ws,
                    "Quick-connect ticket is missing, expired, or already used. Start the connection again.",
                    false,
                )
                .await;
                return;
            }
        }
    } else {
        if quick_connect_has_query_credentials(&q.params) {
            warn!("[WS quick-connect] Rejected credentials in query string");
            send_ws_error_and_close(
                &mut ws,
                "Quick-connect credentials must be sent through a one-time ticket, not the WebSocket URL.",
                false,
            )
            .await;
            return;
        }

        match build_quick_connect_target(q.params) {
            Ok(target) => target,
            Err(message) => {
                send_ws_error_and_close(&mut ws, &message, false).await;
                return;
            }
        }
    };

    if let Some(sid) = sid {
        resume_ws_session(ws, st, sid, None, workspace_guard).await;
    } else {
        run_ws_session(ws, st, host_info, workspace_guard).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn connection_descriptor_never_serializes_private_session_inputs() {
        let info = serde_json::json!({
            "hostname":"router.test", "port":2222, "username":"operator",
            "connection_type":"ssh", "password":"secret", "private_key":"secret",
            "passphrase":"secret", "jump_host":{"password":"secret"}, "future_secret":"secret",
        });
        let descriptor = connection_descriptor(&info);
        assert_eq!(descriptor["hostname"], "router.test");
        assert_eq!(descriptor["port"], 2222);
        assert_eq!(descriptor["username"], "operator");
        assert_eq!(descriptor["connection_type"], "ssh");
        assert!(!descriptor.to_string().contains("secret"));
        assert_eq!(descriptor.as_object().unwrap().len(), 9);
    }
    fn quick_params() -> QuickConnectParams {
        QuickConnectParams {
            hostname: Some("example.test".into()),
            port: 22,
            username: Some("admin".into()),
            password: None,
            key: None,
            private_key: None,
            passphrase: None,
            connection_type: "ssh".into(),
            serial_port: None,
            serial_speed: None,
            local_command: None,
            local_args: None,
            local_cwd: None,
            cols: default_cols(),
            rows: default_rows(),
            term: default_term(),
            timeout: default_connect_timeout_secs(),
            keepalive: default_keepalive_interval_secs(),
            sid: None,
        }
    }

    #[test]
    fn detects_supported_netrix_protocol() {
        let mut headers = HeaderMap::new();
        headers.insert(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("chat, netrix.v1"),
        );

        assert!(supports_netrix_protocol(&headers));
    }

    #[test]
    fn saved_connection_type_keeps_explicit_ssh_on_port_23() {
        assert_eq!(resolve_saved_connection_type("ssh", 23), "ssh");
        assert_eq!(resolve_saved_connection_type("telnet", 23), "telnet");
    }

    #[test]
    fn saved_connection_type_falls_back_for_empty_or_invalid_values() {
        assert_eq!(resolve_saved_connection_type("", 23), "telnet");
        assert_eq!(resolve_saved_connection_type("", 22), "ssh");
        assert_eq!(resolve_saved_connection_type("unknown", 22), "ssh");
    }

    #[test]
    fn connection_settings_are_bounded() {
        assert_eq!(sanitize_connect_timeout_secs(1), 5);
        assert_eq!(sanitize_connect_timeout_secs(30), 30);
        assert_eq!(sanitize_connect_timeout_secs(999), 120);
        assert_eq!(sanitize_keepalive_interval_secs(0), 0);
        assert_eq!(sanitize_keepalive_interval_secs(60), 60);
        assert_eq!(sanitize_keepalive_interval_secs(999), 300);
    }

    #[test]
    fn user_facing_connect_error_maps_auth_and_network_failures() {
        assert_eq!(
            user_facing_connect_error("Authentication failed for user 'admin'"),
            "Authentication failed. Verify username, password/private key, and passphrase."
        );
        assert_eq!(
            user_facing_connect_error("TCP connection refused by 10.0.0.10:22"),
            "TCP connection refused. Verify SSH service is running and the port is correct."
        );
        assert_eq!(
            user_facing_connect_error("Timed out connecting to 10.0.0.10:22 after 5 seconds"),
            "Connection timed out. Host is reachable but SSH port may be blocked or filtered."
        );
        assert_eq!(
            user_facing_connect_error("Network route to 10.0.0.10:22 is unreachable"),
            "Network route to host is unavailable. Check VPN, routing, and firewall rules."
        );
    }

    #[test]
    fn unicode_error_truncation_uses_character_boundaries() {
        let boundary = format!("{}€", "a".repeat(219));
        assert_eq!(user_facing_connect_error(&boundary), boundary);
        let long = "界".repeat(300);
        assert_eq!(
            user_facing_connect_error(&long),
            format!("{}...", "界".repeat(220))
        );
    }

    #[test]
    fn quick_connect_detects_credentials_in_query_params() {
        let mut params = quick_params();
        assert!(!quick_connect_has_query_credentials(&params));
        params.password = Some("secret".into());
        assert!(quick_connect_has_query_credentials(&params));
    }

    #[test]
    fn quick_connect_detects_credentials_deserialized_from_ws_query() {
        let uri: axum::http::Uri = "/ws/quick-connect?hostname=example.test&username=admin&password=super-secret&private_key=secret-key&passphrase=secret-phrase&type=ssh"
            .parse()
            .expect("valid uri");
        let Query(q) = Query::<QuickWsQuery>::try_from_uri(&uri).expect("query parses");

        assert!(q.ticket.is_none());
        assert!(quick_connect_has_query_credentials(&q.params));
    }

    #[test]
    fn quick_connect_ticket_query_is_not_treated_as_credentials() {
        let uri: axum::http::Uri = "/ws/quick-connect?ticket=abc123"
            .parse()
            .expect("valid uri");
        let Query(q) = Query::<QuickWsQuery>::try_from_uri(&uri).expect("query parses");

        assert_eq!(q.ticket.as_deref(), Some("abc123"));
        assert!(!quick_connect_has_query_credentials(&q.params));
    }

    #[test]
    fn quick_connect_target_builds_from_ticket_payload() {
        let mut params = quick_params();
        params.password = Some("secret".into());
        params.sid = Some(99);

        let (host_info, sid) = build_quick_connect_target(params).expect("valid target");
        assert_eq!(sid, Some(99));
        assert_eq!(host_info["hostname"], "example.test");
        assert_eq!(host_info["password"], "secret");
        assert_eq!(host_info["connect_timeout_secs"], 20);
    }
}
