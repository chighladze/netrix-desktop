//! Isolated SFTP connection leases, bounded reuse and end-to-end deadlines.
use super::*;
use std::collections::HashMap;
use std::sync::Weak;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout, Instant};
use tokio_util::sync::CancellationToken;

use crate::ssh::sftp_transfers::{Transfer, TransferRegistry};

const OPERATION_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const IDLE_TTL: Duration = Duration::from_secs(60);

type Wire = russh::ChannelStream<client::Msg>;

struct DisconnectOnDrop(Option<client::Handle<SftpProbeHandler>>);
impl Drop for DisconnectOnDrop {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = timeout(
                        Duration::from_secs(2),
                        handle.disconnect(russh::Disconnect::ByApplication, "SFTP closed", ""),
                    )
                    .await;
                });
            }
        }
    }
}

struct Connection {
    client: SftpV3Client<Wire>,
    handle: DisconnectOnDrop,
}

struct Idle {
    connection: Connection,
    since: Instant,
    host_id: i64,
    _scope: Arc<CancellationToken>,
}

#[derive(Default)]
struct PoolState {
    idle: HashMap<[u8; 32], Idle>,
    scopes: HashMap<i64, Weak<CancellationToken>>,
}

impl PoolState {
    fn scope(&mut self, host_id: i64) -> Arc<CancellationToken> {
        self.scopes.retain(|_, scope| scope.strong_count() > 0);
        if let Some(scope) = self.scopes.get(&host_id).and_then(Weak::upgrade) {
            return scope;
        }
        let scope = Arc::new(CancellationToken::new());
        self.scopes.insert(host_id, Arc::downgrade(&scope));
        scope
    }

    fn disconnect_host(&mut self, host_id: i64) {
        if let Some(scope) = self
            .scopes
            .remove(&host_id)
            .and_then(|scope| scope.upgrade())
        {
            scope.cancel();
        }
        self.idle.retain(|_, entry| entry.host_id != host_id);
    }
}

struct Pool {
    state: Mutex<PoolState>,
    slots: Arc<Semaphore>,
    nonce: [u8; 32],
}

#[derive(Clone)]
pub struct SftpManager {
    known_hosts: KnownHostsStore,
    pool: Arc<Pool>,
    pub transfers: TransferRegistry,
}

struct Lease {
    connection: Connection,
    pool: Arc<Pool>,
    key: [u8; 32],
    host_id: i64,
    scope: Arc<CancellationToken>,
    _slot: OwnedSemaphorePermit,
}

impl Lease {
    fn client(&mut self) -> &mut SftpV3Client<Wire> {
        &mut self.connection.client
    }

    async fn finish(self, healthy: bool) {
        let connection = self.connection;
        if !healthy
            || connection
                .handle
                .0
                .as_ref()
                .is_none_or(|handle| handle.is_closed())
        {
            return;
        }
        {
            let mut state = self.pool.state.lock().await;
            if self.scope.is_cancelled() {
                return;
            }
            let idle = &mut state.idle;
            idle.retain(|_, entry| entry.since.elapsed() < IDLE_TTL);
            if idle.len() >= 8 {
                if let Some(key) = idle
                    .iter()
                    .min_by_key(|(_, entry)| entry.since)
                    .map(|(key, _)| *key)
                {
                    idle.remove(&key);
                }
            }
            idle.insert(
                self.key,
                Idle {
                    connection,
                    since: Instant::now(),
                    host_id: self.host_id,
                    _scope: self.scope,
                },
            );
        }
    }
}

impl SftpManager {
    pub fn new() -> Self {
        Self::with_known_hosts(KnownHostsStore::new())
    }

    pub fn with_known_hosts(known_hosts: KnownHostsStore) -> Self {
        let pool = Arc::new(Pool {
            state: Mutex::new(PoolState::default()),
            slots: Arc::new(Semaphore::new(4)),
            nonce: rand::random(),
        });
        let weak = Arc::downgrade(&pool);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(15)).await;
                    let Some(pool) = weak.upgrade() else {
                        break;
                    };
                    let mut state = pool.state.lock().await;
                    state
                        .idle
                        .retain(|_, entry| entry.since.elapsed() < IDLE_TTL);
                    state.scopes.retain(|_, scope| scope.strong_count() > 0);
                }
            });
        }
        Self {
            known_hosts,
            pool,
            transfers: TransferRegistry::default(),
        }
    }

    // Include all authentication inputs and the current trust entry. Keep only a
    // process-salted cryptographic digest in the cache, never credential strings.
    async fn key(&self, target: &SftpProbeTarget) -> Result<[u8; 32], SftpProbeError> {
        use sha2::{Digest, Sha256};
        let trust = self
            .known_hosts
            .list()
            .await
            .map_err(|error| SftpProbeError::Connect(error.to_string()))?
            .into_iter()
            .find(|(host, _)| host == &format!("{}:{}", target.hostname, target.port))
            .map(|(_, key)| key)
            .unwrap_or_default();
        let mut hash = Sha256::new();
        hash.update(self.pool.nonce);
        hash.update(target.host_id.to_be_bytes());
        for value in [
            Some(target.hostname.as_str()),
            Some(target.username.as_str()),
            target.password.as_deref(),
            target.private_key.as_deref(),
            target.passphrase.as_deref(),
            Some(trust.as_str()),
            Some(crate::config::SETTINGS.ssh_known_hosts_policy.as_str()),
        ] {
            hash.update([u8::from(value.is_some())]);
            let value = value.unwrap_or_default().as_bytes();
            hash.update((value.len() as u64).to_be_bytes());
            hash.update(value);
        }
        hash.update(target.port.to_be_bytes());
        Ok(hash.finalize().into())
    }

    async fn acquire(&self, target: &SftpProbeTarget) -> Result<Lease, SftpProbeError> {
        let setup_timeout = target.connect_timeout_secs.clamp(5, 120);
        let scope = self.pool.state.lock().await.scope(target.host_id);
        let prepare = timeout(Duration::from_secs(setup_timeout), async {
            let slot = self
                .pool
                .slots
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| SftpProbeError::Connect("SFTP is shutting down".into()))?;
            let key = self.key(target).await?;
            let cached = self.pool.state.lock().await.idle.remove(&key);
            let connection = match cached {
                Some(entry)
                    if entry.since.elapsed() < IDLE_TTL
                        && entry
                            .connection
                            .handle
                            .0
                            .as_ref()
                            .is_some_and(|handle| !handle.is_closed()) =>
                {
                    entry.connection
                }
                _ => self.connect(target).await?,
            };
            Ok(Lease {
                connection,
                pool: self.pool.clone(),
                key: self.key(target).await?,
                host_id: target.host_id,
                scope: scope.clone(),
                _slot: slot,
            })
        });
        tokio::select! {
            biased;
            _ = scope.cancelled() => Err(SftpProbeError::Connect("SFTP host was disconnected before setup completed".into())),
            result = prepare => result.map_err(|_| {
                SftpProbeError::Connect(format!(
                    "SSH authentication / SFTP setup timed out after {setup_timeout} seconds"
                ))
            })?,
        }
    }

    async fn connect(&self, target: &SftpProbeTarget) -> Result<Connection, SftpProbeError> {
        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(60)),
            keepalive_interval: Some(Duration::from_secs(10)),
            keepalive_max: 3,
            ..Default::default()
        });
        let handler = SftpProbeHandler::new(
            self.known_hosts.clone(),
            target.hostname.clone(),
            target.port,
        );
        let handle = match client::connect(
            config,
            (target.hostname.as_str(), target.port),
            handler.clone(),
        )
        .await
        {
            Ok(handle) => handle,
            Err(error) => {
                match handler.key_result.lock().await.as_ref() {
                    Some(HostKeyResult::Mismatch { .. }) => {
                        return Err(SftpProbeError::HostKeyMismatch)
                    }
                    Some(HostKeyResult::StorageError { message }) => {
                        return Err(SftpProbeError::Connect(message.clone()))
                    }
                    _ => {}
                }
                return Err(SftpProbeError::Connect(error.to_string()));
            }
        };
        let mut handle = DisconnectOnDrop(Some(handle));
        let Some(ssh) = handle.0.as_mut() else {
            return Err(SftpProbeError::Connect("SSH connection closed".into()));
        };
        if !authenticate(
            ssh,
            &target.username,
            target.password.as_deref(),
            target.private_key.as_deref(),
            target.passphrase.as_deref(),
        )
        .await
        {
            return Err(SftpProbeError::AuthFailed);
        }
        let mut channel = ssh
            .channel_open_session()
            .await
            .map_err(|error| SftpProbeError::Probe(format!("channel open: {error}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| {
                SftpProbeError::Unsupported(user_facing_subsystem_rejection(&error.to_string()))
            })?;
        // request_subsystem only queues the SSH request. Consume its reply
        // explicitly; ChannelStream ignores control messages such as Failure.
        loop {
            match channel.wait().await {
                Some(russh::ChannelMsg::Success) => break,
                Some(
                    russh::ChannelMsg::Failure | russh::ChannelMsg::Eof | russh::ChannelMsg::Close,
                )
                | None => {
                    return Err(SftpProbeError::Unsupported(
                        "Remote SSH server rejected the SFTP subsystem".into(),
                    ));
                }
                Some(russh::ChannelMsg::Data { .. } | russh::ChannelMsg::ExtendedData { .. }) => {
                    return Err(SftpProbeError::Probe(
                        "Unexpected data before SFTP subsystem acceptance".into(),
                    ));
                }
                Some(_) => {}
            }
        }
        let mut client = SftpV3Client::new(channel.into_stream());
        client.init().await.map_err(SftpProbeError::Probe)?;
        Ok(Connection { client, handle })
    }

    pub async fn clear_idle(&self) {
        let mut state = self.pool.state.lock().await;
        for scope in state.scopes.values().filter_map(Weak::upgrade) {
            scope.cancel();
        }
        state.scopes.clear();
        state.idle.clear();
    }

    pub async fn disconnect_host(&self, host_id: i64) {
        self.pool.state.lock().await.disconnect_host(host_id);
    }

    pub async fn probe(&self, target: SftpProbeTarget) -> Result<SftpProbeStatus, SftpProbeError> {
        match self.acquire(&target).await {
            Ok(lease) => {
                lease.finish(true).await;
                Ok(SftpProbeStatus::Supported)
            }
            Err(SftpProbeError::Unsupported(reason)) => Ok(SftpProbeStatus::Unsupported(reason)),
            Err(error) => Err(error),
        }
    }

    pub async fn list_dir(
        &self,
        target: SftpProbeTarget,
        path: &str,
    ) -> Result<SftpListResult, SftpProbeError> {
        let mut lease = self.acquire(&target).await?;
        let result = timeout(Duration::from_secs(30), lease.client().list_dir(path))
            .await
            .map_err(|_| "SFTP listing timed out".to_string())
            .and_then(|result| result);
        lease.finish(result.is_ok()).await;
        result.map_err(SftpProbeError::Probe)
    }

    pub async fn read_file(
        &self,
        target: SftpProbeTarget,
        path: &str,
        max_bytes: usize,
        allow_truncate: bool,
    ) -> Result<SftpFileResult, SftpProbeError> {
        let mut lease = self.acquire(&target).await?;
        let result = timeout(
            Duration::from_secs(60),
            lease.client().read_file(path, max_bytes, allow_truncate),
        )
        .await
        .map_err(|_| "SFTP preview timed out".to_string())
        .and_then(|result| result);
        lease.finish(result.is_ok()).await;
        result.map_err(SftpProbeError::Probe)
    }

    pub async fn mutate(
        &self,
        target: SftpProbeTarget,
        action: &str,
        path: &str,
        destination: Option<&str>,
        permissions: Option<u32>,
    ) -> Result<(), SftpProbeError> {
        let mut lease = self.acquire(&target).await?;
        let result = timeout(
            Duration::from_secs(30),
            lease
                .client()
                .mutate(action, path, destination, permissions),
        )
        .await
        .map_err(|_| {
            "SFTP operation timed out; refresh the directory to check its result".to_string()
        })
        .and_then(|result| result);
        lease.finish(result.is_ok()).await;
        result.map_err(SftpProbeError::Probe)
    }

    pub async fn upload_stream<R: AsyncRead + Unpin + Send>(
        &self,
        target: SftpProbeTarget,
        reader: R,
        job: &Transfer,
        max_bytes: usize,
    ) -> Result<SftpUploadResult, SftpProbeError> {
        let cancel = job.cancel.clone();
        let mut lease = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(SftpProbeError::Probe("Transfer cancelled".into())),
            result = self.acquire(&target) => result?,
        };
        let info = job.info();
        let temporary = sibling_temporary_path(&info.path);
        let mut created = TemporaryState::Unused;
        job.state("running");
        let result = lease
            .client()
            .upload_atomic(&info.path, &temporary, reader, job, max_bytes, &mut created)
            .await;
        if let Err(error) = &result {
            // Reserve this job's slot for cleanup so queued uploads cannot
            // starve it. A poisoned connection must never return to the pool.
            let _slot = lease._slot;
            drop(lease.connection);
            match created {
                TemporaryState::Unused => return Err(SftpProbeError::Probe(error.clone())),
                TemporaryState::Unconfirmed => return Err(SftpProbeError::Probe(format!("{error}. Temporary creation was not confirmed; inspect {temporary} before removing it."))),
                TemporaryState::Owned => {}
            }
            // A cancelled/failed request may leave the packet stream out of sync.
            // Reconnect for cleanup; never send REMOVE on a poisoned stream.
            let cleanup = timeout(Duration::from_secs(10), async {
                let mut last_error = String::new();
                for attempt in 0..5 {
                    // Windows servers may still be closing the old channel's
                    // file handle when a replacement connection first arrives.
                    if attempt > 0 {
                        tokio::time::sleep(Duration::from_millis(100 * (1 << attempt))).await;
                    }
                    let mut cleanup = self.connect(&target).await.map_err(|e| e.to_string())?;
                    let result = cleanup.client.remove_if_exists(&temporary).await;
                    drop(cleanup);
                    match result {
                        Ok(()) => return Ok(()),
                        Err(error) => last_error = error,
                    }
                }
                Err(last_error)
            })
            .await;
            if !matches!(cleanup, Ok(Ok(()))) {
                return Err(SftpProbeError::Probe(format!(
                    "{error}. A temporary upload may remain at {temporary}"
                )));
            }
        } else {
            lease.finish(true).await;
        }
        result.map_err(SftpProbeError::Probe)
    }

    pub async fn download_stream(
        &self,
        target: SftpProbeTarget,
        path: &str,
        job: &Transfer,
        max_bytes: usize,
        output: mpsc::Sender<Result<Bytes, std::io::Error>>,
    ) -> Result<(), SftpProbeError> {
        let cancel: CancellationToken = job.cancel.clone();
        let mut lease = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(SftpProbeError::Probe("Transfer cancelled".into())),
            _ = output.closed() => { let _ = job.request_cancel(); return Err(SftpProbeError::Probe("Download destination closed".into())); },
            result = self.acquire(&target) => result?,
        };
        job.state("running");
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Transfer cancelled".into()),
            _ = output.closed() => { let _ = job.request_cancel(); Err("Download destination closed".into()) },
            result = timeout(OPERATION_TIMEOUT, lease.client().download_to(path, max_bytes, job, &output)) => result.map_err(|_| "Download exceeded the 15 minute transfer limit".to_string()).and_then(|result| result),
        };
        lease.finish(result.is_ok()).await;
        result.map_err(SftpProbeError::Probe)
    }
}

impl Default for SftpManager {
    fn default() -> Self {
        Self::new()
    }
}

fn sibling_temporary_path(path: &str) -> String {
    let parent = path
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or(".");
    format!("{parent}/.netrix-{}.part", uuid::Uuid::new_v4().simple())
}
