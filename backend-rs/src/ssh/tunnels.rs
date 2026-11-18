//! Loopback-only local forwarding and SOCKS5 CONNECT over isolated SSH connections.
use super::manager::{SessionManager, SshHandler};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{oneshot, Mutex, OwnedMutexGuard, Semaphore},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TunnelRule {
    pub id: String,
    pub name: String,
    pub host_id: i64,
    pub kind: String,
    pub bind_port: i64,
    pub destination_host: Option<String>,
    pub destination_port: Option<i64>,
}
impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for TunnelRule {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        use sqlx::Row;
        Ok(Self {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            host_id: row.try_get("host_id")?,
            kind: row.try_get("kind")?,
            bind_port: row.try_get("bind_port")?,
            destination_host: row.try_get("destination_host")?,
            destination_port: row.try_get("destination_port")?,
        })
    }
}
struct Job {
    _slot: tokio::sync::OwnedSemaphorePermit,
    host_id: i64,
    port: Option<u16>,
    generation: uuid::Uuid,
    stop: CancellationToken,
    task: JoinHandle<()>,
}
impl Drop for Job {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Job {
    async fn stop(mut self) {
        self.stop.cancel();
        if tokio::time::timeout(Duration::from_secs(3), &mut self.task)
            .await
            .is_err()
        {
            self.task.abort();
            let _ = (&mut self.task).await;
        }
    }
}
pub struct TunnelManager {
    jobs: Mutex<HashMap<String, Job>>,
    slots: Arc<Semaphore>,
    registration_gate: Arc<Mutex<()>>,
}
impl Default for TunnelManager {
    fn default() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            slots: Arc::new(Semaphore::new(16)),
            registration_gate: Arc::new(Mutex::new(())),
        }
    }
}
impl TunnelManager {
    /// Serialize saved-rule lookup/registration with rule and host deletion.
    /// Release as soon as the cancellable job is registered, before network IO.
    pub fn registration_gate(&self) -> Arc<Mutex<()>> {
        self.registration_gate.clone()
    }
    pub async fn status(&self, id: &str) -> Option<u16> {
        self.jobs
            .lock()
            .await
            .get(id)
            .filter(|job| !job.task.is_finished())
            .and_then(|job| job.port)
    }
    pub async fn is_empty(&self) -> bool {
        self.jobs
            .lock()
            .await
            .retain(|_, job| !job.task.is_finished());
        self.slots.available_permits() == 16
    }
    pub async fn stop_host(&self, host_id: i64) {
        let ids: Vec<_> = self
            .jobs
            .lock()
            .await
            .iter()
            .filter(|(_, job)| job.host_id == host_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.stop(&id).await;
        }
    }
    pub async fn stop(&self, id: &str) -> bool {
        let job = self.jobs.lock().await.remove(id);
        if let Some(job) = job {
            job.stop().await;
            true
        } else {
            false
        }
    }

    pub(crate) async fn shutdown(&self) {
        self.slots.close();
        let jobs = std::mem::take(&mut *self.jobs.lock().await);
        futures::future::join_all(jobs.into_values().map(Job::stop)).await;
    }
    pub async fn start(
        &self,
        sessions: &SessionManager,
        rule: TunnelRule,
        target: serde_json::Value,
    ) -> Result<u16, String> {
        self.start_registered(sessions, rule, target, None).await
    }

    pub async fn start_registered(
        &self,
        sessions: &SessionManager,
        rule: TunnelRule,
        target: serde_json::Value,
        registration: Option<OwnedMutexGuard<()>>,
    ) -> Result<u16, String> {
        let mut jobs = self.jobs.lock().await;
        jobs.retain(|_, job| !job.task.is_finished());
        if jobs.contains_key(&rule.id) {
            return Err("Tunnel is already running or connecting".into());
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "At most 16 tunnels may run or connect at once".to_string())?;
        let stop = CancellationToken::new();
        let cancelled = stop.clone();
        let (ready, initialized) = oneshot::channel();
        let generation = uuid::Uuid::new_v4();
        let id = rule.id.clone();
        let host_id = rule.host_id;
        let known_hosts = sessions.known_hosts().clone();
        let task = tokio::spawn(async move {
            let setup = async {
                let listener = tokio::select! {
                    biased;
                    _ = cancelled.cancelled() => return Err("Tunnel start cancelled".to_string()),
                    result = TcpListener::bind(("127.0.0.1", rule.bind_port as u16)) => result.map_err(|e| format!("Cannot bind local port: {e}"))?,
                };
                let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                let connection = SessionManager::tunnel_client(known_hosts, &target, &cancelled).await?;
                Ok((listener, port, connection))
            }.await;
            let (listener, port, connection) = match setup {
                Ok(result) => result,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            let connection = Arc::new(connection);
            if ready.send(Ok(port)).is_err() {
                cancelled.cancel();
            }
            let slots = Arc::new(Semaphore::new(32));
            let mut clients = JoinSet::new();
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                tokio::select! {
                    biased;
                    _=cancelled.cancelled()=>break,
                    _=interval.tick()=>if connection.is_closed() {break;},
                    Some(_)=clients.join_next(), if !clients.is_empty()=>{},
                    incoming=listener.accept()=>match incoming {
                        Ok((socket,_))=>{ if let Ok(permit)=slots.clone().try_acquire_owned() {
                            let connection=connection.clone();let rule=rule.clone();
                            clients.spawn(async move { let _permit=permit; let _=bridge(socket,connection,rule).await; });
                        } },
                        Err(_)=>break,
                    }
                }
            }
            clients.abort_all();
            while clients.join_next().await.is_some() {}
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                connection.disconnect(russh::Disconnect::ByApplication, "tunnel stopped", ""),
            )
            .await;
        });
        jobs.insert(
            id.clone(),
            Job {
                _slot: slot,
                host_id,
                port: None,
                generation,
                stop,
                task,
            },
        );
        drop(jobs);
        drop(registration);
        let result = initialized
            .await
            .unwrap_or_else(|_| Err("Tunnel start cancelled".into()));
        let mut jobs = self.jobs.lock().await;
        let Some(job) = jobs.get_mut(&id).filter(|job| job.generation == generation) else {
            return Err("Tunnel start cancelled".into());
        };
        match result {
            Ok(port) if !job.stop.is_cancelled() && !job.task.is_finished() => {
                job.port = Some(port);
                Ok(port)
            }
            result => {
                jobs.remove(&id);
                Err(result
                    .err()
                    .unwrap_or_else(|| "Tunnel start cancelled".into()))
            }
        }
    }
}
async fn socks_destination(socket: &mut TcpStream) -> std::io::Result<(String, u16)> {
    let mut greeting = [0; 2];
    socket.read_exact(&mut greeting).await?;
    if greeting[0] != 5 || greeting[1] == 0 {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut methods = vec![0; greeting[1] as usize];
    socket.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        socket.write_all(&[5, 255]).await?;
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    socket.write_all(&[5, 0]).await?;
    let mut request = [0; 4];
    socket.read_exact(&mut request).await?;
    if request[0] != 5 || request[1] != 1 || request[2] != 0 {
        socket.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(std::io::ErrorKind::Unsupported.into());
    }
    let host = match request[3] {
        1 => {
            let mut address = [0; 4];
            socket.read_exact(&mut address).await?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        4 => {
            let mut address = [0; 16];
            socket.read_exact(&mut address).await?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        3 => {
            let size = socket.read_u8().await? as usize;
            if size == 0 {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            let mut address = vec![0; size];
            socket.read_exact(&mut address).await?;
            String::from_utf8(address)
                .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidData))?
        }
        _ => {
            socket.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            return Err(std::io::ErrorKind::Unsupported.into());
        }
    };
    let port = socket.read_u16().await?;
    if port == 0 || host.contains(['\0', '\r', '\n']) {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    Ok((host, port))
}
async fn bridge(
    mut socket: TcpStream,
    connection: Arc<russh::client::Handle<SshHandler>>,
    rule: TunnelRule,
) -> Result<(), String> {
    let dynamic = rule.kind == "dynamic";
    let (host, port) = if dynamic {
        tokio::time::timeout(Duration::from_secs(10), socks_destination(&mut socket))
            .await
            .map_err(|_| "SOCKS handshake timed out")?
            .map_err(|e| e.to_string())?
    } else {
        (
            rule.destination_host.unwrap_or_default(),
            rule.destination_port.unwrap_or(0) as u16,
        )
    };
    let peer = socket.peer_addr().map_err(|e| e.to_string())?;
    let channel = tokio::time::timeout(
        Duration::from_secs(10),
        connection.channel_open_direct_tcpip(
            host,
            u32::from(port),
            peer.ip().to_string(),
            u32::from(peer.port()),
        ),
    )
    .await;
    let channel = match channel {
        Ok(Ok(channel)) => channel,
        _ => {
            if dynamic {
                let _ = socket.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err("SSH server rejected TCP forwarding".into());
        }
    };
    if dynamic {
        socket
            .write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0])
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut remote = channel.into_stream();
    tokio::io::copy_bidirectional(&mut socket, &mut remote)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
