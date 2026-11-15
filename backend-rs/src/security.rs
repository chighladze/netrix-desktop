//! Process-wide application lock. Vault-only locking deliberately keeps sessions usable.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::{
    auth::AppState,
    error::{AppError, AppResult},
    vault,
};

#[derive(Clone, Default)]
pub struct AppSecurity {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    locked: AtomicBool,
    revision: AtomicU64,
    // Serialize lock/unlock, vault mutation and policy/activity decisions.
    transition: Mutex<()>,
    activity: Mutex<Activity>,
}

struct Activity {
    last: Instant,
    app_timeout: Option<Duration>,
    vault_timeout: Option<Duration>,
}

impl Default for Activity {
    fn default() -> Self {
        Self {
            last: Instant::now(),
            app_timeout: None,
            vault_timeout: None,
        }
    }
}

impl AppSecurity {
    pub fn is_locked(&self) -> bool {
        self.inner.locked.load(Ordering::SeqCst)
    }

    pub fn revision(&self) -> u64 {
        self.inner.revision.load(Ordering::SeqCst)
    }

    pub async fn transition(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.inner.transition.lock().await
    }

    pub fn require_unlocked(&self) -> AppResult<()> {
        if self.is_locked() {
            Err(AppError::Locked)
        } else {
            Ok(())
        }
    }

    pub async fn activity(&self) -> AppResult<()> {
        let _guard = self.transition().await;
        self.require_unlocked()?;
        self.inner.activity.lock().await.last = Instant::now();
        Ok(())
    }

    pub async fn configure(&self, app: Option<u64>, vault: Option<u64>) -> AppResult<()> {
        if app.is_some_and(|seconds| !(60..=3600).contains(&seconds))
            || vault.is_some_and(|seconds| !(300..=14400).contains(&seconds))
        {
            return Err(AppError::BadRequest("Invalid auto-lock timeout".into()));
        }
        let _guard = self.transition().await;
        self.require_unlocked()?;
        let mut activity = self.inner.activity.lock().await;
        activity.app_timeout = app.map(Duration::from_secs);
        activity.vault_timeout = vault.map(Duration::from_secs);
        Ok(())
    }

    /// Caller holds transition; a successful password check is the only unlock path.
    pub async fn unlock_after_verification(&self) {
        self.inner.activity.lock().await.last = Instant::now();
        self.inner.locked.store(false, Ordering::SeqCst);
        self.inner.revision.fetch_add(1, Ordering::SeqCst);
    }

    /// Caller holds transition. Publish first so terminal input is rejected at once.
    async fn lock(&self, st: &AppState) {
        self.inner.locked.store(true, Ordering::SeqCst);
        self.inner.revision.fetch_add(1, Ordering::SeqCst);
        st.quick_connect_tickets.clear().await;
        vault::lock(&st.vault).await;
    }

    pub async fn lock_now(&self, st: &AppState) -> AppResult<()> {
        let _guard = self.transition().await;
        if !crate::routers::vault::vault_is_initialized(&st.db).await? {
            return Err(AppError::BadRequest(
                "Set a vault master password before locking Netrix".into(),
            ));
        }
        if !self.is_locked() {
            self.lock(st).await;
        }
        Ok(())
    }

    pub async fn check_inactivity(&self, st: &AppState) -> AppResult<()> {
        // A logical restore replaces the password verifier as well as workspace data.
        // Defer automatic locking until that transaction has finished.
        let Ok(_workspace) = st.sessions.workspace_gate().try_read_owned() else {
            return Ok(());
        };
        let _guard = self.transition().await;
        if self.is_locked() {
            return Ok(());
        }
        let (app_due, vault_due) = {
            let activity = self.inner.activity.lock().await;
            let idle = activity.last.elapsed();
            (
                activity.app_timeout.is_some_and(|timeout| idle >= timeout),
                activity
                    .vault_timeout
                    .is_some_and(|timeout| idle >= timeout),
            )
        };
        if app_due {
            if crate::routers::vault::vault_is_initialized(&st.db).await? {
                self.lock(st).await;
                return Ok(());
            }
            // There is no password to authenticate against yet. Never invent one.
            self.inner.activity.lock().await.last = Instant::now();
        }
        if vault_due && vault::is_unlocked(&st.vault).await {
            vault::lock(&st.vault).await;
        }
        Ok(())
    }
}

pub fn start_monitor(st: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            if let Err(error) = st.security.check_inactivity(&st).await {
                tracing::error!("Could not apply inactivity lock: {error}");
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn state(initialized: bool) -> AppState {
        let db = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::query("CREATE TABLE vault_items (id INTEGER)")
            .execute(&db)
            .await
            .unwrap();
        if initialized {
            sqlx::query("INSERT INTO vault_items VALUES (1)")
                .execute(&db)
                .await
                .unwrap();
        }
        AppState {
            database_encryption: None,
            security: AppSecurity::default(),
            db,
            vault: vault::new_vault(),
            api_token: "test".into(),
            sessions: crate::ssh::SessionManager::new(),
            sftp: crate::ssh::SftpManager::new(),
            quick_connect_tickets: crate::auth::QuickConnectTicketStore::new(),
            vault_unlock_limiter: crate::auth::VaultUnlockLimiter::new(),
        }
    }

    #[tokio::test]
    async fn activity_from_any_window_resets_one_clock_but_never_unlocks() {
        let st = state(true).await;
        st.security.configure(Some(60), Some(300)).await.unwrap();
        st.security.inner.activity.lock().await.last = Instant::now() - Duration::from_secs(61);
        let another_window = st.security.clone();
        another_window.activity().await.unwrap();
        st.security.check_inactivity(&st).await.unwrap();
        assert!(!st.security.is_locked());
        st.security.inner.activity.lock().await.last = Instant::now() - Duration::from_secs(61);
        st.security.check_inactivity(&st).await.unwrap();
        assert!(another_window.is_locked());
        assert!(another_window.activity().await.is_err());
        assert!(another_window.configure(None, None).await.is_err());
        assert!(st.security.is_locked());
    }

    #[tokio::test]
    async fn fresh_install_cannot_be_locked_without_a_password_verifier() {
        let st = state(false).await;
        st.security.configure(Some(60), None).await.unwrap();
        st.security.inner.activity.lock().await.last = Instant::now() - Duration::from_secs(61);
        st.security.check_inactivity(&st).await.unwrap();
        assert!(!st.security.is_locked());
        assert!(st.security.lock_now(&st).await.is_err());
    }
}
