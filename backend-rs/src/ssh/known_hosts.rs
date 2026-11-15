//! Trust-On-First-Use (TOFU) SSH host-key persistence.

use std::collections::HashMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine;
use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::{atomic_file::replace as replace_file, config::SETTINGS};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyResult {
    TrustedNew,
    TrustedKnown,
    Mismatch {
        expected: String,
        got: String,
    },
    /// Reject trust when loading fails or a new key cannot be persisted durably.
    StorageError {
        message: String,
    },
}

#[derive(Clone)]
pub struct KnownHostsStore {
    inner: Arc<RwLock<HashMap<String, String>>>,
    path: PathBuf,
    load_error: Option<String>,
}

impl KnownHostsStore {
    pub fn new() -> Self {
        Self::from_path(SETTINGS.app_data_dir.join("known_hosts"))
    }

    /// Explicit storage path for isolated workspaces and protocol test fixtures.
    pub fn from_path(path: PathBuf) -> Self {
        // Only a missing file is a new trust store. Never turn unreadable or
        // partially parsed trust into TOFU, which would overwrite prior keys.
        let (entries, load_error) = match load_entries(&path) {
            Ok(entries) => (entries, None),
            Err(error) => {
                warn!("[KnownHosts] Cannot load trust store: {error}");
                (HashMap::new(), Some(format!(
                    "SSH trust store could not be loaded: {error}. Restore known_hosts and restart Netrix."
                )))
            }
        };

        if !entries.is_empty() {
            info!(
                "[KnownHosts] Loaded {} entries from {}",
                entries.len(),
                path.display()
            );
        }
        Self {
            inner: Arc::new(RwLock::new(entries)),
            path,
            load_error,
        }
    }

    pub async fn check(
        &self,
        host: &str,
        port: u16,
        key_type: &str,
        key_bytes: &[u8],
    ) -> HostKeyResult {
        if let Some(message) = &self.load_error {
            return HostKeyResult::StorageError {
                message: message.clone(),
            };
        }
        let host_entry = format!("{host}:{port}");
        let fingerprint = format!(
            "{} {}",
            key_type,
            base64::engine::general_purpose::STANDARD.encode(key_bytes)
        );

        if let Some(stored) = self.inner.read().await.get(&host_entry).cloned() {
            return compare_fingerprint(stored, fingerprint);
        }

        // A second connection can populate this entry while the read lock is
        // released. Re-check under the exclusive lock before applying TOFU.
        let mut entries = self.inner.write().await;
        if let Some(stored) = entries.get(&host_entry).cloned() {
            return compare_fingerprint(stored, fingerprint);
        }

        entries.insert(host_entry.clone(), fingerprint);
        if let Err(error) = self.persist(&entries) {
            entries.remove(&host_entry);
            warn!("[KnownHosts] Failed to persist new key: {error}");
            return HostKeyResult::StorageError {
                message: error.to_string(),
            };
        }

        info!("[KnownHosts] TOFU: accepted new key for {host_entry}");
        HostKeyResult::TrustedNew
    }

    pub async fn list(&self) -> io::Result<Vec<(String, String)>> {
        self.ensure_loaded()?;
        let mut entries: Vec<_> = self
            .inner
            .read()
            .await
            .iter()
            .map(|(host, key)| (host.clone(), key.clone()))
            .collect();
        entries.sort();
        Ok(entries)
    }

    pub async fn forget(&self, host: &str, port: u16, expected: &str) -> io::Result<bool> {
        self.ensure_loaded()?;
        let host_entry = format!("{host}:{port}");
        let mut entries = self.inner.write().await;
        if entries.get(&host_entry).is_some_and(|key| key != expected) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Host key changed; refresh the list before removing it",
            ));
        }
        if let Some(previous) = entries.remove(&host_entry) {
            if let Err(error) = self.persist(&entries) {
                entries.insert(host_entry.clone(), previous);
                return Err(error);
            }
            info!("[KnownHosts] Removed entry for {host_entry}");
            return Ok(true);
        }
        Ok(false)
    }

    fn ensure_loaded(&self) -> io::Result<()> {
        match &self.load_error {
            Some(message) => Err(io::Error::new(io::ErrorKind::InvalidData, message.clone())),
            None => Ok(()),
        }
    }

    fn persist(&self, entries: &HashMap<String, String>) -> io::Result<()> {
        self.ensure_loaded()?;
        let mut content =
            String::from("# Netrix known_hosts - auto-generated, do not edit manually\n");
        let mut sorted: Vec<_> = entries.iter().collect();
        sorted.sort_by_key(|(host, _)| *host);
        for (host, fingerprint) in sorted {
            content.push_str(&format!("{host} {fingerprint}\n"));
        }

        let parent = self.path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "known_hosts path has no parent",
            )
        })?;
        std::fs::create_dir_all(parent)?;
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("known_hosts");
        let temporary_path = parent.join(format!(
            ".{file_name}.{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));

        let result = (|| {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }

            let mut file = options.open(&temporary_path)?;
            file.write_all(content.as_bytes())?;
            file.flush()?;
            file.sync_all()?;
            drop(file);

            replace_file(&temporary_path, &self.path)?;
            sync_parent_directory(parent)
        })();

        if result.is_err() {
            let _ = std::fs::remove_file(&temporary_path);
        }
        result
    }
}

fn load_entries(path: &Path) -> io::Result<HashMap<String, String>> {
    let content = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(HashMap::new()),
        Err(error) => return Err(error),
    };
    let mut entries = HashMap::new();
    for (index, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let invalid = || {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("invalid known_hosts record at line {}", index + 1),
            )
        };
        // Format written by persist: hostname:port <key-type> <key-base64>.
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() != 3 {
            return Err(invalid());
        }
        let valid_address = parts[0].rsplit_once(':').is_some_and(|(host, port)| {
            !host.is_empty() && port.parse::<u16>().is_ok_and(|port| port > 0)
        });
        if !valid_address
            || base64::engine::general_purpose::STANDARD
                .decode(parts[2])
                .map_or(true, |key| key.is_empty())
        {
            return Err(invalid());
        }
        let key = format!("{} {}", parts[1], parts[2]);
        if entries
            .get(parts[0])
            .is_some_and(|previous| previous != &key)
        {
            return Err(invalid());
        }
        entries.insert(parts[0].to_owned(), key);
    }
    Ok(entries)
}

fn compare_fingerprint(stored: String, received: String) -> HostKeyResult {
    if stored == received {
        HostKeyResult::TrustedKnown
    } else {
        HostKeyResult::Mismatch {
            expected: stored,
            got: received,
        }
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

impl Default for KnownHostsStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_short_and_long_paths_persist_trust_and_keep_original_on_replace_failure() {
        use std::os::windows::{ffi::OsStrExt, fs::OpenOptionsExt};
        for long in [false, true] {
            let root =
                std::env::temp_dir().join(format!("netrix-trust-path-{}", uuid::Uuid::new_v4()));
            let directory = if long {
                root.join(format!("{}ქართული", "profile-".repeat(24)))
            } else {
                root.clone()
            };
            std::fs::create_dir_all(&directory).unwrap();
            let path = directory.join("known_hosts");
            if long {
                assert!(path.as_os_str().encode_wide().count() > 260);
            }
            let store = KnownHostsStore::from_path(path.clone());
            assert_eq!(
                store.check("first.test", 22, "ssh-ed25519", b"first").await,
                HostKeyResult::TrustedNew
            );
            assert_eq!(
                store
                    .check("second.test", 22, "ssh-ed25519", b"second")
                    .await,
                HostKeyResult::TrustedNew
            );
            let original = std::fs::read(&path).unwrap();
            // Permit readers but deny replacement while the original is open.
            let locked = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(1)
                .open(&path)
                .unwrap();
            assert!(matches!(
                store.check("third.test", 22, "ssh-ed25519", b"third").await,
                HostKeyResult::StorageError { .. }
            ));
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(
                store.list().await.unwrap().len(),
                2,
                "A failed write must not trust an unpersisted key"
            );
            drop(locked);
            let reloaded = KnownHostsStore::from_path(path.clone());
            assert_eq!(
                reloaded
                    .check("first.test", 22, "ssh-ed25519", b"first")
                    .await,
                HostKeyResult::TrustedKnown
            );
            assert!(matches!(
                reloaded
                    .check("first.test", 22, "ssh-ed25519", b"changed")
                    .await,
                HostKeyResult::Mismatch { .. }
            ));
            let first = reloaded
                .list()
                .await
                .unwrap()
                .into_iter()
                .find(|(host, _)| host == "first.test:22")
                .unwrap();
            assert!(reloaded.forget("first.test", 22, &first.1).await.unwrap());
            assert_eq!(
                KnownHostsStore::from_path(path).list().await.unwrap().len(),
                1
            );
            assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[tokio::test]
    async fn invalid_trust_files_never_reenable_tofu_or_overwrite_existing_bytes() {
        let valid = b"router.test:22 ssh-ed25519 b2xk\nother.test:22 ssh-ed25519 b3RoZXI=\n";
        for suffix in [
            b"# invalid UTF-8: \xff\n".as_slice(),
            b"broken-record\n",
            b"bad.test:22 ssh-ed25519 !!!\n",
            b"bad.test:no-port ssh-ed25519 a2V5\n",
            b"bad.test:22 ssh-ed25519 a2V5 extra\n",
            b"router.test:22 ssh-ed25519 bmV3\n",
        ] {
            let path = temporary_path("corrupt");
            let bytes = [valid.as_slice(), suffix].concat();
            std::fs::write(&path, &bytes).unwrap();
            let store = KnownHostsStore::from_path(path.clone());
            for host in ["router.test", "new.test"] {
                assert!(matches!(
                    store.check(host, 22, "ssh-ed25519", b"new").await,
                    HostKeyResult::StorageError { .. }
                ));
            }
            assert!(store.list().await.is_err());
            assert!(store
                .forget("router.test", 22, "ssh-ed25519 b2xk")
                .await
                .is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            // Reloading must not heal a damaged file by silently dropping keys.
            assert!(KnownHostsStore::from_path(path.clone())
                .list()
                .await
                .is_err());
            std::fs::remove_file(path).unwrap();
        }
    }

    #[tokio::test]
    async fn read_failure_remains_blocked_until_an_explicit_reload() {
        let path = temporary_path("unreadable");
        std::fs::create_dir(&path).unwrap(); // deterministic read error on Windows and Unix
        let store = KnownHostsStore::from_path(path.clone());
        assert!(store.list().await.is_err());
        std::fs::remove_dir(&path).unwrap();
        assert!(matches!(
            store.check("router.test", 22, "ssh-ed25519", b"new").await,
            HostKeyResult::StorageError { .. }
        ));
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn valid_reload_preserves_trust_and_rejects_changed_keys() {
        let path = temporary_path("valid");
        let original = b"# saved keys\n\nrouter.test:22 ssh-ed25519 b2xk\n";
        std::fs::write(&path, original).unwrap();
        let store = KnownHostsStore::from_path(path.clone());
        assert_eq!(
            store.check("router.test", 22, "ssh-ed25519", b"old").await,
            HostKeyResult::TrustedKnown
        );
        assert!(matches!(
            store.check("router.test", 22, "ssh-ed25519", b"new").await,
            HostKeyResult::Mismatch { .. }
        ));
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(path).unwrap();
    }

    #[tokio::test]
    async fn removing_trust_requires_the_current_key_and_is_durable() {
        let path = temporary_path("forget");
        let store = KnownHostsStore::from_path(path.clone());
        assert_eq!(
            store
                .check("example.test", 22, "ssh-ed25519", b"test-key")
                .await,
            HostKeyResult::TrustedNew
        );
        let entries = store.list().await.unwrap();
        assert_eq!(entries.len(), 1);
        assert!(store.forget("example.test", 22, "stale-key").await.is_err());
        assert_eq!(store.list().await.unwrap().len(), 1);
        assert!(store
            .forget("example.test", 22, &entries[0].1)
            .await
            .unwrap());
        assert!(KnownHostsStore::from_path(path.clone())
            .list()
            .await
            .unwrap()
            .is_empty());
        std::fs::remove_file(path).unwrap();
    }

    fn temporary_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "netrix-known-hosts-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[tokio::test]
    async fn concurrent_first_seen_keys_cannot_both_be_trusted() {
        let directory = temporary_path("race");
        let store = KnownHostsStore::from_path(directory.join("known_hosts"));
        let first_store = store.clone();
        let second_store = store.clone();

        let (first, second) = tokio::join!(
            first_store.check("router.example", 22, "ssh-ed25519", b"first"),
            second_store.check("router.example", 22, "ssh-ed25519", b"second"),
        );

        assert!(matches!(
            (&first, &second),
            (HostKeyResult::TrustedNew, HostKeyResult::Mismatch { .. })
                | (HostKeyResult::Mismatch { .. }, HostKeyResult::TrustedNew)
        ));
        let reloaded = KnownHostsStore::from_path(directory.join("known_hosts"));
        let persisted_matches_one = matches!(
            reloaded
                .check("router.example", 22, "ssh-ed25519", b"first")
                .await,
            HostKeyResult::TrustedKnown
        ) || matches!(
            reloaded
                .check("router.example", 22, "ssh-ed25519", b"second")
                .await,
            HostKeyResult::TrustedKnown
        );
        assert!(persisted_matches_one);

        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    async fn persistence_failure_rejects_and_rolls_back_first_seen_key() {
        let directory = temporary_path("failure");
        std::fs::create_dir_all(&directory).unwrap();
        let blocker = directory.join("not-a-directory");
        std::fs::write(&blocker, b"block").unwrap();
        let store = KnownHostsStore::from_path(blocker.join("known_hosts"));

        let result = store
            .check("router.example", 22, "ssh-ed25519", b"key")
            .await;
        assert!(matches!(result, HostKeyResult::StorageError { .. }));
        assert!(store.inner.read().await.is_empty());

        let _ = std::fs::remove_dir_all(directory);
    }
}
