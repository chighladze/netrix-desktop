/// Vault — Encrypted secret storage with Argon2id + AES-256-GCM.
///
/// Provides authenticated encryption, key derivation, and constant-time
/// operations where applicable.
use std::sync::{Arc, LazyLock};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock, Semaphore};
use zeroize::Zeroizing;

use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use sqlx::{SqliteConnection, SqlitePool};
use thiserror::Error;
use tracing::warn;

use crate::config::SETTINGS;

// ─── Errors ─────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("vault is locked")]
    Locked,
    #[error("invalid master password")]
    InvalidPassword,
    #[error("secret not found: {0}")]
    NotFound(i64),
    #[error("crypto error: {0}")]
    Crypto(String),
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

// ─── Cryptographic Primitives ───────────────────────────────────────

/// Derive a 256-bit key from a password using Argon2id.
pub fn derive_key(password: &str) -> Result<[u8; 32], VaultError> {
    let s = &SETTINGS;
    let params = Params::new(
        s.argon2_memory_cost,
        s.argon2_time_cost,
        s.argon2_parallelism,
        Some(32),
    )
    .map_err(|e| VaultError::Crypto(format!("argon2 params: {e}")))?;

    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = [0u8; 32];
    argon2
        .hash_password_into(password.as_bytes(), &s.vault_salt, &mut key)
        .map_err(|e| VaultError::Crypto(format!("argon2 hash: {e}")))?;

    Ok(key)
}

// Bound CPU and memory use without occupying Tokio worker threads.
static KDF_SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));
async fn derive_key_async(password: &str) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let permit = KDF_SLOTS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| VaultError::Crypto("Key derivation is unavailable".into()))?;
    let password = Zeroizing::new(password.to_string());
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        derive_key(&password).map(Zeroizing::new)
    })
    .await
    .map_err(|_| VaultError::Crypto("Key derivation failed".into()))?
}

/// Encrypt plaintext with AES-256-GCM. Returns `nonce(12) || ciphertext || tag`.
pub fn encrypt(plaintext: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, VaultError> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| VaultError::Crypto(format!("aes init: {e}")))?;

    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| VaultError::Crypto(format!("encrypt: {e}")))?;

    let mut result = Vec::with_capacity(12 + ciphertext.len());
    result.extend_from_slice(&nonce_bytes);
    result.extend_from_slice(&ciphertext);
    Ok(result)
}

/// Decrypt `nonce(12) || ciphertext || tag` with AES-256-GCM.
pub fn decrypt(payload: &[u8], key: &[u8; 32]) -> Result<Vec<u8>, VaultError> {
    if payload.len() < 12 {
        return Err(VaultError::Crypto("payload too short".into()));
    }
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|e| VaultError::Crypto(format!("aes init: {e}")))?;

    let nonce = Nonce::from_slice(&payload[..12]);
    let ciphertext = &payload[12..];

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| VaultError::Crypto(format!("decrypt: {e}")))
}

// ─── Vault Manager ──────────────────────────────────────────────────

const VAULT_CHECK_NAME: &str = "__netrix_vault_check__";
const VAULT_CHECK_VALUE: &[u8] = b"netrix-vault-check-v1";

/// Thread-safe vault state shared across requests.
pub struct VaultState {
    key: Option<Zeroizing<[u8; 32]>>,
    unlocked: bool,
    operation_lock: Arc<Mutex<()>>,
}

pub type SharedVault = Arc<RwLock<VaultState>>;

pub fn new_vault() -> SharedVault {
    Arc::new(RwLock::new(VaultState {
        key: None,
        unlocked: false,
        operation_lock: Arc::new(Mutex::new(())),
    }))
}

pub(crate) async fn lock_vault_operation(vault: &SharedVault) -> OwnedMutexGuard<()> {
    let operation_lock = vault.read().await.operation_lock.clone();
    operation_lock.lock_owned().await
}

pub(crate) async fn active_key(vault: &SharedVault) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    vault
        .read()
        .await
        .key
        .as_ref()
        .map(|key| Zeroizing::new(**key))
        .ok_or(VaultError::Locked)
}

pub(crate) async fn portable_key(
    password: String,
    salt: Vec<u8>,
) -> Result<Zeroizing<[u8; 32]>, VaultError> {
    let permit = KDF_SLOTS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| VaultError::Crypto("Key derivation unavailable".into()))?;
    let password = Zeroizing::new(password);
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut key = Zeroizing::new([0; 32]);
        let params =
            Params::new(65536, 3, 4, Some(32)).map_err(|e| VaultError::Crypto(e.to_string()))?;
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password_into(password.as_bytes(), &salt, key.as_mut())
            .map_err(|e| VaultError::Crypto(e.to_string()))?;
        Ok(key)
    })
    .await
    .map_err(|_| VaultError::Crypto("Key derivation failed".into()))?
}

/// Details about compatibility cleanup performed during a successful unlock.
///
/// Old Netrix databases may still contain credentials in the legacy plaintext
/// `hosts.password` / `hosts.private_key` columns. Those columns are never a
/// runtime credential source; unlock is the only place where their contents
/// are read, encrypted, and cleared.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct UnlockOutcome {
    pub migrated_legacy_hosts: u64,
    pub preserved_existing_credential_links: u64,
}

async fn load_linked_credential_object(
    connection: &mut SqliteConnection,
    credential_id: i64,
    key: &[u8; 32],
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, VaultError> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT ciphertext FROM vault_items WHERE id = ?")
        .bind(credential_id)
        .fetch_optional(&mut *connection)
        .await?;

    let Some((ciphertext,)) = row else {
        return Ok(None);
    };
    let Ok(plaintext) = decrypt(&ciphertext, key) else {
        return Ok(None);
    };

    Ok(
        match serde_json::from_slice::<serde_json::Value>(&plaintext) {
            Ok(serde_json::Value::Object(object)) => Some(object),
            _ => None,
        },
    )
}

/// Encrypt legacy host credentials and clear their plaintext columns in the
/// same transaction. Existing valid vault links remain authoritative; legacy
/// values are retained under a namespaced recovery field before their columns
/// are cleared. Broken/dangling links are not deleted: the legacy values are
/// moved to a new vault item and the old item is retained for recovery.
async fn migrate_legacy_host_credentials(
    connection: &mut SqliteConnection,
    key: &[u8; 32],
) -> Result<UnlockOutcome, VaultError> {
    let rows = sqlx::query_as::<_, (i64, String, Option<i64>, Option<String>, Option<String>)>(
        r#"SELECT id, name, credential_id, password, private_key
           FROM hosts
           WHERE password IS NOT NULL OR private_key IS NOT NULL"#,
    )
    .fetch_all(&mut *connection)
    .await?;

    let mut outcome = UnlockOutcome::default();

    for (host_id, host_name, credential_id, password, private_key) in rows {
        if let Some(item_id) = credential_id {
            if let Some(mut existing_payload) =
                load_linked_credential_object(connection, item_id, key).await?
            {
                let backup_key = "_netrix_legacy_plaintext_backup";
                let new_backup = serde_json::json!({
                    "password": password,
                    "private_key": private_key,
                });
                let backup_value = match existing_payload.remove(backup_key) {
                    None => new_backup,
                    Some(serde_json::Value::Array(mut backups)) => {
                        backups.push(new_backup);
                        serde_json::Value::Array(backups)
                    }
                    Some(previous_backup) => {
                        serde_json::Value::Array(vec![previous_backup, new_backup])
                    }
                };
                existing_payload.insert(backup_key.into(), backup_value);
                let migrated_payload = serde_json::Value::Object(existing_payload);
                let migrated_ciphertext = encrypt(migrated_payload.to_string().as_bytes(), key)?;

                sqlx::query("UPDATE vault_items SET ciphertext = ? WHERE id = ?")
                    .bind(migrated_ciphertext)
                    .bind(item_id)
                    .execute(&mut *connection)
                    .await?;

                let affected = sqlx::query(
                    "UPDATE hosts SET password = NULL, private_key = NULL WHERE id = ?",
                )
                .bind(host_id)
                .execute(&mut *connection)
                .await?
                .rows_affected();
                outcome.migrated_legacy_hosts += affected;
                outcome.preserved_existing_credential_links += affected;
                continue;
            }
        }

        let payload = serde_json::json!({
            "password": password,
            "private_key": private_key,
        });
        let ciphertext = encrypt(payload.to_string().as_bytes(), key)?;
        let item_name = format!("host:{host_name}");
        let metadata = r#"{"type":"host_credentials","migrated_from":"legacy_plaintext"}"#;
        let (new_credential_id,): (i64,) = sqlx::query_as(
            r#"INSERT INTO vault_items (name, ciphertext, item_metadata)
               VALUES (?, ?, ?)
               RETURNING id"#,
        )
        .bind(item_name)
        .bind(ciphertext)
        .bind(metadata)
        .fetch_one(&mut *connection)
        .await?;

        let affected = sqlx::query(
            r#"UPDATE hosts
               SET credential_id = ?, password = NULL, private_key = NULL
               WHERE id = ?"#,
        )
        .bind(new_credential_id)
        .bind(host_id)
        .execute(&mut *connection)
        .await?
        .rows_affected();
        outcome.migrated_legacy_hosts += affected;
    }

    Ok(outcome)
}

/// Public presence flags, derived only from the active credential fields.
/// Never include secret values or legacy recovery backups in metadata.
pub(crate) fn credential_metadata(plaintext: &[u8], metadata: Option<&str>) -> String {
    let mut meta = metadata
        .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
        .and_then(|m| m.as_object().cloned())
        .unwrap_or_default();
    let payload = serde_json::from_slice::<serde_json::Value>(plaintext).unwrap_or_default();
    for field in ["password", "private_key"] {
        meta.insert(
            format!("has_{field}"),
            serde_json::json!(payload[field].as_str().is_some_and(|s| !s.is_empty())),
        );
    }
    serde_json::Value::Object(meta).to_string()
}

pub(crate) async fn repair_credential_metadata(
    connection: &mut SqliteConnection,
    key: &[u8; 32],
) -> Result<(), VaultError> {
    let rows = sqlx::query_as::<_, (i64, Vec<u8>, Option<String>)>(
        r#"SELECT id,ciphertext,item_metadata FROM vault_items
           WHERE name != '__netrix_vault_check__' AND
           CASE WHEN json_valid(item_metadata) THEN COALESCE(
             json_type(item_metadata, '$.has_password') NOT IN ('true','false') OR
             json_type(item_metadata, '$.has_private_key') NOT IN ('true','false'), 1)
           ELSE 1 END"#,
    )
    .fetch_all(&mut *connection)
    .await?;
    for (id, ciphertext, metadata) in rows {
        if metadata
            .as_deref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .is_some_and(|m| m["has_password"].is_boolean() && m["has_private_key"].is_boolean())
        {
            continue;
        }
        let Ok(plain) = decrypt(&ciphertext, key).map(Zeroizing::new) else {
            continue;
        };
        let updated = credential_metadata(&plain, metadata.as_deref());
        if metadata.as_deref() != Some(updated.as_str()) {
            sqlx::query("UPDATE vault_items SET item_metadata=? WHERE id=?")
                .bind(updated)
                .bind(id)
                .execute(&mut *connection)
                .await?;
        }
    }
    Ok(())
}

/// Best-effort physical cleanup after legacy plaintext rows have been moved.
///
/// `secure_delete=ON` is configured for normal application connections, so
/// clearing the columns overwrites their cells. VACUUM also rebuilds the main
/// database to discard old/free pages, and the final checkpoint truncates WAL
/// frames that may still contain the pre-migration rows. Filesystems and SSDs
/// can retain lower-level copies outside SQLite's control, so this is not a
/// claim of forensic erasure.
async fn scrub_legacy_plaintext_storage(pool: &SqlitePool) {
    let mut connection = match pool.acquire().await {
        Ok(connection) => connection,
        Err(error) => {
            warn!("Legacy credential storage cleanup could not acquire SQLite: {error}");
            return;
        }
    };

    if let Err(error) = sqlx::query("VACUUM").execute(&mut *connection).await {
        warn!("Legacy credential storage VACUUM did not complete: {error}");
    }

    match sqlx::query_as::<_, (i64, i64, i64)>("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_one(&mut *connection)
        .await
    {
        Ok((busy, log_frames, checkpointed_frames)) if busy != 0 => warn!(
            "Legacy credential WAL cleanup remained busy (log_frames={log_frames}, checkpointed_frames={checkpointed_frames})"
        ),
        Ok(_) => {}
        Err(error) => warn!("Legacy credential WAL cleanup did not complete: {error}"),
    }
}

/// Unlock the vault by verifying / bootstrapping the check item.
/// Read-only validation used before replacing a plaintext database. It never
/// bootstraps a verifier, migrates credentials, or publishes a key.
pub(crate) async fn has_password_verifier(
    connection: &mut SqliteConnection,
) -> Result<bool, VaultError> {
    let exists: (i64,) = sqlx::query_as(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='vault_items'",
    )
    .fetch_one(&mut *connection)
    .await?;
    if exists.0 == 0 {
        return Ok(false);
    }
    let count: (i64,) = sqlx::query_as("SELECT count(*) FROM vault_items")
        .fetch_one(connection)
        .await?;
    Ok(count.0 > 0)
}

pub(crate) async fn verify_password_read_only(
    connection: &mut SqliteConnection,
    password: &str,
) -> Result<(), VaultError> {
    let key = derive_key_async(password).await?;
    let row: Option<(String, Vec<u8>)> =
        sqlx::query_as("SELECT name,ciphertext FROM vault_items ORDER BY (name = ?) DESC LIMIT 1")
            .bind(VAULT_CHECK_NAME)
            .fetch_optional(connection)
            .await?;
    if let Some((name, ciphertext)) = row {
        let plain =
            Zeroizing::new(decrypt(&ciphertext, &key).map_err(|_| VaultError::InvalidPassword)?);
        if name == VAULT_CHECK_NAME && !constant_time_eq(&plain, VAULT_CHECK_VALUE) {
            return Err(VaultError::InvalidPassword);
        }
    }
    Ok(())
}

pub async fn unlock(
    vault: &SharedVault,
    pool: &SqlitePool,
    password: &str,
) -> Result<UnlockOutcome, VaultError> {
    let candidate_key = derive_key_async(password).await?;

    // Serialise unlock/bootstrap/migration attempts and do not publish the key
    // until every database change has committed successfully.
    let _operation_guard = lock_vault_operation(vault).await;
    let mut tx = pool.begin().await?;

    // Look for the check item.
    let check_row: Option<(Vec<u8>,)> =
        sqlx::query_as("SELECT ciphertext FROM vault_items WHERE name = ?")
            .bind(VAULT_CHECK_NAME)
            .fetch_optional(&mut *tx)
            .await?;

    if let Some((ct,)) = check_row {
        // Verify the master password against the existing check item.
        let plain =
            Zeroizing::new(decrypt(&ct, &candidate_key).map_err(|_| VaultError::InvalidPassword)?);
        if !constant_time_eq(&plain, VAULT_CHECK_VALUE) {
            return Err(VaultError::InvalidPassword);
        }
    } else {
        // Bootstrap: if vault already has data, validate against an existing record.
        let sample: Option<(Vec<u8>,)> =
            sqlx::query_as("SELECT ciphertext FROM vault_items WHERE name != ? LIMIT 1")
                .bind(VAULT_CHECK_NAME)
                .fetch_optional(&mut *tx)
                .await?;

        if let Some((ct,)) = sample {
            decrypt(&ct, &candidate_key).map_err(|_| VaultError::InvalidPassword)?;
        }

        // Create the check item.
        let ct = encrypt(VAULT_CHECK_VALUE, &candidate_key)?;
        let meta = r#"{"type":"vault_check"}"#;
        sqlx::query("INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?)")
            .bind(VAULT_CHECK_NAME)
            .bind(&ct)
            .bind(meta)
            .execute(&mut *tx)
            .await?;
    }

    let outcome = migrate_legacy_host_credentials(&mut tx, &candidate_key).await?;
    repair_credential_metadata(&mut tx, &candidate_key).await?;
    tx.commit().await?;

    if outcome.migrated_legacy_hosts > 0 {
        scrub_legacy_plaintext_storage(pool).await;
    }

    // Store the key only after the check item and legacy migration commit.
    let mut state = vault.write().await;
    if let Some(ref mut old_key) = state.key {
        old_key.fill(0);
    }
    state.key = Some(candidate_key);
    state.unlocked = true;
    Ok(outcome)
}

/// Lock the vault — zeroize the key.
pub async fn lock(vault: &SharedVault) {
    let _operation_guard = lock_vault_operation(vault).await;
    let mut state = vault.write().await;
    if let Some(ref mut k) = state.key {
        k.fill(0);
    }
    state.key = None;
    state.unlocked = false;
}

/// Check if the vault is unlocked.
pub async fn is_unlocked(vault: &SharedVault) -> bool {
    vault.read().await.unlocked
}

/// Store an encrypted secret. Returns the new item ID.
pub async fn store_secret(
    vault: &SharedVault,
    pool: &SqlitePool,
    name: &str,
    plaintext: &[u8],
    metadata: Option<&str>,
) -> Result<i64, VaultError> {
    let mut connection = pool.acquire().await?;
    store_secret_in_connection(vault, &mut connection, name, plaintext, metadata).await
}

/// Store a secret through an existing SQLite connection. Callers can pass a
/// transaction's connection so the vault item and its owning row commit or
/// roll back together.
pub async fn store_secret_in_connection(
    vault: &SharedVault,
    connection: &mut SqliteConnection,
    name: &str,
    plaintext: &[u8],
    metadata: Option<&str>,
) -> Result<i64, VaultError> {
    let _operation_guard = lock_vault_operation(vault).await;
    let key = {
        let state = vault.read().await;
        state
            .key
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or(VaultError::Locked)?
    };

    let ct = encrypt(plaintext, &key)?;
    let meta = credential_metadata(plaintext, metadata);

    let row: (i64,) = sqlx::query_as(
        "INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?) RETURNING id",
    )
    .bind(name)
    .bind(&ct)
    .bind(meta)
    .fetch_one(connection)
    .await?;

    Ok(row.0)
}

/// Retrieve and decrypt a secret by ID.
pub async fn retrieve_secret(
    vault: &SharedVault,
    pool: &SqlitePool,
    item_id: i64,
) -> Result<Vec<u8>, VaultError> {
    let _operation_guard = lock_vault_operation(vault).await;
    let key = {
        let state = vault.read().await;
        state
            .key
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or(VaultError::Locked)?
    };

    let row: Option<(Vec<u8>,)> = sqlx::query_as("SELECT ciphertext FROM vault_items WHERE id = ?")
        .bind(item_id)
        .fetch_optional(pool)
        .await?;

    match row {
        Some((ct,)) => decrypt(&ct, &key),
        None => Err(VaultError::NotFound(item_id)),
    }
}

/// Change the master password by re-encrypting all vault items with a new key.
///
/// Requires the vault to be currently unlocked and the current password to match.
pub async fn change_master_password(
    vault: &SharedVault,
    pool: &SqlitePool,
    current_password: &str,
    new_password: &str,
) -> Result<usize, VaultError> {
    let _operation_guard = lock_vault_operation(vault).await;
    let active_key = {
        let state = vault.read().await;
        state
            .key
            .as_ref()
            .map(|key| Zeroizing::new(**key))
            .ok_or(VaultError::Locked)?
    };

    let provided_current_key = derive_key_async(current_password).await?;
    if !constant_time_eq(provided_current_key.as_ref(), active_key.as_ref()) {
        return Err(VaultError::InvalidPassword);
    }

    let new_key = derive_key_async(new_password).await?;

    let mut tx = pool.begin().await?;

    let rows = sqlx::query_as::<_, (i64, Vec<u8>)>("SELECT id, ciphertext FROM vault_items")
        .fetch_all(&mut *tx)
        .await?;

    let mut rotated_items = 0usize;
    for (item_id, ciphertext) in rows {
        let plaintext = Zeroizing::new(
            decrypt(&ciphertext, &active_key).map_err(|_| VaultError::InvalidPassword)?,
        );
        let new_ciphertext = encrypt(&plaintext, &new_key)?;

        sqlx::query("UPDATE vault_items SET ciphertext = ? WHERE id = ?")
            .bind(new_ciphertext)
            .bind(item_id)
            .execute(&mut *tx)
            .await?;

        rotated_items += 1;
    }

    let has_check_item =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items WHERE name = ?")
            .bind(VAULT_CHECK_NAME)
            .fetch_one(&mut *tx)
            .await?
            .0
            > 0;

    if !has_check_item {
        let ct = encrypt(VAULT_CHECK_VALUE, &new_key)?;
        let meta = r#"{"type":"vault_check"}"#;
        sqlx::query("INSERT INTO vault_items (name, ciphertext, item_metadata) VALUES (?, ?, ?)")
            .bind(VAULT_CHECK_NAME)
            .bind(&ct)
            .bind(meta)
            .execute(&mut *tx)
            .await?;
        rotated_items += 1;
    }

    tx.commit().await?;

    let mut state = vault.write().await;
    state.key = Some(new_key);
    state.unlocked = true;

    Ok(rotated_items)
}

/// Constant-time byte comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    use subtle::ConstantTimeEq;
    a.ct_eq(b).into()
}
