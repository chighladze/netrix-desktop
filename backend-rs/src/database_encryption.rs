//! SQLCipher storage and restart-safe conversion of the entire SQLite database.
//! Passwords wrap a random database key; that key never goes to the renderer.
use crate::{
    atomic_file::{native_path, replace},
    db::Db,
    vault,
};
use anyhow::{bail, Context};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs2::FileExt;
use futures::TryStreamExt;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Column, ConnectOptions, Connection, Row, SqliteConnection, TypeInfo, ValueRef,
};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub const KEY_FILE: &str = ".database-key";
pub const MAX_MASTER_PASSWORD_BYTES: usize = 1024;
const KEY_CONTEXT: &[u8] = b"Netrix SQLCipher wrapping key v1";
const KEY_CHECK: &[u8] = b"netrix-database-key-v1\0";
// The previous sidecar can spend up to 14 seconds shutting down after it
// loses its parent pipe. The shell's readiness budget also covers inspection.
const WORKSPACE_LOCK_WAIT: Duration = Duration::from_secs(15);
const WORKSPACE_LOCK_RETRY: Duration = Duration::from_millis(100);

#[derive(Debug, thiserror::Error)]
#[error("This workspace is already open in another Netrix process")]
pub struct WorkspaceBusy(#[source] std::io::Error);

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct WrappedKey {
    salt: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Envelope {
    version: u32,
    // Only the very first creation may resume with no database file.
    creating: bool,
    wraps: Vec<WrappedKey>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StartupMode {
    Setup,
    Upgrade,
    Encrypted,
}
impl StartupMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Setup => "setup",
            Self::Upgrade => "upgrade",
            Self::Encrypted => "encrypted",
        }
    }
}

/// Held for the backend's whole lifetime, including before password entry.
pub struct Storage {
    directory: PathBuf,
    _process_lock: File,
    pub mode: StartupMode,
    #[cfg(test)]
    failpoint: std::sync::atomic::AtomicU8,
}

/// Present only for an encrypted on-disk workspace, absent in in-memory tests.
pub struct DatabaseEncryption {
    directory: PathBuf,
    key: Zeroizing<[u8; 32]>,
}

fn options(path: &Path) -> anyhow::Result<SqliteConnectOptions> {
    let options = SqliteConnectOptions::new().filename(native_path(path)?);
    // The regular Windows VFS still limits paths even when Rust file operations
    // accept them. This built-in VFS preserves win32 locking and WAL semantics.
    #[cfg(windows)]
    let options = options.vfs("win32-longpath");
    Ok(options
        .busy_timeout(std::time::Duration::from_secs(5))
        .pragma("temp_store", "MEMORY")
        .pragma("secure_delete", "ON")
        .disable_statement_logging())
}

fn keyed_options(path: &Path, key: &[u8; 32]) -> anyhow::Result<SqliteConnectOptions> {
    // SQLx orders `key` before every other pragma. Only internally generated
    // hex bytes enter this pragma; paths and user values always use SQL binds.
    Ok(options(path)?
        .pragma("key", format!("\"x'{}'\"", hex::encode(key)))
        .pragma("cipher_compatibility", "4")
        .pragma("cipher_memory_security", "ON"))
}

pub async fn open_encrypted(path: &Path, key: &[u8; 32], create: bool) -> anyhow::Result<Db> {
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            keyed_options(path, key)?
                .create_if_missing(create)
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(SqliteSynchronous::Full),
        )
        .await?;
    let result = async {
        require_cipher(&pool).await?;
        sqlx::query("SELECT count(*) FROM sqlite_master")
            .fetch_one(&pool)
            .await?;
        anyhow::Ok(())
    }
    .await;
    if let Err(error) = result {
        pool.close().await;
        return Err(error);
    }
    Ok(pool)
}

async fn require_cipher(pool: &Db) -> anyhow::Result<()> {
    let version: Option<(String,)> = sqlx::query_as("PRAGMA cipher_version")
        .fetch_optional(pool)
        .await?;
    if !version.is_some_and(|row| row.0.starts_with("4.20.0")) {
        bail!("Required SQLCipher 4.20.0 encryption support is unavailable");
    }
    Ok(())
}

fn is_plain(path: &Path) -> anyhow::Result<bool> {
    let mut header = [0; 16];
    let mut file = File::open(path)?;
    if file.metadata()?.len() < 16 {
        return Ok(false);
    }
    file.read_exact(&mut header)?;
    Ok(&header == b"SQLite format 3\0")
}

fn read_envelope(directory: &Path) -> anyhow::Result<Option<Envelope>> {
    let path = directory.join(KEY_FILE);
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > 4096 {
        bail!("Invalid database key file; restore its original backup");
    }
    let envelope: Envelope = serde_json::from_reader(file)
        .context("Invalid database key file; restore its original backup")?;
    if envelope.version != 1 || !(1..=2).contains(&envelope.wraps.len()) {
        bail!("Unsupported database key format");
    }
    for wrap in &envelope.wraps {
        if STANDARD.decode(&wrap.salt)?.len() != 32
            || STANDARD.decode(&wrap.ciphertext)?.len() != KEY_CHECK.len() + 32 + 28
        {
            bail!("Invalid database key file; restore its original backup");
        }
    }
    Ok(Some(envelope))
}

async fn wrapping_key(password: &str, salt: Vec<u8>) -> anyhow::Result<Zeroizing<[u8; 32]>> {
    let derived = vault::portable_key(password.to_owned(), salt).await?;
    let mut key = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(None, derived.as_ref())
        .expand(KEY_CONTEXT, key.as_mut())
        .map_err(|_| anyhow::anyhow!("Database key derivation failed"))?;
    Ok(key)
}

async fn wrap_key(password: &str, key: &[u8; 32]) -> anyhow::Result<WrappedKey> {
    let salt = rand::random::<[u8; 32]>();
    let wrapping = wrapping_key(password, salt.to_vec()).await?;
    let mut plain = Zeroizing::new(KEY_CHECK.to_vec());
    plain.extend_from_slice(key);
    Ok(WrappedKey {
        salt: STANDARD.encode(salt),
        ciphertext: STANDARD.encode(vault::encrypt(&plain, &wrapping)?),
    })
}

async fn unwrap_key(
    password: &str,
    envelope: &Envelope,
) -> anyhow::Result<(Zeroizing<[u8; 32]>, WrappedKey)> {
    for wrap in &envelope.wraps {
        let wrapping = wrapping_key(password, STANDARD.decode(&wrap.salt)?).await?;
        if let Ok(plain) = vault::decrypt(&STANDARD.decode(&wrap.ciphertext)?, &wrapping) {
            let plain = Zeroizing::new(plain);
            if plain.len() == KEY_CHECK.len() + 32 && plain.starts_with(KEY_CHECK) {
                let mut key = Zeroizing::new([0; 32]);
                key.copy_from_slice(&plain[KEY_CHECK.len()..]);
                return Ok((key, wrap.clone()));
            }
        }
    }
    Err(vault::VaultError::InvalidPassword.into())
}

fn sync_parent(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn sync_file(path: &Path) -> std::io::Result<()> {
    // FlushFileBuffers requires a write-capable handle on Windows.
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

fn write_envelope(directory: &Path, envelope: &Envelope) -> anyhow::Result<()> {
    let pending = directory.join(format!(".database-key.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&pending)?;
        serde_json::to_writer(&mut file, envelope)?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        replace(&pending, &directory.join(KEY_FILE))?;
        sync_parent(directory)?;
        anyhow::Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(pending);
    }
    result
}

fn open_workspace_lock(directory: &Path) -> std::io::Result<File> {
    fs::create_dir_all(directory)?;
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join(".database-lock"))
}

fn try_workspace_lock(lock: &File) -> anyhow::Result<()> {
    lock.try_lock_exclusive().map_err(|error| {
        if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
            WorkspaceBusy(error).into()
        } else {
            error.into()
        }
    })
}

async fn wait_for_workspace_lock(lock: &File) -> anyhow::Result<()> {
    let busy = match try_workspace_lock(lock) {
        Err(error) if error.is::<WorkspaceBusy>() => error,
        result => return result,
    };
    tracing::info!("Waiting for the workspace lock to be released");
    let retry = async {
        loop {
            tokio::time::sleep(WORKSPACE_LOCK_RETRY).await;
            match try_workspace_lock(lock) {
                Err(error) if error.is::<WorkspaceBusy>() => continue,
                result => return result,
            }
        }
    };
    tokio::time::timeout(WORKSPACE_LOCK_WAIT, retry)
        .await
        .unwrap_or(Err(busy))
}

impl Storage {
    pub async fn inspect(directory: PathBuf) -> anyhow::Result<Arc<Self>> {
        let process_lock = open_workspace_lock(&directory)?;
        try_workspace_lock(&process_lock)?;
        Self::inspect_locked(directory, process_lock).await
    }

    pub async fn inspect_on_startup(
        directory: PathBuf,
        stop: &CancellationToken,
    ) -> anyhow::Result<Option<Arc<Self>>> {
        if stop.is_cancelled() {
            return Ok(None);
        }
        let process_lock = open_workspace_lock(&directory)?;
        tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(None),
            result = wait_for_workspace_lock(&process_lock) => result?,
        }
        if stop.is_cancelled() {
            return Ok(None);
        }
        Self::inspect_locked(directory, process_lock)
            .await
            .map(Some)
    }

    async fn inspect_locked(directory: PathBuf, process_lock: File) -> anyhow::Result<Arc<Self>> {
        let path = directory.join("database.db");
        let envelope = read_envelope(&directory)?;
        let mode = if !path.exists() || fs::metadata(&path)?.len() == 0 {
            if envelope.as_ref().is_some_and(|value| !value.creating) {
                bail!("The encrypted database is missing; restore the matching workspace backup");
            }
            if envelope.is_some() {
                StartupMode::Encrypted
            } else {
                StartupMode::Setup
            }
        } else if is_plain(&path)? {
            let mut source =
                SqliteConnection::connect_with(&options(&path)?.read_only(true)).await?;
            let initialized = vault::has_password_verifier(&mut source).await?;
            source.close().await?;
            if initialized || envelope.is_some() {
                StartupMode::Upgrade
            } else {
                StartupMode::Setup
            }
        } else {
            if envelope.is_none() {
                bail!("The database key file is missing; restore .database-key from the matching backup");
            }
            StartupMode::Encrypted
        };
        Ok(Arc::new(Self {
            directory,
            _process_lock: process_lock,
            mode,
            #[cfg(test)]
            failpoint: std::sync::atomic::AtomicU8::new(0),
        }))
    }

    /// Runs behind the startup mutex, before any application router is published.
    pub async fn unlock(
        &self,
        password: &str,
    ) -> anyhow::Result<(Db, Arc<DatabaseEncryption>, vault::SharedVault)> {
        if password.is_empty() || password.len() > MAX_MASTER_PASSWORD_BYTES {
            bail!("Enter a master password of at most 1024 bytes");
        }
        let path = self.directory.join("database.db");
        let plain = path.exists() && is_plain(&path)?;
        // Validate the old vault without changing a single source row.
        if plain {
            let mut source =
                SqliteConnection::connect_with(&options(&path)?.read_only(true)).await?;
            let initialized = vault::has_password_verifier(&mut source).await?;
            if initialized {
                vault::verify_password_read_only(&mut source, password).await?;
            } else if password.chars().count() < 10 {
                bail!("Master password must be at least 10 characters");
            }
            source.close().await?;
        }
        let mut envelope = read_envelope(&self.directory)?;
        let (key, selected_wrap) = match &envelope {
            Some(envelope) => unwrap_key(password, envelope).await?,
            None => {
                if password.chars().count() < 10 && !plain {
                    bail!("Master password must be at least 10 characters");
                }
                let key = Zeroizing::new(rand::random::<[u8; 32]>());
                let wrapped = wrap_key(password, &key).await?;
                let created = Envelope {
                    version: 1,
                    creating: !plain,
                    wraps: vec![wrapped.clone()],
                };
                write_envelope(&self.directory, &created)?;
                envelope = Some(created);
                (key, wrapped)
            }
        };
        if plain {
            self.convert_plaintext(&key).await?;
        }
        let create = envelope.as_ref().is_some_and(|value| value.creating);
        let pool = open_encrypted(&path, &key, create).await?;
        let vault = vault::new_vault();
        let result = async {
            // Recover interrupted password rotation only after the vault confirms
            // which password actually committed. A stale wrap never opens the UI.
            if !create {
                let mut connection = pool.acquire().await?;
                if vault::has_password_verifier(&mut connection).await? {
                    vault::verify_password_read_only(&mut connection, password).await?;
                }
            }
            crate::db::run_migrations(&pool).await?;
            vault::unlock(&vault, &pool, password).await?;
            write_envelope(
                &self.directory,
                &Envelope {
                    version: 1,
                    creating: false,
                    wraps: vec![selected_wrap],
                },
            )?;
            anyhow::Ok(())
        }
        .await;
        if let Err(error) = result {
            pool.close().await;
            return Err(error);
        }
        Ok((
            pool,
            Arc::new(DatabaseEncryption {
                directory: self.directory.clone(),
                key,
            }),
            vault,
        ))
    }

    async fn convert_plaintext(&self, key: &[u8; 32]) -> anyhow::Result<()> {
        let source_path = self.directory.join("database.db");
        let pending = self
            .directory
            .join(format!(".database-encryption-{}.tmp", uuid::Uuid::new_v4()));
        let mut source = SqliteConnection::connect_with(
            &options(&source_path)?
                .pragma("locking_mode", "EXCLUSIVE")
                .journal_mode(SqliteJournalMode::Delete)
                .synchronous(SqliteSynchronous::Full),
        )
        .await
        .context("Close other Netrix instances before encrypting this workspace")?;
        // DELETE mode checkpoints any legacy WAL. EXCLUSIVE keeps writers out
        // throughout export and verification, not merely during the SELECT.
        sqlx::query("BEGIN EXCLUSIVE").execute(&mut source).await?;
        let result = async {
            check_integrity(&mut source, false).await?;
            let before = fingerprint(&mut source).await?;
            let version: (i64,) = sqlx::query_as("PRAGMA user_version")
                .fetch_one(&mut source)
                .await?;
            let application: (i64,) = sqlx::query_as("PRAGMA application_id")
                .fetch_one(&mut source)
                .await?;
            // The source deliberately lacks SQLITE_OPEN_CREATE. ATTACH inherits
            // that flag, so reserve the new destination explicitly first.
            File::create_new(&pending)?.sync_all()?;
            sqlx::query("ATTACH DATABASE ? AS encrypted KEY ?")
                .bind(
                    native_path(&pending)?
                        .to_str()
                        .context("Database path must be valid UTF-8")?,
                )
                .bind(format!("x'{}'", hex::encode(key)))
                .persistent(false)
                .execute(&mut source)
                .await?;
            sqlx::query("SELECT sqlcipher_export('encrypted')")
                .execute(&mut source)
                .await?;
            // These values are integers read from SQLite, not interpolated input.
            sqlx::query(&format!("PRAGMA encrypted.user_version = {}", version.0))
                .execute(&mut source)
                .await?;
            sqlx::query(&format!(
                "PRAGMA encrypted.application_id = {}",
                application.0
            ))
            .execute(&mut source)
            .await?;
            sqlx::query("COMMIT").execute(&mut source).await?;
            sqlx::query("DETACH DATABASE encrypted")
                .execute(&mut source)
                .await?;
            let mut encrypted =
                SqliteConnection::connect_with(&keyed_options(&pending, key)?).await?;
            check_integrity(&mut encrypted, true).await?;
            if before != fingerprint(&mut encrypted).await? {
                bail!("Database verification failed; the original database was preserved");
            }
            encrypted.close().await?;
            sync_file(&pending)?;
            // Keep a complete, independently reopenable encrypted recovery set.
            let backup = self
                .directory
                .join(format!("encryption-backup-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&backup)?;
            for (from, to) in [
                (&pending, backup.join("database.db")),
                (&self.directory.join(KEY_FILE), backup.join(KEY_FILE)),
                (
                    &self.directory.join(".vault_salt"),
                    backup.join(".vault_salt"),
                ),
            ] {
                fs::copy(from, &to)?;
                sync_file(&to)?;
            }
            sync_parent(&backup)?;
            let mut recovery = SqliteConnection::connect_with(
                &keyed_options(&backup.join("database.db"), key)?.read_only(true),
            )
            .await?;
            check_integrity(&mut recovery, true).await?;
            if before != fingerprint(&mut recovery).await? {
                bail!("Recovery copy verification failed; the original database was preserved");
            }
            recovery.close().await?;
            tracing::info!(
                "Encrypted database verified; recovery copy: {}",
                backup.display()
            );
            anyhow::Ok(())
        }
        .await;
        // Closing SQLite also removes its checkpointed WAL/journal sidecars.
        source.close().await?;
        if let Err(error) = result {
            return Err(error.context("Encryption did not replace the original database"));
        }
        #[cfg(test)]
        if self.failpoint.load(std::sync::atomic::Ordering::SeqCst) == 1 {
            bail!("Simulated interruption before publication");
        }
        // Exclusive DELETE mode can leave an invalidated journal on Windows.
        // Only remove proven inactive sidecars after the encrypted backup exists.
        // A nonempty WAL or a journal with a live header always stops replacement.
        for suffix in ["-wal", "-journal", "-shm"] {
            let sidecar = self.directory.join(format!("database.db{suffix}"));
            if !sidecar.exists() {
                continue;
            }
            let mut file = File::open(&sidecar)?;
            let length = file.metadata()?.len();
            let inactive = match suffix {
                "-wal" => length == 0,
                "-journal" => {
                    let mut header = [0; 8];
                    let read = file.read(&mut header)?;
                    length == 0 || (read == 8 && header == [0; 8])
                }
                _ => !self.directory.join("database.db-wal").exists(),
            };
            drop(file);
            if !inactive {
                bail!("Active SQLite {suffix} remains; the original database was preserved. Close other instances and retry");
            }
            fs::remove_file(sidecar)?;
        }
        replace(&pending, &source_path).context(
            "Cannot replace the database; original data and encrypted recovery copy are preserved",
        )?;
        sync_parent(&self.directory)?;
        #[cfg(test)]
        if self.failpoint.load(std::sync::atomic::Ordering::SeqCst) == 2 {
            bail!("Simulated interruption after publication");
        }
        Ok(())
    }
}

impl DatabaseEncryption {
    /// Durable two-phase wrapping prevents either password rotation crash window
    /// from losing the database key. Startup validates against the vault before
    /// pruning the pending wrap. Backups keep their historical passwords.
    pub async fn prepare_password_change(&self, current: &str, next: &str) -> anyhow::Result<()> {
        let envelope = read_envelope(&self.directory)?.context("Database key file is missing")?;
        let (key, current_wrap) = unwrap_key(current, &envelope).await?;
        if key.as_ref() != self.key.as_ref() {
            bail!("Database key does not match this workspace");
        }
        let next_wrap = wrap_key(next, &self.key).await?;
        write_envelope(
            &self.directory,
            &Envelope {
                version: 1,
                creating: false,
                wraps: vec![current_wrap, next_wrap],
            },
        )
    }

    pub async fn finish_password_change(&self, password: &str) -> anyhow::Result<()> {
        let envelope = read_envelope(&self.directory)?.context("Database key file is missing")?;
        let (_, selected) = unwrap_key(password, &envelope).await?;
        write_envelope(
            &self.directory,
            &Envelope {
                version: 1,
                creating: false,
                wraps: vec![selected],
            },
        )
    }
}

async fn check_integrity(connection: &mut SqliteConnection, encrypted: bool) -> anyhow::Result<()> {
    let rows: Vec<(String,)> = sqlx::query_as("PRAGMA integrity_check")
        .fetch_all(&mut *connection)
        .await?;
    if rows != vec![("ok".into(),)] {
        bail!("SQLite integrity check failed; original data was preserved");
    }
    if !sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(&mut *connection)
        .await?
        .is_empty()
    {
        bail!("Database contains broken references; original data was preserved");
    }
    if encrypted
        && !sqlx::query("PRAGMA cipher_integrity_check")
            .fetch_all(connection)
            .await?
            .is_empty()
    {
        bail!("Encrypted database authentication failed");
    }
    Ok(())
}

/// Compare every schema object and every typed row, including duplicate rows,
/// triggers, sequence counters, internal tables and migrations. Order-independent.
async fn fingerprint(connection: &mut SqliteConnection) -> anyhow::Result<Vec<u8>> {
    let schema: Vec<(String, String, String, Option<String>)> =
        sqlx::query_as("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
            .fetch_all(&mut *connection)
            .await?;
    let mut database = Sha256::new();
    database.update(serde_json::to_vec(&schema)?);
    for (_, table, _, _) in schema.iter().filter(|row| row.0 == "table") {
        let escaped = table.replace('"', "\"\"");
        let query = format!("SELECT * FROM \"{escaped}\"");
        let mut rows = sqlx::query(&query).fetch(&mut *connection);
        let mut hashes = Vec::new();
        while let Some(row) = rows.try_next().await? {
            let mut hash = Sha256::new();
            for (index, column) in row.columns().iter().enumerate() {
                hash.update(column.name().as_bytes());
                let value = row.try_get_raw(index)?;
                if value.is_null() {
                    hash.update([0]);
                    continue;
                }
                let bytes = Zeroizing::new(match value.type_info().name() {
                    "INTEGER" => {
                        hash.update([1]);
                        row.try_get::<i64, _>(index)?.to_le_bytes().to_vec()
                    }
                    "REAL" => {
                        hash.update([2]);
                        row.try_get::<f64, _>(index)?
                            .to_bits()
                            .to_le_bytes()
                            .to_vec()
                    }
                    "TEXT" => {
                        hash.update([3]);
                        row.try_get::<String, _>(index)?.into_bytes()
                    }
                    "BLOB" => {
                        hash.update([4]);
                        row.try_get::<Vec<u8>, _>(index)?
                    }
                    _ => bail!("Unsupported SQLite value during migration verification"),
                });
                hash.update((bytes.len() as u64).to_le_bytes());
                hash.update(&bytes);
            }
            hashes.push(<[u8; 32]>::from(hash.finalize()));
        }
        hashes.sort_unstable();
        database.update(table.as_bytes());
        database.update((hashes.len() as u64).to_le_bytes());
        for hash in hashes {
            database.update(hash);
        }
    }
    Ok(database.finalize().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PASSWORD: &str = "test-workspace-password-123";
    struct Fixture(PathBuf, PathBuf);
    impl Fixture {
        fn new() -> Self {
            Self::with_profile(None)
        }
        fn with_profile(profile: Option<&str>) -> Self {
            let root =
                std::env::temp_dir().join(format!("netrix-cipher-test-{}", uuid::Uuid::new_v4()));
            let dir = profile.map_or_else(|| root.clone(), |name| root.join(name));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join(".vault_salt"),
                hex::encode(&crate::config::SETTINGS.vault_salt),
            )
            .unwrap();
            Self(dir, root)
        }
        async fn legacy(&self) -> Db {
            let pool = SqlitePoolOptions::new()
                .max_connections(1)
                .connect_with(
                    options(&self.0.join("database.db"))
                        .unwrap()
                        .create_if_missing(true)
                        .journal_mode(SqliteJournalMode::Wal),
                )
                .await
                .unwrap();
            crate::db::run_migrations(&pool).await.unwrap();
            vault::unlock(&vault::new_vault(), &pool, PASSWORD)
                .await
                .unwrap();
            sqlx::raw_sql("INSERT INTO hosts(id,name,hostname) VALUES(41,'cipher-host-marker','203.0.113.42');
                INSERT INTO snippets(title,template,host_id) VALUES('cipher-snippet-marker','echo сохраняем данные',41);
                INSERT INTO network_maps(id,name) VALUES('map','cipher-map-marker');
                INSERT INTO map_nodes(id,map_id,host_id,label,x) VALUES('a','map',41,'node-a',17),('b','map',NULL,'node-b',99);
                INSERT INTO map_edges(id,map_id,source_node_id,target_node_id,label) VALUES('edge','map','a','b','fibre');
                INSERT INTO quick_actions(id,label,command) VALUES('q','Quick','echo 123');
                PRAGMA user_version=71; PRAGMA application_id=123;")
                .execute(&pool).await.unwrap();
            pool
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert_eq!(self.1.parent(), Some(std::env::temp_dir().as_path()));
            let _ = fs::remove_dir_all(&self.1);
        }
    }

    #[tokio::test]
    async fn entire_legacy_database_roundtrips_with_encrypted_backup_and_restart() {
        let fixture = Fixture::new();
        let old = fixture.legacy().await;
        let before = fingerprint(&mut old.acquire().await.unwrap())
            .await
            .unwrap();
        old.close().await;
        let storage = Storage::inspect(fixture.0.clone()).await.unwrap();
        assert!(storage.mode == StartupMode::Upgrade);
        let (pool, encryption, _) = storage.unlock(PASSWORD).await.unwrap();
        let after = fingerprint(&mut pool.acquire().await.unwrap())
            .await
            .unwrap();
        assert_eq!(
            before, after,
            "all tables, revisions, triggers, IDs and relationships survive"
        );
        let version: (i64,) = sqlx::query_as("PRAGMA user_version")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(version.0, 71);
        assert!(!is_plain(&fixture.0.join("database.db")).unwrap());
        for name in ["database.db", "database.db-wal"] {
            let bytes = fs::read(fixture.0.join(name)).unwrap();
            for marker in [
                "cipher-host-marker",
                "cipher-snippet-marker",
                "cipher-map-marker",
                "сохраняем данные",
            ] {
                assert!(
                    !bytes
                        .windows(marker.len())
                        .any(|part| part == marker.as_bytes()),
                    "plaintext in {name}"
                );
            }
        }
        let wrong = [9; 32];
        assert!(
            open_encrypted(&fixture.0.join("database.db"), &wrong, false)
                .await
                .is_err()
        );
        if let Ok(mut unkeyed) =
            SqliteConnection::connect_with(&options(&fixture.0.join("database.db")).unwrap()).await
        {
            assert!(sqlx::query("SELECT * FROM hosts")
                .fetch_all(&mut unkeyed)
                .await
                .is_err());
            unkeyed.close().await.unwrap();
        }
        let backup = fs::read_dir(&fixture.0)
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("encryption-backup-")
            })
            .unwrap()
            .path();
        let recovery = Storage::inspect(backup).await.unwrap();
        let (restored, _, _) = recovery.unlock(PASSWORD).await.unwrap();
        assert_eq!(
            before,
            fingerprint(&mut restored.acquire().await.unwrap())
                .await
                .unwrap()
        );
        restored.close().await;
        pool.close().await;
        drop(encryption);
        drop(storage);
        let restarted = Storage::inspect(fixture.0.clone()).await.unwrap();
        assert!(restarted.mode == StartupMode::Encrypted);
        assert!(restarted.unlock("wrong-password").await.is_err());
        let (pool, _, _) = restarted.unlock(PASSWORD).await.unwrap();
        assert_eq!(
            before,
            fingerprint(&mut pool.acquire().await.unwrap())
                .await
                .unwrap()
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn wrong_password_and_broken_references_never_replace_plaintext() {
        let fixture = Fixture::new();
        let old = fixture.legacy().await;
        old.close().await;
        let original = fs::read(fixture.0.join("database.db")).unwrap();
        let storage = Storage::inspect(fixture.0.clone()).await.unwrap();
        assert!(storage.unlock("incorrect").await.is_err());
        assert_eq!(original, fs::read(fixture.0.join("database.db")).unwrap());
        assert!(!fixture.0.join(KEY_FILE).exists());
        let mut corrupt = SqliteConnection::connect_with(
            &options(&fixture.0.join("database.db"))
                .unwrap()
                .foreign_keys(false),
        )
        .await
        .unwrap();
        sqlx::query("UPDATE snippets SET host_id=999")
            .execute(&mut corrupt)
            .await
            .unwrap();
        corrupt.close().await.unwrap();
        assert!(storage.unlock(PASSWORD).await.is_err());
        assert!(is_plain(&fixture.0.join("database.db")).unwrap());
        let mut retained =
            SqliteConnection::connect_with(&options(&fixture.0.join("database.db")).unwrap())
                .await
                .unwrap();
        let count: (i64,) = sqlx::query_as("SELECT count(*) FROM hosts")
            .fetch_one(&mut retained)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
        retained.close().await.unwrap();
    }

    #[tokio::test]
    async fn pending_key_and_partial_copy_resume_without_using_partial_data() {
        let fixture = Fixture::new();
        let old = fixture.legacy().await;
        old.close().await;
        let key = [13; 32];
        write_envelope(
            &fixture.0,
            &Envelope {
                version: 1,
                creating: false,
                wraps: vec![wrap_key(PASSWORD, &key).await.unwrap()],
            },
        )
        .unwrap();
        fs::write(
            fixture.0.join(".database-encryption-interrupted.tmp"),
            b"unfinished encrypted output",
        )
        .unwrap();
        let storage = Storage::inspect(fixture.0.clone()).await.unwrap();
        let (pool, _, _) = storage.unlock(PASSWORD).await.unwrap();
        let count: (i64,) = sqlx::query_as("SELECT count(*) FROM hosts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 1);
        pool.close().await;
    }

    #[tokio::test]
    async fn missing_or_corrupt_key_never_creates_an_empty_replacement() {
        let fixture = Fixture::new();
        let storage = Storage::inspect(fixture.0.clone()).await.unwrap();
        let (pool, _, _) = storage.unlock(PASSWORD).await.unwrap();
        sqlx::query("INSERT INTO hosts(name,hostname) VALUES('retained','example.test')")
            .execute(&pool)
            .await
            .unwrap();
        // Pool::close can drop SQLite workers before their final WAL checkpoint
        // completes. Own every connection, checkpoint, and await each worker's
        // graceful close before taking the byte-for-byte failure snapshot.
        let mut connections = Vec::new();
        for _ in 0..pool.options().get_max_connections() {
            connections.push(pool.acquire().await.unwrap());
        }
        let checkpoint: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_one(&mut *connections[0])
            .await
            .unwrap();
        assert_eq!(checkpoint, (0, 0, 0));
        for connection in connections {
            connection.close().await.unwrap();
        }
        pool.close().await;
        drop(storage);
        let original = fs::read(fixture.0.join("database.db")).unwrap();
        let original_wal = fs::read(fixture.0.join("database.db-wal")).ok();
        let envelope = fs::read(fixture.0.join(KEY_FILE)).unwrap();
        fs::remove_file(fixture.0.join(KEY_FILE)).unwrap();
        assert!(Storage::inspect(fixture.0.clone()).await.is_err());
        fs::write(fixture.0.join(KEY_FILE), b"damaged").unwrap();
        assert!(Storage::inspect(fixture.0.clone()).await.is_err());
        assert_eq!(original, fs::read(fixture.0.join("database.db")).unwrap());
        assert_eq!(
            original_wal,
            fs::read(fixture.0.join("database.db-wal")).ok()
        );
        fs::write(fixture.0.join(KEY_FILE), envelope).unwrap();
        fs::remove_file(fixture.0.join("database.db")).unwrap();
        assert!(Storage::inspect(fixture.0.clone()).await.is_err());
        assert!(!fixture.0.join("database.db").exists());
    }

    #[tokio::test]
    async fn password_rotation_recovers_both_commit_windows_without_losing_data() {
        for committed in [false, true] {
            let fixture = Fixture::new();
            let storage = Storage::inspect(fixture.0.clone()).await.unwrap();
            let (pool, encryption, active_vault) = storage.unlock(PASSWORD).await.unwrap();
            sqlx::query("INSERT INTO hosts(name,hostname) VALUES('retained','203.0.113.1')")
                .execute(&pool)
                .await
                .unwrap();
            encryption
                .prepare_password_change(PASSWORD, "replacement-password-123")
                .await
                .unwrap();
            if committed {
                vault::change_master_password(
                    &active_vault,
                    &pool,
                    PASSWORD,
                    "replacement-password-123",
                )
                .await
                .unwrap();
            }
            pool.close().await;
            drop(encryption);
            drop(storage);
            let restarted = Storage::inspect(fixture.0.clone()).await.unwrap();
            let (correct, wrong) = if committed {
                ("replacement-password-123", PASSWORD)
            } else {
                (PASSWORD, "replacement-password-123")
            };
            assert!(restarted.unlock(wrong).await.is_err());
            let (pool, _, _) = restarted.unlock(correct).await.unwrap();
            let count: (i64,) = sqlx::query_as("SELECT count(*) FROM hosts")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count.0, 1);
            assert_eq!(read_envelope(&fixture.0).unwrap().unwrap().wraps.len(), 1);
            pool.close().await;
        }
    }

    #[tokio::test]
    async fn second_process_is_rejected_and_ciphertext_tampering_is_detected() {
        let fixture = Fixture::new();
        let storage = Storage::inspect(fixture.0.clone()).await.unwrap();
        assert!(Storage::inspect(fixture.0.clone()).await.is_err());
        let (pool, encryption, _) = storage.unlock(PASSWORD).await.unwrap();
        sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
            .fetch_all(&pool)
            .await
            .unwrap();
        pool.close().await;
        let path = fixture.0.join("database.db");
        let mut bytes = fs::read(&path).unwrap();
        bytes[1024] ^= 1;
        fs::write(&path, &bytes).unwrap();
        assert!(open_encrypted(&path, &encryption.key, false).await.is_err());
    }

    #[tokio::test]
    async fn committed_legacy_wal_is_included_and_live_legacy_connections_block_conversion() {
        let original = Fixture::new();
        let old = original.legacy().await;
        let snapshot = Fixture::new();
        // Model the file set left by a process exit before its WAL checkpoint.
        for name in ["database.db", "database.db-wal"] {
            fs::copy(original.0.join(name), snapshot.0.join(name)).unwrap();
        }
        let storage = Storage::inspect(original.0.clone()).await.unwrap();
        assert!(
            storage.unlock(PASSWORD).await.is_err(),
            "an old live connection must not be overwritten"
        );
        assert!(is_plain(&original.0.join("database.db")).unwrap());
        old.close().await;
        let storage = Storage::inspect(snapshot.0.clone()).await.unwrap();
        let (pool, _, _) = storage.unlock(PASSWORD).await.unwrap();
        let row: (String, String) = sqlx::query_as(
            "SELECT h.name,s.template FROM hosts h JOIN snippets s ON s.host_id=h.id",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            row,
            ("cipher-host-marker".into(), "echo сохраняем данные".into())
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn interruption_at_either_side_of_atomic_replacement_is_recoverable() {
        for stage in [1, 2] {
            recover_interrupted_replacement(Fixture::new(), stage).await;
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_long_path_recovers_at_both_sides_of_atomic_replacement() {
        use std::os::windows::ffi::OsStrExt;
        for stage in [1, 2] {
            let fixture = Fixture::with_profile(Some(&format!("{}ქართული", "profile-".repeat(24))));
            assert!(fixture.0.as_os_str().encode_wide().count() > 260);
            recover_interrupted_replacement(fixture, stage).await;
        }
    }

    async fn recover_interrupted_replacement(fixture: Fixture, stage: u8) {
        let old = fixture.legacy().await;
        let before = fingerprint(&mut old.acquire().await.unwrap())
            .await
            .unwrap();
        old.close().await;
        let storage = Storage::inspect(fixture.0.clone()).await.unwrap();
        storage
            .failpoint
            .store(stage, std::sync::atomic::Ordering::SeqCst);
        let error = storage.unlock(PASSWORD).await.err().unwrap();
        assert_eq!(
            error.to_string(),
            if stage == 1 {
                "Simulated interruption before publication"
            } else {
                "Simulated interruption after publication"
            }
        );
        assert_eq!(
            is_plain(&fixture.0.join("database.db")).unwrap(),
            stage == 1
        );
        drop(storage);
        let restarted = Storage::inspect(fixture.0.clone()).await.unwrap();
        let (pool, _, _) = restarted.unlock(PASSWORD).await.unwrap();
        assert_eq!(
            before,
            fingerprint(&mut pool.acquire().await.unwrap())
                .await
                .unwrap()
        );
        pool.close().await;
    }
}
