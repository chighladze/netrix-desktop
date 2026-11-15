//! Bounded, in-memory transfer jobs. File bytes and credentials never enter this registry.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio_util::sync::CancellationToken;

const MAX_ACTIVE: usize = 8;
const MAX_HISTORY: usize = 128;

#[derive(Clone, Debug, Serialize)]
pub struct TransferInfo {
    pub id: String,
    pub host_id: i64,
    pub kind: String,
    pub path: String,
    pub status: String,
    pub bytes_done: u64,
    pub bytes_total: Option<u64>,
    pub overwrite: bool,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl TransferInfo {
    pub fn is_terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "failed" | "cancelled")
    }
}

struct Job {
    info: TransferInfo,
    claimed: bool,
    created: std::time::Instant,
}

#[derive(Clone)]
pub struct Transfer {
    job: Arc<Mutex<Job>>,
    pub cancel: CancellationToken,
}

impl Transfer {
    pub fn info(&self) -> TransferInfo {
        let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if !job.claimed && !job.info.is_terminal() && job.created.elapsed().as_secs() >= 60 {
            self.cancel.cancel();
            job.info.status = "cancelled".into();
            job.info.error = Some("Transfer was not started within 60 seconds".into());
            job.info.updated_at = chrono::Utc::now().timestamp_millis();
        }
        job.info.clone()
    }

    pub fn state(&self, status: &str) {
        let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if !job.info.is_terminal() && !self.cancel.is_cancelled() {
            job.info.status = status.into();
            job.info.updated_at = chrono::Utc::now().timestamp_millis();
        }
    }

    pub fn progress(&self, bytes: u64) {
        let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        job.info.bytes_done += bytes;
        job.info.updated_at = chrono::Utc::now().timestamp_millis();
    }

    pub fn total(&self, total: Option<u64>) {
        self.job
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .info
            .bytes_total = total;
    }

    pub fn warn(&self, message: String) {
        let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        job.info.warning = Some(message.chars().take(4096).collect());
        job.info.updated_at = chrono::Utc::now().timestamp_millis();
    }

    /// Linearizes cancellation with the irreversible rename. Never report a
    /// successful rename as cancelled, or cancel midway through its acknowledgement.
    pub fn begin_commit(&self) -> Result<(), String> {
        let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if self.cancel.is_cancelled() {
            return Err("Transfer cancelled".into());
        }
        job.info.status = "committing".into();
        job.info.updated_at = chrono::Utc::now().timestamp_millis();
        Ok(())
    }

    pub fn request_cancel(&self) -> Result<(), String> {
        let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        if job.info.is_terminal() {
            return Ok(());
        }
        if job.info.status == "committing" {
            return Err("The server is committing this file; wait for the result".into());
        }
        self.cancel.cancel();
        job.info.status = if job.claimed {
            "cancelling"
        } else {
            "cancelled"
        }
        .into();
        job.info.updated_at = chrono::Utc::now().timestamp_millis();
        Ok(())
    }

    pub fn finish(&self, result: Result<(), String>) {
        let mut job = self.job.lock().unwrap_or_else(|e| e.into_inner());
        let cancelled = self.cancel.is_cancelled() && job.info.status != "committing";
        job.info.status = match &result {
            Ok(()) => "completed",
            Err(_) if cancelled => "cancelled",
            Err(_) => "failed",
        }
        .into();
        job.info.error = result
            .err()
            .map(|message| message.chars().take(4096).collect());
        job.info.updated_at = chrono::Utc::now().timestamp_millis();
    }
}

/// Cancels a worker if its HTTP caller disappears. The worker still owns its
/// workspace lease and performs bounded cleanup before releasing it.
pub struct CancelOnDrop(pub Transfer);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        let _ = self.0.request_cancel();
    }
}

pub struct WorkerGuard(pub Transfer);
impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if !self.0.info().is_terminal() {
            self.0
                .finish(Err("Transfer worker stopped unexpectedly".into()));
        }
    }
}

#[derive(Clone, Default)]
pub struct TransferRegistry(Arc<Mutex<HashMap<String, Transfer>>>);

impl TransferRegistry {
    pub fn create(
        &self,
        host_id: i64,
        kind: &str,
        path: String,
        bytes_total: Option<u64>,
        overwrite: bool,
    ) -> Result<Transfer, String> {
        let mut jobs = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if jobs
            .values()
            .filter(|job| !job.info().is_terminal())
            .count()
            >= MAX_ACTIVE
        {
            return Err("At most 8 SFTP transfers can be queued or running".into());
        }
        if jobs.len() >= MAX_HISTORY {
            let oldest = jobs
                .iter()
                .filter(|(_, job)| job.info().is_terminal())
                .min_by_key(|(_, job)| job.info().updated_at)
                .map(|(id, _)| id.clone());
            if let Some(id) = oldest {
                jobs.remove(&id);
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let transfer = Transfer {
            job: Arc::new(Mutex::new(Job {
                claimed: false,
                created: std::time::Instant::now(),
                info: TransferInfo {
                    id: id.clone(),
                    host_id,
                    kind: kind.into(),
                    path,
                    status: "queued".into(),
                    bytes_done: 0,
                    bytes_total,
                    overwrite,
                    error: None,
                    warning: None,
                    created_at: now,
                    updated_at: now,
                },
            })),
            cancel: CancellationToken::new(),
        };
        jobs.insert(id, transfer.clone());
        Ok(transfer)
    }

    pub fn get(&self, id: &str) -> Option<Transfer> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }

    pub fn claim(
        &self,
        id: &str,
        host_id: i64,
        kind: &str,
        path: &str,
    ) -> Result<Transfer, String> {
        let transfer = self.get(id).ok_or("Transfer not found")?;
        transfer.info(); // Expire unclaimed jobs before inspecting their state.
        {
            let mut job = transfer.job.lock().unwrap_or_else(|e| e.into_inner());
            if job.claimed || job.info.is_terminal() {
                return Err("Transfer has already been started or cancelled".into());
            }
            if job.info.host_id != host_id || job.info.kind != kind || job.info.path != path {
                return Err("Transfer does not match this host, path or direction".into());
            }
            job.claimed = true;
            job.info.status = "connecting".into();
        }
        Ok(transfer)
    }

    pub fn list(&self) -> Vec<TransferInfo> {
        let mut jobs: Vec<_> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .map(Transfer::info)
            .collect();
        jobs.sort_by_key(|job| std::cmp::Reverse(job.created_at));
        jobs
    }

    pub fn has_active(&self) -> bool {
        self.list().iter().any(|job| !job.is_terminal())
    }

    pub fn clear_finished(&self) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, job| !job.info().is_terminal());
    }

    pub fn cancel_host(&self, host_id: i64) {
        let jobs: Vec<_> = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect();
        for job in jobs {
            if job.info().host_id == host_id {
                let _ = job.request_cancel();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn claim_is_bound_to_request_and_single_use() {
        let jobs = TransferRegistry::default();
        let t = jobs
            .create(1, "upload", "/a".into(), Some(4), false)
            .unwrap();
        let id = t.info().id;
        assert!(jobs.claim(&id, 2, "upload", "/a").is_err());
        jobs.claim(&id, 1, "upload", "/a").unwrap();
        assert!(jobs.claim(&id, 1, "upload", "/a").is_err());
        t.begin_commit().unwrap();
        assert!(t.request_cancel().is_err());
        t.finish(Ok(()));
        assert_eq!(t.info().status, "completed");
    }
    #[tokio::test]
    async fn cancellation_wins_before_commit_and_registry_is_bounded() {
        let jobs = TransferRegistry::default();
        for _ in 0..MAX_ACTIVE {
            jobs.create(1, "upload", "/a".into(), None, false).unwrap();
        }
        assert!(jobs.create(1, "upload", "/a".into(), None, false).is_err());
        jobs.cancel_host(1);
        assert!(!jobs.has_active());
        let t = jobs.create(1, "upload", "/a".into(), None, false).unwrap();
        jobs.claim(&t.info().id, 1, "upload", "/a").unwrap();
        t.request_cancel().unwrap();
        assert!(t.begin_commit().is_err());
        t.finish(Err("cancelled".into()));
        assert_eq!(t.info().status, "cancelled");
    }
}
