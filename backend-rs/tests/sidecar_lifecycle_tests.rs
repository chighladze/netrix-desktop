//! Use only temporary workspaces and TCP peers created by the test.
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};

use fs2::FileExt;
use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, Command};
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

const TOKEN: &str = "managed-sidecar-test-token";
const PASSWORD: &str = "temporary-sidecar-workspace-password";
const IO_TIMEOUT: Duration = Duration::from_secs(35);
const LOCK_BYTES: &[u8] = b"persistent lock-file fixture";

struct Profile(PathBuf);

impl Profile {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("netrix-sidecar-test-{}", uuid::Uuid::new_v4())))
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        if self.0.exists() && !std::thread::panicking() {
            std::fs::remove_dir_all(&self.0).expect("closed backend retained workspace handles");
        }
    }
}

fn spawn(profile: &Path) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_netrix_backend"));
    command
        .arg("--managed")
        .env_remove("NETRIX_DEV")
        .env("NETRIX_DATA_DIR", profile)
        .env("RUST_LOG", "info")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command.spawn().unwrap()
}

async fn start(profile: &Path) -> (Child, u16) {
    let mut child = spawn(profile);
    send_token(&mut child).await;
    let port = ready_port(&mut child).await;
    (child, port)
}

async fn send_token(child: &mut Child) {
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(format!("{TOKEN}\n").as_bytes())
        .await
        .unwrap();
}

async fn ready_port(child: &mut Child) -> u16 {
    let mut line = String::new();
    timeout(
        IO_TIMEOUT,
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let port = line
        .trim()
        .strip_prefix("NETRIX_LISTENING:")
        .expect("listener frame")
        .parse()
        .unwrap();
    assert_eq!(
        request(port, "GET", "/health", Some(TOKEN), None).await.0,
        200
    );
    port
}

async fn request(
    port: u16,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (u16, Value) {
    let request = async {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let auth = token
            .map(|token| format!("X-API-Token: {token}\r\n"))
            .unwrap_or_default();
        let body = body.map(|body| body.to_string()).unwrap_or_default();
        socket.write_all(format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        let mut response = String::new();
        socket.read_to_string(&mut response).await.unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        (
            head.split_whitespace().nth(1).unwrap().parse().unwrap(),
            serde_json::from_str(body).unwrap_or(Value::Null),
        )
    };
    timeout(IO_TIMEOUT, request)
        .await
        .expect("HTTP response deadline")
}

async fn shutdown(child: &mut Child) -> ExitStatus {
    drop(child.stdin.take());
    drop(child.stdin.take()); // A second close must not run another transaction.
    timeout(Duration::from_secs(18), child.wait())
        .await
        .expect("sidecar shutdown deadline")
        .unwrap()
}

#[tokio::test]
async fn eof_before_token_never_touches_the_workspace() {
    let profile = Profile::new();
    let mut child = spawn(&profile.0);
    assert!(shutdown(&mut child).await.success());
    assert!(!profile.0.exists());
}

fn hold_workspace_lock(directory: &Path) -> File {
    fs::create_dir(directory).unwrap();
    let path = directory.join(".database-lock");
    fs::write(&path, LOCK_BYTES).unwrap();
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    file.try_lock_exclusive().unwrap();
    file
}

async fn start_waiting_for_lock(directory: &Path) -> Child {
    let mut child = spawn(directory);
    send_token(&mut child).await;
    timeout(Duration::from_secs(5), async {
        let path = directory.join("backend.log");
        loop {
            assert!(
                child.try_wait().unwrap().is_none(),
                "sidecar exited during lock wait"
            );
            if fs::read_to_string(&path)
                .is_ok_and(|text| text.contains("Waiting for the workspace lock"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("backend reached the lock wait");
    child
}

#[tokio::test]
async fn startup_reuses_the_lock_file_after_the_previous_owner_leaves() {
    let profile = Profile::new();
    let owner = hold_workspace_lock(&profile.0);
    let mut child = start_waiting_for_lock(&profile.0).await;
    assert!(!profile.0.join("database.db").exists());
    drop(owner);
    ready_port(&mut child).await;
    assert!(shutdown(&mut child).await.success());
    assert_eq!(
        fs::read(profile.0.join(".database-lock")).unwrap(),
        LOCK_BYTES
    );
}

#[tokio::test]
async fn eof_cancels_startup_while_a_different_owner_still_holds_the_lock() {
    let profile = Profile::new();
    let owner = hold_workspace_lock(&profile.0);
    let mut child = start_waiting_for_lock(&profile.0).await;
    assert!(timeout(Duration::from_secs(3), shutdown(&mut child))
        .await
        .unwrap()
        .success());
    assert!(!profile.0.join("database.db").exists());
    drop(owner);
    assert_eq!(
        fs::read(profile.0.join(".database-lock")).unwrap(),
        LOCK_BYTES
    );
}

#[tokio::test]
async fn startup_reports_workspace_busy_after_the_lock_wait_expires() {
    let profile = Profile::new();
    let owner = hold_workspace_lock(&profile.0);
    let began = Instant::now();
    let mut child = start_waiting_for_lock(&profile.0).await;
    let _stdin = child.stdin.take().unwrap(); // Keep the parent pipe open through the wait.
    let output = timeout(Duration::from_secs(21), child.wait_with_output())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(began.elapsed() >= Duration::from_secs(14));
    assert!(
        output.stdout.is_empty(),
        "no listener should be announced during contention"
    );
    let stderr = String::from_utf8(output.stderr).unwrap();
    let diagnostic = stderr
        .lines()
        .find_map(|line| line.strip_prefix("NETRIX_STARTUP_FAILURE:"))
        .unwrap();
    let diagnostic: Value = serde_json::from_str(diagnostic).unwrap();
    assert_eq!(diagnostic["code"], "workspace_busy");
    assert_eq!(
        diagnostic["os_error"],
        json!(fs2::lock_contended_error().raw_os_error())
    );
    assert!(!profile.0.join("database.db").exists());
    drop(owner);
    assert_eq!(
        fs::read(profile.0.join(".database-lock")).unwrap(),
        LOCK_BYTES
    );
}

#[tokio::test]
async fn private_pipe_stops_a_locked_server_and_releases_port_and_lock() {
    let profile = Profile::new();
    let (mut child, port) = start(&profile.0).await;
    assert_eq!(request(port, "GET", "/health", None, None).await.0, 403);
    assert_eq!(
        request(port, "POST", "/shutdown", Some(TOKEN), None)
            .await
            .0,
        423
    );
    // Even input on the control pipe after bootstrap has no command syntax.
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"shutdown\n")
        .await
        .unwrap();
    assert_eq!(
        request(port, "GET", "/health", Some(TOKEN), None).await.0,
        200
    );
    assert!(!profile.0.join("database.db").exists());
    assert!(shutdown(&mut child).await.success());
    assert!(!profile.0.join("database.db").exists());
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    let (mut restarted, _) = start(&profile.0).await;
    assert!(shutdown(&mut restarted).await.success());
}

#[tokio::test]
async fn shutdown_closes_an_active_terminal_and_preserves_committed_database_rows() {
    let profile = Profile::new();
    let (mut child, port) = start(&profile.0).await;
    let unlock = json!({"master_password": PASSWORD});
    assert_eq!(
        request(
            port,
            "POST",
            "/security/unlock",
            Some(TOKEN),
            Some(unlock.clone())
        )
        .await
        .0,
        200
    );
    let telnet = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let peer_port = telnet.local_addr().unwrap().port();
    let (status, created) = request(port, "POST", "/hosts", Some(TOKEN), Some(json!({
        "name": "sidecar test host", "hostname": "127.0.0.1", "port": peer_port, "connection_type": "telnet",
    }))).await;
    assert_eq!(status, 201, "{created}");
    let id = created["id"].as_i64().unwrap();
    let mut upgrade = format!("ws://127.0.0.1:{port}/ws/terminal/{id}")
        .into_client_request()
        .unwrap();
    upgrade.headers_mut().insert(
        "Sec-WebSocket-Protocol",
        format!("netrix.v1, netrix-token.{TOKEN}").parse().unwrap(),
    );
    let (mut ws, _) = timeout(IO_TIMEOUT, tokio_tungstenite::connect_async(upgrade))
        .await
        .unwrap()
        .unwrap();
    let (mut peer, _) = timeout(IO_TIMEOUT, telnet.accept()).await.unwrap().unwrap();
    let session_id = timeout(IO_TIMEOUT, async {
        loop {
            let frame = ws.next().await.unwrap().unwrap();
            if let Some(info) = frame
                .to_text()
                .ok()
                .and_then(|text| text.strip_prefix("__JSON__"))
            {
                let info: Value = serde_json::from_str(info).unwrap();
                if info["type"] == "connect" {
                    return info["session_id"].as_i64().unwrap();
                }
            }
        }
    })
    .await
    .unwrap();
    ws.send(Message::Text(
        json!({"type":"ready", "session_id": session_id})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    let (status, message) = request(port, "POST", "/shutdown", Some(TOKEN), None).await;
    assert_eq!(status, 404, "{message}");
    ws.send(Message::Binary(b"test\r"[..].into()))
        .await
        .unwrap();
    let mut input = [0; 5];
    timeout(IO_TIMEOUT, peer.read_exact(&mut input))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&input, b"test\r");
    assert!(shutdown(&mut child).await.success());

    timeout(IO_TIMEOUT, async {
        while let Some(frame) = ws.next().await {
            if matches!(frame.unwrap(), Message::Close(_)) {
                return;
            }
        }
        panic!("server closed the terminal without a WebSocket close frame");
    })
    .await
    .unwrap();
    let mut remaining = Vec::new();
    timeout(IO_TIMEOUT, peer.read_to_end(&mut remaining))
        .await
        .unwrap()
        .unwrap();
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
    let (mut restarted, new_port) = start(&profile.0).await;
    assert_eq!(
        request(
            new_port,
            "POST",
            "/security/unlock",
            Some(TOKEN),
            Some(unlock)
        )
        .await
        .0,
        200
    );
    let (_, hosts) = request(new_port, "GET", "/hosts", Some(TOKEN), None).await;
    assert_eq!(hosts[0]["name"], "sidecar test host");
    assert!(shutdown(&mut restarted).await.success());
}
