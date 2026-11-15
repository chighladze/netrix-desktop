//! Managed credentials reuse the vault; responses expose public metadata only.
use crate::{
    auth::AppState,
    error::{AppError, AppResult},
    vault,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/credentials", get(list).post(create))
        .route(
            "/credentials/{id}",
            axum::routing::put(update).delete(remove),
        )
        .route("/credentials/{id}/hosts/{host_id}", post(bind_host))
        .route("/known-hosts", get(known_hosts).delete(forget_host))
}

#[derive(Deserialize)]
struct CredentialInput {
    name: String,
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    private_key: Option<String>,
    #[serde(default)]
    passphrase: Option<String>,
    #[serde(default)]
    generate: Option<String>,
}

async fn prepare(body: CredentialInput) -> AppResult<(String, Zeroizing<Vec<u8>>, String)> {
    if body.name.trim().is_empty() || body.name.len() > 255 || body.name.starts_with("__netrix_") {
        return Err(AppError::BadRequest(
            "A credential needs a name of 1–255 characters".into(),
        ));
    }
    if body
        .username
        .as_ref()
        .is_some_and(|v| v.len() > 255 || v.contains(['\0', '\r', '\n']))
    {
        return Err(AppError::BadRequest("Invalid username".into()));
    }
    if body
        .private_key
        .as_ref()
        .is_some_and(|key| key.len() > 128 * 1024)
        || body
            .password
            .as_ref()
            .is_some_and(|password| password.len() > 16 * 1024)
        || body
            .passphrase
            .as_ref()
            .is_some_and(|value| value.len() > 16 * 1024)
    {
        return Err(AppError::BadRequest(
            "Credential exceeds the size limit".into(),
        ));
    }
    if body.generate.is_some() && body.private_key.is_some() {
        return Err(AppError::BadRequest(
            "Choose generation or key import".into(),
        ));
    }
    static SLOTS: std::sync::LazyLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(2)));
    let permit = SLOTS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AppError::Internal("Key generation unavailable".into()))?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut private_key = body.private_key.map(Zeroizing::new);
        let passphrase = body.passphrase.map(Zeroizing::new);
        let password = body.password.map(Zeroizing::new);
        let mut public_key = None;
        if let Some(algorithm) = body.generate {
            use russh::keys::ssh_key::{Algorithm, PrivateKey, LineEnding};
            let algorithm = match algorithm.as_str() {
                "ed25519" => Algorithm::Ed25519,
                "rsa" => Algorithm::Rsa { hash: None },
                _ => return Err(AppError::BadRequest("Supported algorithms: ed25519, rsa".into())),
            };
            let mut rng = rand_latest::rng();
            let key = PrivateKey::random(&mut rng, algorithm).map_err(|e| AppError::BadRequest(format!("Key generation failed: {e}")))?;
            public_key = Some(key.public_key().to_openssh().map_err(|e| AppError::BadRequest(e.to_string()))?);
            let key = if let Some(phrase) = passphrase.as_ref().filter(|p| !p.is_empty()) {
                key.encrypt(&mut rng, phrase.as_bytes()).map_err(|e| AppError::BadRequest(e.to_string()))?
            } else { key };
            private_key = Some(key.to_openssh(LineEnding::LF).map_err(|e| AppError::BadRequest(e.to_string()))?);
        } else if let Some(key) = &private_key {
            let decoded = russh::keys::decode_secret_key(key, passphrase.as_deref().map(|p| p.as_str()))
                .map_err(|_| AppError::BadRequest("Private key or passphrase is invalid".into()))?;
            public_key = Some(decoded.public_key().to_openssh().map_err(|e| AppError::BadRequest(e.to_string()))?);
        }
        if private_key.is_none() && password.as_ref().is_none_or(|value| value.is_empty()) {
            return Err(AppError::BadRequest("Provide a password, import a key, or generate one".into()));
        }
        let secret = Zeroizing::new(serde_json::to_vec(&json!({
            "username": body.username, "password": password.as_deref(),
            "private_key": private_key.as_deref(), "passphrase": passphrase.as_deref(),
        })).map_err(|e| AppError::Internal(e.to_string()))?);
        let metadata = json!({"has_password":password.as_ref().is_some_and(|p| !p.is_empty()),"has_private_key":private_key.as_ref().is_some_and(|p| !p.is_empty()),"managed":true,"type":if private_key.is_some() {"ssh_key"} else {"identity"},"username":body.username,"public_key":public_key}).to_string();
        Ok((body.name.trim().to_string(), secret, metadata))
    }).await.map_err(|_| AppError::Internal("Key operation failed".into()))?
}

async fn list(State(st): State<AppState>) -> AppResult<Json<Vec<Value>>> {
    let rows = sqlx::query_as::<_, crate::models::VaultItemRow>(
        "SELECT * FROM vault_items WHERE name != '__netrix_vault_check__' ORDER BY name",
    )
    .fetch_all(&st.db)
    .await?;
    let mut items = Vec::new();
    for row in rows {
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM hosts WHERE credential_id = ?")
            .bind(row.id)
            .fetch_one(&st.db)
            .await?;
        let item = crate::models::VaultItemOut::from_row(&row);
        // Generic vault metadata is user-controlled; expose public fields only.
        let kind = item.item_metadata["type"]
            .as_str()
            .filter(|kind| ["ssh_key", "identity", "host_credentials"].contains(kind))
            .unwrap_or("vault_item");
        let username = item.item_metadata["username"]
            .as_str()
            .filter(|name| name.len() <= 255);
        let public_key = item.item_metadata["public_key"]
            .as_str()
            .and_then(|key| russh::keys::PublicKey::from_openssh(key).ok())
            .and_then(|key| key.to_openssh().ok());
        let metadata = json!({"type":kind,"username":username,"public_key":public_key});
        items.push(
            json!({"id":item.id,"name":item.name,"metadata":metadata,"linked_hosts":count.0}),
        );
    }
    Ok(Json(items))
}
async fn create(
    State(st): State<AppState>,
    Json(body): Json<CredentialInput>,
) -> AppResult<(StatusCode, Json<Value>)> {
    if !vault::is_unlocked(&st.vault).await {
        return Err(vault::VaultError::Locked.into());
    }
    let (name, secret, metadata) = prepare(body).await?;
    let id = vault::store_secret(&st.vault, &st.db, &name, &secret, Some(&metadata)).await?;
    Ok((StatusCode::CREATED, Json(json!({"id":id}))))
}
async fn update(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<CredentialInput>,
) -> AppResult<Json<Value>> {
    if !vault::is_unlocked(&st.vault).await {
        return Err(vault::VaultError::Locked.into());
    }
    let (name, secret, metadata) = prepare(body).await?;
    let _guard = vault::lock_vault_operation(&st.vault).await;
    let key = vault::active_key(&st.vault).await?;
    let encrypted = vault::encrypt(&secret, &key)?;
    let username = serde_json::from_str::<Value>(&metadata)
        .ok()
        .and_then(|value| {
            value["username"]
                .as_str()
                .filter(|name| !name.is_empty())
                .map(String::from)
        });
    let mut tx = st.db.begin().await?;
    let result = sqlx::query("UPDATE vault_items SET name=?, ciphertext=?, item_metadata=? WHERE id=? AND name != '__netrix_vault_check__'")
        .bind(name).bind(encrypted).bind(metadata).bind(id).execute(&mut *tx).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Credential not found".into()));
    }
    sqlx::query("UPDATE hosts SET username=COALESCE(?,username) WHERE credential_id=?")
        .bind(username)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(json!({"updated":true})))
}
async fn remove(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<StatusCode> {
    let _guard = vault::lock_vault_operation(&st.vault).await;
    let _key = vault::active_key(&st.vault).await?;
    let mut tx = st.db.begin().await?;
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM hosts WHERE credential_id=?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if count.0 != 0 {
        return Err(AppError::Conflict(
            "Credential is in use. Change or clear it on linked hosts first.".into(),
        ));
    }
    let result =
        sqlx::query("DELETE FROM vault_items WHERE id=? AND name != '__netrix_vault_check__'")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("Credential not found".into()));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn bind_host(
    State(st): State<AppState>,
    Path((id, host_id)): Path<(i64, i64)>,
) -> AppResult<Json<Value>> {
    let _guard = vault::lock_vault_operation(&st.vault).await;
    let key = vault::active_key(&st.vault).await?;
    let mut tx = st.db.begin().await?;
    let (encrypted,): (Vec<u8>,) = sqlx::query_as(
        "SELECT ciphertext FROM vault_items WHERE id=? AND name != '__netrix_vault_check__'",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| AppError::NotFound("Credential not found".into()))?;
    let payload = Zeroizing::new(vault::decrypt(&encrypted, &key)?);
    let value: Value = serde_json::from_slice(&payload)
        .map_err(|_| AppError::BadRequest("This vault item is not an SSH credential".into()))?;
    if value["password"].as_str().is_none() && value["private_key"].as_str().is_none() {
        return Err(AppError::BadRequest(
            "This vault item is not an SSH credential".into(),
        ));
    }
    let previous: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT credential_id FROM hosts WHERE id=? AND connection_type='ssh'")
            .bind(host_id)
            .fetch_optional(&mut *tx)
            .await?;
    let result = sqlx::query("UPDATE hosts SET credential_id=?, username=COALESCE(?,username), password=NULL, private_key=NULL WHERE id=? AND connection_type='ssh'")
        .bind(id).bind(value["username"].as_str().filter(|name| !name.is_empty())).bind(host_id).execute(&mut *tx).await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("SSH host not found".into()));
    }
    if let Some((Some(previous),)) = previous {
        if previous != id {
            super::hosts::cleanup_orphan_credential(&mut tx, previous).await?;
        }
    }
    tx.commit().await?;
    Ok(Json(json!({"linked":true})))
}
async fn known_hosts(State(st): State<AppState>) -> AppResult<Json<Vec<Value>>> {
    let entries = st
        .sessions
        .known_hosts()
        .list()
        .await
        .map_err(|error| AppError::Conflict(error.to_string()))?
        .into_iter()
        .map(|(address, key)| {
            let fingerprint = russh::keys::PublicKey::from_openssh(&key).ok().map(|key| {
                key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
                    .to_string()
            });
            json!({"address":address,"key":key,"fingerprint":fingerprint})
        })
        .collect();
    Ok(Json(entries))
}
#[derive(Deserialize)]
struct ForgetHost {
    host: String,
    port: u16,
    expected_key: String,
    confirmation: String,
}
async fn forget_host(
    State(st): State<AppState>,
    Json(body): Json<ForgetHost>,
) -> AppResult<Json<Value>> {
    if body.confirmation != "FORGET HOST KEY" {
        return Err(AppError::BadRequest(
            "Type FORGET HOST KEY to remove trust".into(),
        ));
    }
    let removed = st
        .sessions
        .known_hosts()
        .forget(&body.host, body.port, &body.expected_key)
        .await
        .map_err(|e| AppError::Conflict(e.to_string()))?;
    Ok(Json(json!({"removed":removed})))
}
