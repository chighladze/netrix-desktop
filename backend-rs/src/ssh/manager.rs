/// Connection / session manager — SSH, Telnet, Serial.
///
/// Each session owns its connection and a broadcast ring so that multiple
/// WebSocket consumers can attach/detach independently.
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use russh::client;
use russh::keys::PublicKeyBase64;
use russh::keys::PublicKeyOrCertificate;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{broadcast, Mutex, RwLock};
use tracing::{debug, info, warn};

use crate::ssh::known_hosts::{HostKeyResult, KnownHostsStore};
use crate::ssh::local_pty::{self, LocalPtySession};
use crate::ssh::telnet::{TelnetClient, TelnetWriter};

const SESSION_HISTORY_BYTES: usize = 2 * 1024 * 1024;
const SESSION_HISTORY_CHUNKS: usize = 2048;
const SESSION_OUTPUT_CHUNK_BYTES: usize = 16 * 1024;
const SESSION_BROADCAST_CAPACITY: usize = 128;
const SESSION_MONITOR_INTERVAL: Duration = Duration::from_secs(5);
const CONNECTING_SESSION_TTL: Duration = Duration::from_secs(120);
const DETACHED_SESSION_TTL: Duration = Duration::from_secs(600);
const SESSION_IO_TIMEOUT: Duration = Duration::from_secs(10);
const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const SESSION_SECRET_FIELDS: [&str; 3] = ["password", "private_key", "passphrase"];

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Data(Bytes),
    Ended(String),
}

pub struct SessionReplay {
    pub history: Vec<Bytes>,
    pub receiver: broadcast::Receiver<SessionEvent>,
    pub start: u64,
    pub end: u64,
}

// ─── Session state machine ──────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum SessionState {
    New,
    Connecting,
    Active,
    Detached,
    Closing,
    Closed,
    Failed,
}

// ─── Circuit breaker ────────────────────────────────────────────────

struct CircuitBreaker {
    failures: HashMap<String, u32>,
    last_failure: HashMap<String, Instant>,
    threshold: u32,
    recovery: Duration,
}

impl CircuitBreaker {
    fn new() -> Self {
        Self {
            failures: HashMap::new(),
            last_failure: HashMap::new(),
            threshold: 3,
            recovery: Duration::from_secs(300),
        }
    }

    fn is_blocked(&self, host: &str) -> bool {
        if let Some(&count) = self.failures.get(host) {
            if count >= self.threshold {
                if let Some(&ts) = self.last_failure.get(host) {
                    return ts.elapsed() < self.recovery;
                }
            }
        }
        false
    }

    fn report_failure(&mut self, host: &str) {
        let count = self.failures.entry(host.to_string()).or_insert(0);
        *count += 1;
        self.last_failure.insert(host.to_string(), Instant::now());
        warn!("[Breaker] {host} failure count: {count}");
    }

    fn report_success(&mut self, host: &str) {
        self.failures.remove(host);
    }
}

// ─── Connection kind ────────────────────────────────────────────────

/// Force-close the exact TCP transport even if russh is waiting on network I/O.
/// Also covers cancellation during authentication, before publishing a session.
struct TransportShutdown(std::net::TcpStream);

impl Drop for TransportShutdown {
    fn drop(&mut self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

enum Connection {
    #[cfg(test)]
    Test,
    Ssh {
        handle: client::Handle<SshHandler>,
        channel_id: russh::ChannelId,
        /// Write-half of the channel — used for resize (window_change).
        channel_writer: Arc<Mutex<russh::ChannelWriteHalf<client::Msg>>>,
        transport: TransportShutdown,
    },
    Telnet {
        writer: Arc<Mutex<TelnetWriter>>,
    },
    Serial {
        writer: Arc<Mutex<tokio::io::WriteHalf<tokio_serial::SerialStream>>>,
    },
    LocalShell {
        writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
        master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
        child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    },
}

// ─── Per-session state ──────────────────────────────────────────────

pub struct Session {
    pub id: i64,
    pub host_info: serde_json::Value,
    pub state: SessionState,
    pub last_activity: Instant,
    /// Broadcast channel for terminal output (bytes).
    tx: broadcast::Sender<SessionEvent>,
    /// History ring for session replay on reattach.
    history: VecDeque<Bytes>,
    history_bytes: usize,
    output_offset: u64,
    pub end_reason: Option<String>,
    connect_lock: Arc<Mutex<()>>,
    detached_since: Option<Instant>,
    conn: Option<Connection>,
    /// Handle for the background read task.
    read_task: Option<tokio::task::JoinHandle<()>>,
    ws_clients: usize,
}

impl Session {
    fn new(id: i64, host_info: serde_json::Value) -> Self {
        let (tx, _) = broadcast::channel(SESSION_BROADCAST_CAPACITY);
        Self {
            id,
            host_info,
            state: SessionState::New,
            last_activity: Instant::now(),
            tx,
            history: VecDeque::new(),
            history_bytes: 0,
            output_offset: 0,
            end_reason: None,
            connect_lock: Arc::new(Mutex::new(())),
            detached_since: None,
            conn: None,
            read_task: None,
            ws_clients: 0,
        }
    }

    pub fn set_state(&mut self, new: SessionState) {
        if new == SessionState::Detached && self.state != SessionState::Detached {
            self.detached_since = Some(Instant::now());
        } else if new != SessionState::Detached {
            self.detached_since = None;
        }
        info!(
            "[Session {}] {} -> {:?}",
            self.id,
            format!("{:?}", self.state),
            new
        );
        self.state = new;
    }

    fn scrub_credentials(&mut self) {
        let Some(host_info) = self.host_info.as_object_mut() else {
            return;
        };

        for field in SESSION_SECRET_FIELDS {
            host_info.remove(field);
        }
    }

    fn monitor_cleanup_reason(&self) -> Option<&'static str> {
        match self.state {
            SessionState::Failed => Some("failed"),
            SessionState::Closed => Some("closed"),
            SessionState::Connecting if self.last_activity.elapsed() >= CONNECTING_SESSION_TTL => {
                Some("connecting timeout")
            }
            SessionState::Detached
                if self.detached_since.unwrap_or(self.last_activity).elapsed()
                    >= DETACHED_SESSION_TTL =>
            {
                Some("detached timeout")
            }
            _ => None,
        }
    }

    /// Subscribe to output stream (gets history replayed first).
    pub fn subscribe(&self) -> (Vec<Bytes>, broadcast::Receiver<SessionEvent>) {
        (self.history.iter().cloned().collect(), self.tx.subscribe())
    }

    /// Atomically subscribe after an exact byte checkpoint. Never silently skip
    /// bytes when a window was too slow to accept a terminal snapshot.
    pub fn subscribe_after(&self, after: Option<u64>) -> Result<SessionReplay, &'static str> {
        let oldest = self.output_offset - self.history_bytes as u64;
        let start = after.unwrap_or(oldest);
        if start < oldest || start > self.output_offset {
            return Err("Terminal output changed too quickly. Keep this window open and try moving it again.");
        }
        let mut skip = (start - oldest) as usize;
        let mut history = Vec::new();
        for chunk in &self.history {
            if skip >= chunk.len() {
                skip -= chunk.len();
            } else {
                history.push(chunk.slice(skip..));
                skip = 0;
            }
        }
        Ok(SessionReplay {
            history,
            receiver: self.tx.subscribe(),
            start,
            end: self.output_offset,
        })
    }

    /// Broadcast data to all connected WebSockets.
    fn broadcast(&mut self, data: Vec<u8>) {
        self.last_activity = Instant::now();
        for chunk in data.chunks(SESSION_OUTPUT_CHUNK_BYTES) {
            let chunk = Bytes::copy_from_slice(chunk);
            self.output_offset += chunk.len() as u64;
            self.history_bytes += chunk.len();
            self.history.push_back(chunk.clone());
            while self.history_bytes > SESSION_HISTORY_BYTES
                || self.history.len() > SESSION_HISTORY_CHUNKS
            {
                if let Some(oldest) = self.history.pop_front() {
                    self.history_bytes -= oldest.len();
                }
            }
            let _ = self.tx.send(SessionEvent::Data(chunk));
        }
    }
}

// ─── Public handle exposed to route handlers ────────────────────────

/// Thread-safe handle to a single session.
pub type SessionHandle = Arc<RwLock<Session>>;

/// The global session manager — thread-safe, cheaply cloneable.
#[derive(Clone)]
pub struct SessionManager {
    inner: Arc<Inner>,
}

struct Inner {
    workspace_gate: Arc<RwLock<()>>,
    tunnels: super::tunnels::TunnelManager,
    sessions: RwLock<HashMap<i64, SessionHandle>>,
    breaker: Mutex<CircuitBreaker>,
    known_hosts: KnownHostsStore,
}

impl SessionManager {
    pub fn workspace_gate(&self) -> Arc<RwLock<()>> {
        self.inner.workspace_gate.clone()
    }
    pub fn tunnels(&self) -> &super::tunnels::TunnelManager {
        &self.inner.tunnels
    }
    pub(crate) async fn tunnel_client(
        known_hosts: KnownHostsStore,
        target: &serde_json::Value,
        cancelled: &tokio_util::sync::CancellationToken,
    ) -> Result<client::Handle<SshHandler>, String> {
        let host = target["hostname"].as_str().unwrap_or("");
        let port = target["port"].as_u64().unwrap_or(22) as u16;
        let config = Arc::new(client::Config {
            keepalive_interval: Some(Duration::from_secs(10)),
            keepalive_max: 3,
            ..Default::default()
        });
        let handler = SshHandler::new(known_hosts, host.to_string(), port);
        let connecting = tokio::time::timeout(
            Duration::from_secs(20),
            client::connect(config, (host, port), handler),
        );
        let mut connection = tokio::select! {
            biased;
            _ = cancelled.cancelled() => return Err("Tunnel start cancelled".into()),
            result = connecting => result,
        }
        .map_err(|_| "SSH connection timed out".to_string())?
        .map_err(|e| format!("SSH connection failed: {e}"))?;
        let authenticating = tokio::time::timeout(
            Duration::from_secs(20),
            Self::authenticate(
                &mut connection,
                target["username"].as_str().unwrap_or(""),
                target["password"].as_str(),
                target["private_key"].as_str(),
                target["passphrase"].as_str(),
            ),
        );
        let authenticated = tokio::select! {
            biased;
            _ = cancelled.cancelled() => false,
            result = authenticating => result.unwrap_or(false),
        };
        if !authenticated || cancelled.is_cancelled() {
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                connection.disconnect(
                    russh::Disconnect::ByApplication,
                    "authentication failed",
                    "",
                ),
            )
            .await;
            return Err(if cancelled.is_cancelled() {
                "Tunnel start cancelled"
            } else {
                "SSH authentication failed"
            }
            .into());
        }
        Ok(connection)
    }
    pub async fn is_empty(&self) -> bool {
        self.inner.sessions.read().await.is_empty()
    }
    pub fn known_hosts(&self) -> &KnownHostsStore {
        &self.inner.known_hosts
    }
    pub fn new() -> Self {
        Self::with_known_hosts(KnownHostsStore::new())
    }

    pub fn with_known_hosts(known_hosts: KnownHostsStore) -> Self {
        Self {
            inner: Arc::new(Inner {
                workspace_gate: Arc::new(RwLock::new(())),
                tunnels: super::tunnels::TunnelManager::default(),
                sessions: RwLock::new(HashMap::new()),
                breaker: Mutex::new(CircuitBreaker::new()),
                known_hosts,
            }),
        }
    }

    // ── Session lifecycle ───────────────────────────────────────────

    /// Reserve a fresh, JavaScript-safe ID atomically. A new terminal must never
    /// inherit another session, including when the random candidate collides.
    pub async fn create(&self, host_info: serde_json::Value) -> SessionHandle {
        let mut sessions = self.inner.sessions.write().await;
        loop {
            let id = (rand::random::<u64>() & ((1_u64 << 53) - 1)) as i64;
            if id == 0 {
                continue;
            }
            if let std::collections::hash_map::Entry::Vacant(entry) = sessions.entry(id) {
                let handle = Arc::new(RwLock::new(Session::new(id, host_info)));
                entry.insert(handle.clone());
                return handle;
            }
        }
    }

    pub async fn get_or_create(&self, id: i64, host_info: serde_json::Value) -> SessionHandle {
        let mut sessions = self.inner.sessions.write().await;
        sessions
            .entry(id)
            .or_insert_with(|| Arc::new(RwLock::new(Session::new(id, host_info))))
            .clone()
    }

    pub async fn get(&self, id: i64) -> Option<SessionHandle> {
        self.inner.sessions.read().await.get(&id).cloned()
    }

    async fn owns_handle(&self, id: i64, handle: &SessionHandle) -> bool {
        self.inner
            .sessions
            .read()
            .await
            .get(&id)
            .is_some_and(|registered| Arc::ptr_eq(registered, handle))
    }

    async fn mark_transport_ended(handle: &SessionHandle, transport: &str, reason: &str) {
        let mut s = handle.write().await;
        if !matches!(s.state, SessionState::Closing | SessionState::Closed) {
            s.set_state(SessionState::Closed);
        }
        s.conn = None;
        s.end_reason = Some(reason.to_string());
        let _ = s.tx.send(SessionEvent::Ended(reason.to_string()));
        info!(
            "[{transport} read] stream ended for session {}: {reason}",
            s.id
        );
    }

    pub async fn attach_client(&self, handle: &SessionHandle) -> usize {
        let mut s = handle.write().await;
        s.ws_clients = s.ws_clients.saturating_add(1);
        debug!("[Session {}] websocket clients: {}", s.id, s.ws_clients);
        s.ws_clients
    }

    pub async fn release_client(&self, handle: &SessionHandle) -> usize {
        let mut s = handle.write().await;
        s.ws_clients = s.ws_clients.saturating_sub(1);
        debug!("[Session {}] websocket clients: {}", s.id, s.ws_clients);
        s.ws_clients
    }

    pub async fn detach(&self, handle: &SessionHandle) {
        let mut s = handle.write().await;
        if s.ws_clients <= 1 {
            s.set_state(SessionState::Detached);
        }
        s.last_activity = Instant::now();
    }

    /// All WebSocket bridge exits release exactly one attachment.
    pub async fn finish_client(&self, handle: &SessionHandle, terminate: bool) {
        let (id, cleanup) = {
            let mut session = handle.write().await;
            session.ws_clients = session.ws_clients.saturating_sub(1);
            let cleanup = terminate || (session.ws_clients == 0 && session.conn.is_none());
            if !cleanup && session.ws_clients == 0 {
                session.set_state(SessionState::Detached);
                session.last_activity = Instant::now();
            }
            (session.id, cleanup)
        };
        if cleanup {
            if terminate {
                self.cleanup_owned(id, handle).await;
            } else {
                // Recheck under the registry lock in case a new client arrived
                // between releasing our attachment and removing the session.
                let removed = {
                    let mut sessions = self.inner.sessions.write().await;
                    let session = handle.read().await;
                    if sessions
                        .get(&id)
                        .is_some_and(|registered| Arc::ptr_eq(registered, handle))
                        && session.ws_clients == 0
                    {
                        sessions.remove(&id)
                    } else {
                        None
                    }
                };
                if let Some(handle) = removed {
                    Self::cleanup_handle(&handle, id).await;
                }
            }
        }
    }

    pub async fn detach_if_live(&self, handle: &SessionHandle) -> bool {
        let mut s = handle.write().await;
        if s.conn.is_some() && matches!(s.state, SessionState::Active | SessionState::Detached) {
            if s.state == SessionState::Active {
                s.set_state(SessionState::Detached);
            }
            s.last_activity = Instant::now();
            return true;
        }
        false
    }

    async fn resume_existing_connection(&self, handle: &SessionHandle) -> bool {
        let mut s = handle.write().await;
        if s.conn.is_some() && matches!(s.state, SessionState::Active | SessionState::Detached) {
            if s.state == SessionState::Detached {
                s.set_state(SessionState::Active);
            }
            s.last_activity = Instant::now();
            return true;
        }

        s.conn = None;
        if let Some(task) = s.read_task.take() {
            task.abort();
        }
        false
    }

    // ── SSH connect ─────────────────────────────────────────────────

    async fn connect_ssh(&self, handle: &SessionHandle) -> Result<(), String> {
        let (
            id,
            hostname,
            port,
            username,
            password,
            private_key,
            passphrase,
            _known_hosts_policy,
            cols,
            rows,
            term,
            connect_timeout_secs,
            keepalive_interval_secs,
        ) = {
            let s = handle.read().await;
            let hi = &s.host_info;
            (
                s.id,
                hi["hostname"].as_str().unwrap_or("").to_string(),
                hi["port"].as_i64().unwrap_or(22) as u16,
                hi.get("username")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                hi.get("password")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                hi.get("private_key")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                hi.get("passphrase")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                crate::config::SETTINGS.ssh_known_hosts_policy.clone(),
                hi.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u32,
                hi.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u32,
                hi.get("term")
                    .and_then(|v| v.as_str())
                    .unwrap_or("xterm-256color")
                    .to_string(),
                hi.get("connect_timeout_secs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(20)
                    .clamp(5, 120),
                hi.get("keepalive_interval_secs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(10)
                    .min(300),
            )
        };

        // Resume an already-live transport without opening a second connection.
        if self.resume_existing_connection(handle).await {
            return Ok(());
        }

        // Circuit breaker.
        {
            let breaker = self.inner.breaker.lock().await;
            if breaker.is_blocked(&hostname) {
                let mut s = handle.write().await;
                s.set_state(SessionState::Failed);
                return Err(format!("Host {hostname} is circuit-breaker blocked"));
            }
        }

        {
            let mut s = handle.write().await;
            s.set_state(SessionState::Connecting);
        }

        // Build russh config.
        let keepalive_interval = if keepalive_interval_secs == 0 {
            None
        } else {
            Some(Duration::from_secs(keepalive_interval_secs))
        };

        let config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval,
            keepalive_max: 3,
            ..Default::default()
        });

        let sh = SshHandler::new(self.inner.known_hosts.clone(), hostname.clone(), port);
        let mut backoff = Duration::from_secs(1);
        let max_retries = 3u32;
        let mut last_error: Option<String> = None;

        for attempt in 1..=max_retries {
            info!("[Session {id}] SSH connect attempt {attempt}/{max_retries}");

            // Clear previous server-key result before each attempt.
            *sh.key_result.lock().await = None;

            match tokio::time::timeout(Duration::from_secs(connect_timeout_secs), async {
                let socket = tokio::net::TcpStream::connect((hostname.as_str(), port)).await?;
                if config.nodelay {
                    let _ = socket.set_nodelay(true);
                }
                let socket = socket.into_std()?;
                let transport = TransportShutdown(socket.try_clone()?);
                let socket = tokio::net::TcpStream::from_std(socket)?;
                let connection = client::connect_stream(config.clone(), socket, sh.clone()).await?;
                Ok::<_, anyhow::Error>((connection, transport))
            })
            .await
            {
                Ok(Ok((mut handle_ssh, transport))) => {
                    // Authenticate.
                    let auth_ok = Self::authenticate(
                        &mut handle_ssh,
                        &username,
                        password.as_deref(),
                        private_key.as_deref(),
                        passphrase.as_deref(),
                    )
                    .await;

                    if !auth_ok {
                        self.inner.breaker.lock().await.report_failure(&hostname);
                        let mut s = handle.write().await;
                        s.set_state(SessionState::Failed);
                        return Err(format!(
                            "Authentication failed for user '{}' on {}:{}",
                            username, hostname, port
                        ));
                    }

                    // Open a PTY channel.
                    let channel = handle_ssh
                        .channel_open_session()
                        .await
                        .map_err(|e| format!("channel open: {e}"))?;

                    let channel_id = channel.id();

                    channel
                        .request_pty(false, &term, cols, rows, 0, 0, &[])
                        .await
                        .map_err(|e| format!("pty request: {e}"))?;

                    channel
                        .request_shell(false)
                        .await
                        .map_err(|e| format!("shell request: {e}"))?;

                    // Split the channel: read-half for background reader, write-half for resize.
                    let (mut read_half, write_half) = channel.split();
                    let channel_writer = Arc::new(Mutex::new(write_half));
                    let h2 = handle.clone();
                    // Publish the connection before the reader can report EOF.
                    let mut session = handle.write().await;
                    let read_task = tokio::spawn(async move {
                        let mut reader = read_half.make_reader();
                        let mut buf = vec![0u8; 16384];
                        let end_reason = loop {
                            match reader.read(&mut buf).await {
                                Ok(0) => break "SSH channel reached EOF. The remote shell or SSH server closed the session.".to_string(),
                                Ok(n) => {
                                    let data = buf[..n].to_vec();
                                    {
                                        let mut s = h2.write().await;
                                        s.broadcast(data);
                                    }
                                }
                                Err(e) => {
                                    break format!("SSH channel read failed: {e}");
                                }
                            }
                        };
                        SessionManager::mark_transport_ended(&h2, "SSH", &end_reason).await;
                    });

                    {
                        let s = &mut *session;
                        s.conn = Some(Connection::Ssh {
                            handle: handle_ssh,
                            channel_id,
                            channel_writer,
                            transport,
                        });
                        s.read_task = Some(read_task);
                        s.set_state(SessionState::Active);
                    }
                    drop(session);

                    self.inner.breaker.lock().await.report_success(&hostname);
                    return Ok(());
                }
                Ok(Err(e)) => {
                    let connect_err = e.to_string();
                    warn!("[Session {id}] attempt {attempt} failed: {connect_err}");

                    let key_result = sh.key_result.lock().await.clone();
                    if let Some(HostKeyResult::Mismatch { .. }) = key_result {
                        self.inner.breaker.lock().await.report_failure(&hostname);
                        let mut s = handle.write().await;
                        s.set_state(SessionState::Failed);
                        return Err(format!(
                            "SSH host key mismatch for {}:{} (possible key rotation or MITM). Remove stale host key entry and reconnect.",
                            hostname, port
                        ));
                    }
                    if let Some(HostKeyResult::StorageError { message }) = key_result {
                        handle.write().await.set_state(SessionState::Failed);
                        return Err(format!("SSH host-key verification failed: {message}"));
                    }

                    let lower = connect_err.to_ascii_lowercase();
                    last_error = Some(if lower.contains("connection refused") {
                        format!("TCP connection refused by {}:{}", hostname, port)
                    } else if lower.contains("no route to host")
                        || lower.contains("network is unreachable")
                    {
                        format!("Network route to {}:{} is unreachable", hostname, port)
                    } else {
                        format!(
                            "SSH handshake failed on {}:{} ({connect_err})",
                            hostname, port
                        )
                    });
                }
                Err(_) => {
                    warn!("[Session {id}] attempt {attempt} timed out");
                    last_error = Some(format!(
                        "Timed out connecting to {}:{} after {} seconds",
                        hostname, port, connect_timeout_secs
                    ));
                }
            }

            if attempt < max_retries {
                tokio::time::sleep(backoff).await;
                backoff *= 2;
            }
        }

        self.inner.breaker.lock().await.report_failure(&hostname);
        let mut s = handle.write().await;
        s.set_state(SessionState::Failed);
        if let Some(reason) = last_error {
            Err(format!("{reason} (after {max_retries} attempts)"))
        } else {
            Err("SSH connection failed after retries".into())
        }
    }

    /// Execute without allocating an interactive shell or a session-map entry.
    pub async fn execute_ssh(
        &self,
        target: &serde_json::Value,
        command: &str,
        output_limit: usize,
    ) -> Result<super::command::CommandOutput, String> {
        let hostname = target["hostname"].as_str().unwrap_or("");
        let port = target["port"].as_u64().unwrap_or(22) as u16;
        let username = target["username"].as_str().unwrap_or("");
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(60)),
            keepalive_interval: Some(Duration::from_secs(10)),
            ..Default::default()
        });
        let handler = SshHandler::new(self.inner.known_hosts.clone(), hostname.to_string(), port);
        let mut connection = tokio::time::timeout(
            Duration::from_secs(20),
            client::connect(config, (hostname, port), handler),
        )
        .await
        .map_err(|_| "SSH connection timed out".to_string())?
        .map_err(|error| format!("SSH connection failed: {error}"))?;
        let authenticated = tokio::time::timeout(
            Duration::from_secs(20),
            Self::authenticate(
                &mut connection,
                username,
                target["password"].as_str(),
                target["private_key"].as_str(),
                target["passphrase"].as_str(),
            ),
        )
        .await
        .unwrap_or(false);
        if !authenticated {
            let _ = connection
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "authentication failed",
                    "",
                )
                .await;
            return Err("SSH authentication failed".into());
        }
        let mut output = super::command::CommandOutput::default();
        let operation = tokio::time::timeout(Duration::from_secs(30), async {
            let mut channel = connection
                .channel_open_session()
                .await
                .map_err(|error| error.to_string())?;
            channel
                .exec(true, command.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
            while let Some(message) = channel.wait().await {
                if !output.receive(message, output_limit) {
                    break;
                }
            }
            let _ = tokio::time::timeout(Duration::from_secs(2), channel.close()).await;
            Ok::<_, String>(())
        })
        .await;
        match operation {
            Err(_) => output.timed_out = true,
            Ok(Err(error)) => output.error = Some(format!("SSH command failed: {error}")),
            Ok(Ok(())) => {}
        }
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            connection.disconnect(russh::Disconnect::ByApplication, "command complete", ""),
        )
        .await;
        output.finish();
        Ok(output)
    }

    async fn authenticate(
        handle: &mut client::Handle<SshHandler>,
        username: &str,
        password: Option<&str>,
        private_key: Option<&str>,
        passphrase: Option<&str>,
    ) -> bool {
        use russh::client::AuthResult;

        // 1. Try private-key authentication first (preferred).
        if let Some(key_data) = private_key {
            match Self::try_key_auth(handle, username, key_data, passphrase).await {
                Ok(true) => return true,
                Ok(false) => {
                    info!("[Auth] key auth rejected for {username}, trying password…");
                }
                Err(e) => {
                    warn!("[Auth] key auth error for {username}: {e}");
                }
            }
        }

        // 2. Try password auth.
        if let Some(pw) = password {
            match handle.authenticate_password(username, pw).await {
                Ok(AuthResult::Success) => return true,
                Ok(_) => {}
                Err(e) => {
                    warn!("[Auth] password auth error: {e}");
                }
            }
        }

        // 3. Try "none" auth (some servers accept it).
        matches!(
            handle.authenticate_password(username, "").await,
            Ok(AuthResult::Success)
        )
    }

    /// Attempt public-key authentication with an SSH private key (PEM/OpenSSH format).
    async fn try_key_auth(
        handle: &mut client::Handle<SshHandler>,
        username: &str,
        key_data: &str,
        passphrase: Option<&str>,
    ) -> Result<bool, String> {
        use russh::client::AuthResult;
        use russh::keys::PrivateKeyWithHashAlg;

        // decode_secret_key handles both PEM and OpenSSH formats, with optional passphrase.
        let key_pair = russh::keys::decode_secret_key(key_data, passphrase)
            .map_err(|e| format!("decode key: {e}"))?;

        let hash = if matches!(
            key_pair.algorithm(),
            russh::keys::ssh_key::Algorithm::Rsa { .. }
        ) {
            handle
                .best_supported_rsa_hash()
                .await
                .map_err(|e| format!("RSA negotiation: {e}"))?
                .flatten()
        } else {
            None
        };
        let key = PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash);

        let auth_result = handle
            .authenticate_publickey(username, key)
            .await
            .map_err(|e| format!("key auth: {e}"))?;

        Ok(matches!(auth_result, AuthResult::Success))
    }

    // ── Telnet connect ──────────────────────────────────────────────

    async fn connect_telnet(&self, handle: &SessionHandle) -> Result<(), String> {
        let (_id, hostname, port, cols, rows, term) = {
            let s = handle.read().await;
            let hi = &s.host_info;
            (
                s.id,
                hi["hostname"].as_str().unwrap_or("").to_string(),
                hi["port"].as_i64().unwrap_or(23) as u16,
                hi.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16,
                hi.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16,
                hi.get("term")
                    .and_then(|v| v.as_str())
                    .unwrap_or("xterm-256color")
                    .to_string(),
            )
        };

        if self.resume_existing_connection(handle).await {
            return Ok(());
        }

        {
            let breaker = self.inner.breaker.lock().await;
            if breaker.is_blocked(&hostname) {
                let mut s = handle.write().await;
                s.set_state(SessionState::Failed);
                return Err(format!("Host {hostname} is circuit-breaker blocked"));
            }
        }

        {
            let mut s = handle.write().await;
            s.set_state(SessionState::Connecting);
        }

        let client =
            TelnetClient::connect(&hostname, port, cols, rows, &term, Duration::from_secs(15))
                .await
                .map_err(|e| format!("telnet connect: {e}"))?;

        let (mut reader, writer) = client.into_split();
        let writer = Arc::new(Mutex::new(writer));

        let h2 = handle.clone();
        let wr2 = writer.clone();
        let mut session = handle.write().await;
        let read_task = tokio::spawn(async move {
            let end_reason = 'read_loop: loop {
                match reader.read().await {
                    Ok((visible, responses)) => {
                        // Send negotiation responses (briefly acquire lock).
                        if !responses.is_empty() {
                            let mut w = wr2.lock().await;
                            for resp in &responses {
                                if let Err(e) = w.send_cmd(resp).await {
                                    break 'read_loop format!(
                                        "Telnet negotiation write failed: {e}"
                                    );
                                }
                            }
                        }
                        // Broadcast visible data to WebSocket subscribers.
                        if !visible.is_empty() {
                            let mut s = h2.write().await;
                            s.broadcast(visible);
                        }
                    }
                    Err(e) => {
                        break format!("Telnet connection ended: {e}");
                    }
                }
            };
            SessionManager::mark_transport_ended(&h2, "Telnet", &end_reason).await;
        });

        {
            let s = &mut *session;
            s.conn = Some(Connection::Telnet { writer });
            s.read_task = Some(read_task);
            s.set_state(SessionState::Active);
        }
        drop(session);
        self.inner.breaker.lock().await.report_success(&hostname);
        Ok(())
    }

    // ── Serial connect ──────────────────────────────────────────────

    async fn connect_serial(&self, handle: &SessionHandle) -> Result<(), String> {
        let (_id, serial_port, baud) = {
            let s = handle.read().await;
            let hi = &s.host_info;
            (
                s.id,
                hi.get("serial_port")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                hi.get("serial_speed")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(9600) as u32,
            )
        };

        if self.resume_existing_connection(handle).await {
            return Ok(());
        }

        if serial_port.is_empty() {
            let mut s = handle.write().await;
            s.set_state(SessionState::Failed);
            return Err("No serial port specified".into());
        }

        {
            let mut s = handle.write().await;
            s.set_state(SessionState::Connecting);
        }

        let builder = tokio_serial::new(&serial_port, baud);
        let stream = tokio_serial::SerialStream::open(&builder)
            .map_err(|e| format!("serial open {serial_port}: {e}"))?;

        let (mut rd, wr) = tokio::io::split(stream);
        let writer = Arc::new(Mutex::new(wr));

        let h2 = handle.clone();
        let mut session = handle.write().await;
        let read_task = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            let end_reason = loop {
                match rd.read(&mut buf).await {
                    Ok(0) => break "Serial stream reached EOF.".to_string(),
                    Ok(n) => {
                        let mut s = h2.write().await;
                        s.broadcast(buf[..n].to_vec());
                    }
                    Err(e) => {
                        break format!("Serial read failed: {e}");
                    }
                }
            };
            SessionManager::mark_transport_ended(&h2, "Serial", &end_reason).await;
        });

        {
            let s = &mut *session;
            s.conn = Some(Connection::Serial { writer });
            s.read_task = Some(read_task);
            s.set_state(SessionState::Active);
        }
        drop(session);
        Ok(())
    }

    // ── Dispatch connect by type ────────────────────────────────────

    /// Reattach only; never authenticate or open a socket when preparation failed.
    pub async fn resume_live(&self, handle: &SessionHandle) -> bool {
        let connect_lock = handle.read().await.connect_lock.clone();
        let _connect_guard = connect_lock.lock().await;
        let id = handle.read().await.id;
        self.owns_handle(id, handle).await && self.resume_existing_connection(handle).await
    }

    pub async fn connect(&self, handle: &SessionHandle) -> Result<(), String> {
        let connect_lock = handle.read().await.connect_lock.clone();
        let _connect_guard = connect_lock.lock().await;
        let registered_id = handle.read().await.id;
        if !self.owns_handle(registered_id, handle).await {
            Self::cleanup_handle(handle, registered_id).await;
            return Err("Session connection was cancelled".into());
        }
        let (session_id, conn_type) = {
            let s = handle.read().await;
            (
                s.id,
                s.host_info
                    .get("connection_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("ssh")
                    .to_string(),
            )
        };

        let mut result = tokio::time::timeout(CONNECTING_SESSION_TTL, async {
            match conn_type.as_str() {
                "telnet" => self.connect_telnet(handle).await,
                "serial" => self.connect_serial(handle).await,
                "local" => self.connect_local(handle).await,
                _ => self.connect_ssh(handle).await,
            }
        })
        .await
        .unwrap_or_else(|_| Err("Session connection timed out".into()));

        handle.write().await.scrub_credentials();

        if result.is_ok() && !self.owns_handle(session_id, handle).await {
            result = Err("Session connection was cancelled".into());
        }

        if result.is_err() && !self.cleanup_owned(session_id, handle).await {
            Self::cleanup_handle(handle, session_id).await;
        }

        result
    }

    // ── Local shell (PTY) connect ───────────────────────────────────

    async fn connect_local(&self, handle: &SessionHandle) -> Result<(), String> {
        let (_id, command_cfg, args, cwd, cols, rows) = {
            let s = handle.read().await;
            let hi = &s.host_info;
            let args = hi
                .get("local_args")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            (
                s.id,
                hi.get("local_command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                args,
                hi.get("local_cwd")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                hi.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16,
                hi.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16,
            )
        };

        let command = if command_cfg.trim().is_empty() {
            local_pty::default_shell_command()
        } else {
            command_cfg
        };

        if self.resume_existing_connection(handle).await {
            return Ok(());
        }

        {
            let mut s = handle.write().await;
            s.set_state(SessionState::Connecting);
        }

        let spawned = match local_pty::spawn(&command, &args, cwd.as_deref(), cols, rows) {
            Ok(s) => s,
            Err(e) => {
                let mut s = handle.write().await;
                s.set_state(SessionState::Failed);
                return Err(format!("Local shell spawn failed: {e}"));
            }
        };

        let LocalPtySession {
            writer,
            master,
            child,
            mut rx,
        } = spawned;

        let h2 = handle.clone();
        let mut session = handle.write().await;
        let read_task = tokio::spawn(async move {
            let end_reason = loop {
                match rx.recv().await {
                    Some(data) => {
                        let mut s = h2.write().await;
                        s.broadcast(data);
                    }
                    None => break "Local shell process exited.".to_string(),
                }
            };
            SessionManager::mark_transport_ended(&h2, "Local", &end_reason).await;
        });

        {
            let s = &mut *session;
            s.conn = Some(Connection::LocalShell {
                writer,
                master,
                child,
            });
            s.read_task = Some(read_task);
            s.set_state(SessionState::Active);
        }
        drop(session);
        info!("[Session] Local shell started: {command}");
        Ok(())
    }

    // ── Write data to session ───────────────────────────────────────

    pub async fn write(&self, handle: &SessionHandle, data: &[u8]) -> Result<(), String> {
        tokio::time::timeout(SESSION_IO_TIMEOUT, self.write_inner(handle, data))
            .await
            .map_err(|_| "terminal write timed out".to_string())?
    }

    async fn write_inner(&self, handle: &SessionHandle, data: &[u8]) -> Result<(), String> {
        let s = handle.read().await;
        match &s.conn {
            Some(Connection::Ssh {
                handle: ssh_handle,
                channel_id,
                ..
            }) => ssh_handle
                .data(*channel_id, Bytes::copy_from_slice(data))
                .await
                .map_err(|e| format!("ssh write: {e:?}")),
            Some(Connection::Telnet { writer }) => {
                let mut w = writer.lock().await;
                w.write(data)
                    .await
                    .map_err(|e| format!("telnet write: {e}"))
            }
            Some(Connection::Serial { writer }) => {
                let mut w = writer.lock().await;
                w.write_all(data)
                    .await
                    .map_err(|e| format!("serial write: {e}"))
            }
            Some(Connection::LocalShell { writer, .. }) => {
                let writer = writer.clone();
                let data = data.to_vec();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let mut w = writer.blocking_lock();
                    w.write_all(&data)
                        .map_err(|e| format!("local write: {e}"))?;
                    w.flush().map_err(|e| format!("local flush: {e}"))
                })
                .await
                .map_err(|e| format!("local write task: {e}"))?
            }
            #[cfg(test)]
            Some(Connection::Test) => Ok(()),
            None => Err("no active connection".into()),
        }
    }

    // ── Resize terminal ─────────────────────────────────────────────

    pub async fn resize(&self, handle: &SessionHandle, cols: u32, rows: u32) -> Result<(), String> {
        tokio::time::timeout(SESSION_IO_TIMEOUT, self.resize_inner(handle, cols, rows))
            .await
            .map_err(|_| "terminal resize timed out".to_string())?
    }

    async fn resize_inner(
        &self,
        handle: &SessionHandle,
        cols: u32,
        rows: u32,
    ) -> Result<(), String> {
        let s = handle.read().await;
        match &s.conn {
            Some(Connection::Ssh { channel_writer, .. }) => {
                let writer = channel_writer.lock().await;
                writer
                    .window_change(cols, rows, 0, 0)
                    .await
                    .map_err(|e| format!("ssh resize: {e}"))?;
                Ok(())
            }
            Some(Connection::Telnet { writer }) => {
                let mut w = writer.lock().await;
                w.send_naws(cols as u16, rows as u16)
                    .await
                    .map_err(|e| format!("telnet resize: {e}"))
            }
            Some(Connection::Serial { .. }) => {
                // Serial has no concept of terminal size.
                Ok(())
            }
            Some(Connection::LocalShell { master, .. }) => {
                let master = master.clone();
                tokio::task::spawn_blocking(move || -> Result<(), String> {
                    let m = master.blocking_lock();
                    m.resize(portable_pty::PtySize {
                        cols: cols.min(u16::MAX as u32) as u16,
                        rows: rows.min(u16::MAX as u32) as u16,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|e| format!("local resize: {e}"))
                })
                .await
                .map_err(|e| format!("local resize task: {e}"))?
            }
            #[cfg(test)]
            Some(Connection::Test) => Ok(()),
            None => Err("no active connection".into()),
        }
    }

    // ── Session cleanup ─────────────────────────────────────────────

    pub async fn cleanup(&self, id: i64) -> bool {
        if let Some(handle) = self.get(id).await {
            self.cleanup_owned(id, &handle).await
        } else {
            false
        }
    }

    async fn cleanup_owned(&self, id: i64, expected: &SessionHandle) -> bool {
        if !self
            .inner
            .sessions
            .read()
            .await
            .get(&id)
            .is_some_and(|registered| Arc::ptr_eq(registered, expected))
        {
            return false;
        }
        let manager = self.clone();
        let handle = expected.clone();
        // A disconnected HTTP caller must not cancel cleanup. Keep the registry
        // entry until shutdown finishes so concurrent DELETEs wait for it too.
        tokio::spawn(async move {
            Self::cleanup_handle(&handle, id).await;
            let mut sessions = manager.inner.sessions.write().await;
            if sessions
                .get(&id)
                .is_some_and(|registered| Arc::ptr_eq(registered, &handle))
            {
                sessions.remove(&id);
            }
        })
        .await
        .is_ok()
    }

    async fn cleanup_handle(handle: &SessionHandle, id: i64) {
        let mut s = handle.write().await;
        if s.state == SessionState::Closed {
            return;
        }
        s.scrub_credentials();
        if s.state != SessionState::Closing {
            s.set_state(SessionState::Closing);
        }
        if let Some(task) = s.read_task.take() {
            task.abort();
            let _ = task.await;
        }
        let reason = "Terminal session was closed.".to_string();
        s.end_reason = Some(reason.clone());
        let _ = s.tx.send(SessionEvent::Ended(reason));
        let connection = s.conn.take();
        let shutdown = async move {
            match connection {
                Some(Connection::Ssh {
                    handle, transport, ..
                }) => {
                    let _ = handle
                        .disconnect(russh::Disconnect::ByApplication, "bye", "")
                        .await;
                    drop(transport);
                }
                Some(Connection::Telnet { writer }) => {
                    let mut w = writer.lock().await;
                    w.shutdown().await;
                }
                Some(Connection::Serial { writer }) => {
                    let mut w = writer.lock().await;
                    let _ = w.shutdown().await;
                }
                Some(Connection::LocalShell { child, writer, .. }) => {
                    // Best-effort: drop the writer (PTY master writer half),
                    // then kill the child. Avoid `wait()` here because it
                    // blocks the async runtime.
                    drop(writer);
                    let mut c = child.lock().await;
                    let _ = c.kill();
                }
                #[cfg(test)]
                Some(Connection::Test) => {}
                None => {}
            }
        };
        // Dropping an overdue shutdown future drops its transport owners.
        if tokio::time::timeout(SESSION_CLOSE_TIMEOUT, shutdown)
            .await
            .is_err()
        {
            warn!("[Session {id}] graceful shutdown timed out; transport dropped");
        }
        s.set_state(SessionState::Closed);
        info!("[Session {id}] fully cleaned up");
    }

    // ── Periodic health monitor ─────────────────────────────────────

    async fn cleanup_terminal_and_expired_sessions(&self) {
        let handles: Vec<(i64, SessionHandle)> = self
            .inner
            .sessions
            .read()
            .await
            .iter()
            .map(|(id, handle)| (*id, handle.clone()))
            .collect();

        for (id, handle) in handles {
            let cleanup_reason = {
                let mut session = handle.write().await;
                let reason = session.monitor_cleanup_reason();
                if reason.is_some() {
                    session.set_state(SessionState::Closing);
                }
                reason
            };
            if let Some(reason) = cleanup_reason {
                info!("[Monitor] auto-cleaning session {id}: {reason}");
                self.cleanup_owned(id, &handle).await;
            }
        }
    }

    pub fn start_monitor(self: &Arc<Self>) {
        let mgr = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(SESSION_MONITOR_INTERVAL).await;
                mgr.cleanup_terminal_and_expired_sessions().await;
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelling_one_pending_client_preserves_other_pending_clients() {
        let manager = SessionManager::new();
        let handle = manager
            .get_or_create(51, host_info("pending", 22, None))
            .await;
        handle.write().await.set_state(SessionState::Connecting);
        manager.attach_client(&handle).await;
        manager.attach_client(&handle).await;
        manager.finish_client(&handle, false).await;
        assert!(manager.get(51).await.is_some());
        assert_eq!(handle.read().await.ws_clients, 1);
        assert_eq!(handle.read().await.state, SessionState::Connecting);
        manager.finish_client(&handle, false).await;
        assert!(manager.get(51).await.is_none());
        assert_eq!(handle.read().await.state, SessionState::Closed);
    }

    struct FailedReplay {
        sent: usize,
    }
    impl futures::Stream for FailedReplay {
        type Item = Result<axum::extract::ws::Message, axum::Error>;
        fn poll_next(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            std::task::Poll::Pending
        }
    }
    impl futures::Sink<axum::extract::ws::Message> for FailedReplay {
        type Error = std::io::Error;
        fn poll_ready(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(if self.sent >= 2 {
                Err(std::io::ErrorKind::BrokenPipe.into())
            } else {
                Ok(())
            })
        }
        fn start_send(
            mut self: std::pin::Pin<&mut Self>,
            _: axum::extract::ws::Message,
        ) -> Result<(), Self::Error> {
            self.sent += 1;
            Ok(())
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_close(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Result<(), Self::Error>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn failed_history_replay_releases_only_its_own_client() {
        for other_client in [false, true] {
            let manager = SessionManager::new();
            let handle = manager.get_or_create(50, host_info("test", 22, None)).await;
            {
                let mut session = handle.write().await;
                session.conn = Some(Connection::Test);
                session.set_state(SessionState::Active);
                session.broadcast(b"saved output".to_vec());
            }
            if other_client {
                manager.attach_client(&handle).await;
            }
            let state = crate::auth::AppState {
                database_encryption: None,
                security: crate::security::AppSecurity::default(),
                db: sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
                vault: crate::vault::new_vault(),
                api_token: "test-token".into(),
                sessions: manager.clone(),
                sftp: crate::ssh::SftpManager::new(),
                quick_connect_tickets: crate::auth::QuickConnectTicketStore::new(),
                vault_unlock_limiter: crate::auth::VaultUnlockLimiter::new(),
            };
            let mut socket = FailedReplay { sent: 0 };
            manager.attach_client(&handle).await;
            crate::routers::sessions::run_attached_bridge(&mut socket, &state, &handle, 50, false)
                .await;
            assert_eq!(
                socket.sent, 2,
                "failure must occur while sending binary history"
            );
            let session = handle.read().await;
            assert_eq!(session.ws_clients, usize::from(other_client));
            assert_eq!(
                session.state,
                if other_client {
                    SessionState::Active
                } else {
                    SessionState::Detached
                }
            );
            drop(session);
            manager.cleanup(50).await;
        }
    }

    fn host_info(hostname: &str, port: i64, username: Option<&str>) -> serde_json::Value {
        serde_json::json!({
            "hostname": hostname,
            "port": port,
            "username": username,
            "connection_type": "ssh",
            "cols": 80,
            "rows": 24,
            "term": "xterm-256color",
            "connect_timeout_secs": 5,
            "keepalive_interval_secs": 0,
        })
    }

    fn host_info_with_credentials() -> serde_json::Value {
        let mut info = host_info("box.example", 22, Some("admin"));
        info["password"] = serde_json::Value::String("password-secret".into());
        info["private_key"] = serde_json::Value::String("private-key-secret".into());
        info["passphrase"] = serde_json::Value::String("passphrase-secret".into());
        info
    }

    #[tokio::test]
    async fn get_or_create_reuses_existing_session_for_same_id() {
        let mgr = SessionManager::new();
        let first = mgr
            .get_or_create(42, host_info("first.example", 22, Some("admin")))
            .await;
        let second = mgr
            .get_or_create(42, host_info("second.example", 2222, Some("other")))
            .await;

        assert!(Arc::ptr_eq(&first, &second));
        let session = second.read().await;
        assert_eq!(session.host_info["hostname"], "first.example");
        assert_eq!(session.host_info["port"], 22);
    }

    #[tokio::test]
    async fn different_session_ids_support_multiple_open_tabs() {
        let mgr = SessionManager::new();
        let first = mgr
            .get_or_create(1, host_info("same.example", 22, Some("admin")))
            .await;
        let second = mgr
            .get_or_create(2, host_info("same.example", 22, Some("admin")))
            .await;

        assert!(!Arc::ptr_eq(&first, &second));
        assert!(mgr.get(1).await.is_some());
        assert!(mgr.get(2).await.is_some());
    }

    #[tokio::test]
    async fn new_sessions_for_the_same_host_have_independent_javascript_safe_ids() {
        let mgr = SessionManager::new();
        let handles = futures::future::join_all(
            (0..128).map(|_| mgr.create(host_info("same.example", 22, Some("admin")))),
        )
        .await;
        let mut ids = std::collections::HashSet::new();
        for handle in handles {
            let id = handle.read().await.id;
            assert!((1..=(1_i64 << 53) - 1).contains(&id));
            assert!(ids.insert(id));
            assert!(Arc::ptr_eq(&handle, &mgr.get(id).await.unwrap()));
        }
    }

    #[tokio::test]
    async fn detach_only_marks_detached_for_last_websocket_client() {
        let mgr = SessionManager::new();
        let handle = mgr
            .get_or_create(7, host_info("box.example", 22, Some("admin")))
            .await;
        handle.write().await.set_state(SessionState::Active);

        assert_eq!(mgr.attach_client(&handle).await, 1);
        assert_eq!(mgr.attach_client(&handle).await, 2);
        mgr.detach(&handle).await;
        assert_eq!(handle.read().await.state, SessionState::Active);

        assert_eq!(mgr.release_client(&handle).await, 1);
        mgr.detach(&handle).await;
        assert_eq!(handle.read().await.state, SessionState::Detached);
    }

    #[tokio::test]
    async fn release_client_saturates_at_zero() {
        let mgr = SessionManager::new();
        let handle = mgr
            .get_or_create(8, host_info("box.example", 22, Some("admin")))
            .await;

        assert_eq!(mgr.release_client(&handle).await, 0);
        assert_eq!(mgr.attach_client(&handle).await, 1);
        assert_eq!(mgr.release_client(&handle).await, 0);
        assert_eq!(mgr.release_client(&handle).await, 0);
    }

    #[tokio::test]
    async fn detach_if_live_preserves_only_sessions_with_transport() {
        let mgr = SessionManager::new();
        let handle = mgr
            .get_or_create(9, host_info("box.example", 22, Some("admin")))
            .await;
        handle.write().await.set_state(SessionState::Active);

        assert!(!mgr.detach_if_live(&handle).await);
        assert_eq!(handle.read().await.state, SessionState::Active);

        {
            let mut session = handle.write().await;
            session.conn = Some(Connection::Test);
        }

        assert!(mgr.detach_if_live(&handle).await);
        let session = handle.read().await;
        assert_eq!(session.state, SessionState::Detached);
        assert!(matches!(session.conn, Some(Connection::Test)));
    }

    #[tokio::test]
    async fn connect_ssh_resumes_detached_transport_without_reconnect() {
        let mgr = SessionManager::new();
        let handle = mgr
            .get_or_create(10, host_info("box.example", 22, Some("admin")))
            .await;
        {
            let mut session = handle.write().await;
            session.conn = Some(Connection::Test);
            session.set_state(SessionState::Detached);
        }

        mgr.connect_ssh(&handle)
            .await
            .expect("live detached transport should resume before opening a network socket");

        let session = handle.read().await;
        assert_eq!(session.state, SessionState::Active);
        assert!(matches!(session.conn, Some(Connection::Test)));
    }

    #[tokio::test]
    async fn successful_connect_scrubs_credentials_and_preserves_detached_resume() {
        let mgr = SessionManager::new();
        let handle = mgr.get_or_create(13, host_info_with_credentials()).await;
        {
            let mut session = handle.write().await;
            session.conn = Some(Connection::Test);
            session.set_state(SessionState::Detached);
        }

        mgr.connect(&handle)
            .await
            .expect("live detached transport should resume");

        {
            let session = handle.read().await;
            assert_eq!(session.state, SessionState::Active);
            assert_eq!(session.host_info["hostname"], "box.example");
            assert_eq!(session.host_info["username"], "admin");
            for field in SESSION_SECRET_FIELDS {
                assert!(session.host_info.get(field).is_none());
            }
        }

        mgr.detach(&handle).await;
        mgr.connect(&handle)
            .await
            .expect("scrubbed session should resume its existing transport");
        assert_eq!(handle.read().await.state, SessionState::Active);
    }

    #[tokio::test]
    async fn successful_connect_scrubs_credentials_for_every_transport() {
        let mgr = SessionManager::new();

        for (offset, connection_type) in ["ssh", "telnet", "serial", "local"].iter().enumerate() {
            let mut info = host_info_with_credentials();
            info["connection_type"] = serde_json::Value::String((*connection_type).into());
            let handle = mgr.get_or_create(30 + offset as i64, info).await;
            {
                let mut session = handle.write().await;
                session.conn = Some(Connection::Test);
                session.set_state(SessionState::Detached);
            }

            mgr.connect(&handle)
                .await
                .expect("existing transport should resume");

            let session = handle.read().await;
            for field in SESSION_SECRET_FIELDS {
                assert!(session.host_info.get(field).is_none());
            }
        }
    }

    #[tokio::test]
    async fn connect_failure_removes_session_and_scrubs_retained_handle() {
        let mgr = SessionManager::new();
        let mut info = host_info_with_credentials();
        info["connection_type"] = serde_json::Value::String("serial".into());
        info["serial_port"] = serde_json::Value::String(String::new());
        let handle = mgr.get_or_create(14, info).await;

        let error = mgr
            .connect(&handle)
            .await
            .expect_err("missing serial port must fail");

        assert_eq!(error, "No serial port specified");
        assert!(mgr.get(14).await.is_none());
        let session = handle.read().await;
        assert_eq!(session.state, SessionState::Closed);
        for field in SESSION_SECRET_FIELDS {
            assert!(session.host_info.get(field).is_none());
        }
    }

    #[tokio::test]
    async fn late_connect_result_cleans_an_already_removed_handle() {
        let mgr = SessionManager::new();
        let handle = mgr.get_or_create(15, host_info_with_credentials()).await;
        {
            let mut session = handle.write().await;
            session.conn = Some(Connection::Test);
            session.set_state(SessionState::Detached);
        }
        mgr.inner.sessions.write().await.remove(&15);

        let error = mgr
            .connect(&handle)
            .await
            .expect_err("an unregistered session must not become active");

        assert_eq!(error, "Session connection was cancelled");
        let session = handle.read().await;
        assert_eq!(session.state, SessionState::Closed);
        assert!(session.conn.is_none());
        assert!(session.read_task.is_none());
        for field in SESSION_SECRET_FIELDS {
            assert!(session.host_info.get(field).is_none());
        }
    }

    #[tokio::test]
    async fn owned_cleanup_never_removes_a_replacement_with_the_same_id() {
        let mgr = SessionManager::new();
        let original = mgr
            .get_or_create(16, host_info("old.example", 22, None))
            .await;
        mgr.inner.sessions.write().await.remove(&16);
        let replacement = mgr
            .get_or_create(16, host_info("new.example", 22, None))
            .await;

        assert!(!mgr.cleanup_owned(16, &original).await);
        let registered = mgr
            .get(16)
            .await
            .expect("replacement must remain registered");
        assert!(Arc::ptr_eq(&registered, &replacement));
    }

    #[tokio::test]
    async fn monitor_cleans_terminal_and_expired_sessions_only() {
        let mgr = SessionManager::new();

        for (id, state, age) in [
            (20, SessionState::Failed, Duration::ZERO),
            (21, SessionState::Closed, Duration::ZERO),
            (
                22,
                SessionState::Connecting,
                CONNECTING_SESSION_TTL + Duration::from_secs(1),
            ),
            (
                23,
                SessionState::Detached,
                DETACHED_SESSION_TTL + Duration::from_secs(1),
            ),
        ] {
            let handle = mgr.get_or_create(id, host_info_with_credentials()).await;
            let mut session = handle.write().await;
            session.set_state(state);
            session.last_activity = Instant::now() - age;
            if state == SessionState::Detached {
                session.detached_since = Some(Instant::now() - age);
            }
        }

        for (id, state) in [
            (24, SessionState::Connecting),
            (25, SessionState::Detached),
            (26, SessionState::Active),
        ] {
            let handle = mgr.get_or_create(id, host_info("fresh", 22, None)).await;
            handle.write().await.set_state(state);
        }

        mgr.cleanup_terminal_and_expired_sessions().await;

        for removed_id in 20..=23 {
            assert!(mgr.get(removed_id).await.is_none());
        }
        for retained_id in 24..=26 {
            assert!(mgr.get(retained_id).await.is_some());
        }
    }

    #[tokio::test]
    async fn cleanup_survives_caller_cancellation_and_keeps_id_until_shutdown() {
        let mgr = SessionManager::new();
        let handle = mgr.get_or_create(91, host_info("test", 22, None)).await;
        let mut guard = handle.write().await;
        guard.conn = Some(Connection::Test);
        guard.set_state(SessionState::Active);
        let mut closing = Box::pin(mgr.cleanup(91));
        // Poll through the spawn; the owned cleanup must now wait for our lock.
        assert!(futures::poll!(&mut closing).is_pending());
        assert!(mgr.get(91).await.is_some());
        drop(closing);
        drop(guard);
        tokio::time::timeout(Duration::from_secs(2), async {
            while mgr.get(91).await.is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(handle.read().await.state, SessionState::Closed);
        assert!(!mgr.cleanup(91).await);
    }

    #[tokio::test]
    async fn cleanup_returns_status_and_removes_session() {
        let mgr = SessionManager::new();
        let handle = mgr
            .get_or_create(11, host_info("box.example", 22, Some("admin")))
            .await;
        {
            let mut session = handle.write().await;
            session.conn = Some(Connection::Test);
            session.set_state(SessionState::Active);
        }

        assert!(mgr.cleanup(11).await);
        assert!(mgr.get(11).await.is_none());
        assert!(!mgr.cleanup(11).await);
    }

    #[tokio::test]
    async fn subscribe_replays_terminal_history_for_reattach() {
        let mgr = SessionManager::new();
        let handle = mgr
            .get_or_create(12, host_info("box.example", 22, Some("admin")))
            .await;
        {
            let mut session = handle.write().await;
            session.broadcast(b"prompt$ ".to_vec());
            session.broadcast(b"uptime\n".to_vec());
        }

        let (history, _rx) = handle.read().await.subscribe();
        assert_eq!(history, vec![b"prompt$ ".to_vec(), b"uptime\n".to_vec()]);
    }

    #[tokio::test]
    async fn marker_bytes_remain_data_and_history_has_a_byte_budget() {
        let mut session = Session::new(1, host_info("test", 22, None));
        let (_, mut rx) = session.subscribe();
        let printed = b"\0NETRIX_SESSION_TRANSPORT_ENDED\0not a control";
        session.broadcast(printed.to_vec());
        assert!(
            matches!(rx.recv().await.unwrap(), SessionEvent::Data(data) if data.as_ref() == printed)
        );
        session.broadcast(vec![b'x'; SESSION_HISTORY_BYTES * 2]);
        assert!(session.history_bytes <= SESSION_HISTORY_BYTES);
        assert!(session
            .history
            .iter()
            .all(|data| data.len() <= SESSION_OUTPUT_CHUNK_BYTES));
        for _ in 0..SESSION_HISTORY_CHUNKS * 2 {
            session.broadcast(vec![b'x']);
        }
        assert!(session.history.len() <= SESSION_HISTORY_CHUNKS);
        session.set_state(SessionState::Detached);
        session.detached_since =
            Some(Instant::now() - DETACHED_SESSION_TTL - Duration::from_secs(1));
        session.broadcast(b"background output".to_vec());
        assert_eq!(session.monitor_cleanup_reason(), Some("detached timeout"));
    }

    #[tokio::test]
    async fn checkpoint_replay_slices_chunks_without_losing_live_output() {
        let mut session = Session::new(1, host_info("test", 22, None));
        session.broadcast(b"before".to_vec());
        session.broadcast(b"after".to_vec());
        let mut replay = session.subscribe_after(Some(3)).unwrap();
        assert_eq!(replay.start, 3);
        assert_eq!(replay.end, 11);
        assert_eq!(replay.history.concat(), b"oreafter");
        session.broadcast(b"live".to_vec());
        assert!(
            matches!(replay.receiver.recv().await.unwrap(), SessionEvent::Data(data) if data.as_ref() == b"live")
        );
        assert!(session.subscribe_after(Some(16)).is_err());
    }

    #[test]
    fn checkpoint_replay_refuses_evicted_output_instead_of_silently_skipping_it() {
        let mut session = Session::new(1, host_info("test", 22, None));
        session.broadcast(vec![
            b'x';
            SESSION_HISTORY_BYTES + SESSION_OUTPUT_CHUNK_BYTES
        ]);
        assert!(session.subscribe_after(Some(0)).is_err());
        let replay = session
            .subscribe_after(Some(session.output_offset))
            .unwrap();
        assert!(replay.history.is_empty());
        assert_eq!(replay.start, replay.end);
    }
}

// ─── russh client handler ───────────────────────────────────────────

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone)]
pub(crate) struct SshHandler {
    known_hosts: KnownHostsStore,
    hostname: String,
    port: u16,
    /// Populated after check_server_key runs.
    key_result: Arc<Mutex<Option<HostKeyResult>>>,
}

impl SshHandler {
    fn new(known_hosts: KnownHostsStore, hostname: String, port: u16) -> Self {
        Self {
            known_hosts,
            hostname,
            port,
            key_result: Arc::new(Mutex::new(None)),
        }
    }
}

impl client::Handler for SshHandler {
    type Error = anyhow::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // Certificate authorities are not configured in Netrix. Do not silently
        // treat a certificate as a trusted raw key when upgrading russh.
        let PublicKeyOrCertificate::PublicKey {
            key: server_public_key,
            ..
        } = server_public_key
        else {
            return Ok(false);
        };
        let policy = &crate::config::SETTINGS.ssh_known_hosts_policy;

        if policy.eq_ignore_ascii_case("insecure") {
            return Ok(true);
        }

        // Extract key type and bytes for fingerprinting.
        let algorithm = server_public_key.algorithm();
        let key_type = algorithm.as_str();
        let key_bytes = server_public_key.public_key_bytes();

        let result = self
            .known_hosts
            .check(&self.hostname, self.port, key_type, &key_bytes)
            .await;

        let accept = match &result {
            HostKeyResult::TrustedNew => {
                info!(
                    "[SSH] TOFU: accepted new {} key for {}:{}",
                    key_type, self.hostname, self.port
                );
                true
            }
            HostKeyResult::TrustedKnown => {
                debug!(
                    "[SSH] Host key verified for {}:{}",
                    self.hostname, self.port
                );
                true
            }
            HostKeyResult::Mismatch { expected, got } => {
                warn!(
                    "[SSH] HOST KEY MISMATCH for {}:{} — expected {}, got {}. \
                     Possible MITM attack! Connection REJECTED.",
                    self.hostname, self.port, expected, got
                );
                false
            }
            HostKeyResult::StorageError { message } => {
                warn!(
                    "[SSH] Host-key trust storage failed for {}:{}: {}. Connection rejected.",
                    self.hostname, self.port, message
                );
                false
            }
        };

        *self.key_result.lock().await = Some(result);
        Ok(accept)
    }
}
