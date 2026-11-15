/// Vault endpoints — unlock / lock / status / CRUD secrets.
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::vault;

const VAULT_RESET_CONFIRMATION: &str = "RESET VAULT";
const VAULT_CHECK_NAME: &str = "__netrix_vault_check__";
const MIN_VAULT_MASTER_PASSWORD_CHARS: usize = 10;

pub(crate) async fn vault_is_initialized(db: &crate::db::Db) -> Result<bool, sqlx::Error> {
    let vault_items = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items")
        .fetch_one(db)
        .await?
        .0;

    Ok(vault_items > 0)
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/vault/unlock", post(unlock_vault))
        .route("/vault/lock", post(lock_vault))
        .route("/vault/reset", post(reset_vault))
        .route("/vault/change-password", post(change_vault_password))
        .route("/vault/status", get(vault_status))
        .route("/vault/items", get(list_items).post(create_secret))
}

async fn unlock_vault(
    State(st): State<AppState>,
    Json(body): Json<UnlockRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let password = zeroize::Zeroizing::new(body.master_password);
    let _guard = st.security.transition().await;
    st.security.require_unlocked()?;
    let result = unlock_with_password(&st, &password).await;
    if result.is_ok() {
        st.security.unlock_after_verification().await;
    }
    result
}

pub(crate) async fn unlock_with_password(
    st: &AppState,
    password: &str,
) -> AppResult<Json<serde_json::Value>> {
    if let Err(retry_after_secs) = st.vault_unlock_limiter.check().await {
        return Err(AppError::RateLimited(format!(
            "Too many failed vault unlock attempts. Try again in {retry_after_secs} seconds."
        )));
    }

    let was_initialized = vault_is_initialized(&st.db).await?;

    if !was_initialized && password.chars().count() < MIN_VAULT_MASTER_PASSWORD_CHARS {
        return Err(AppError::BadRequest(format!(
            "Vault master password must be at least {MIN_VAULT_MASTER_PASSWORD_CHARS} characters"
        )));
    }

    match vault::unlock(&st.vault, &st.db, password).await {
        Ok(outcome) => {
            st.vault_unlock_limiter.record_success().await;
            tracing::info!(
                "Vault unlock succeeded (was_initialized={}, initialized=true, migrated_legacy_hosts={}, preserved_existing_credential_links={})",
                was_initialized,
                outcome.migrated_legacy_hosts,
                outcome.preserved_existing_credential_links,
            );
            Ok(Json(serde_json::json!({
                "unlocked": true,
                "initialized": true,
                "bootstrapped": !was_initialized,
                "migrated_legacy_hosts": outcome.migrated_legacy_hosts,
                "preserved_existing_credential_links": outcome.preserved_existing_credential_links,
            })))
        }
        Err(err) => {
            if matches!(err, vault::VaultError::InvalidPassword) {
                if let Some(retry_after_secs) = st.vault_unlock_limiter.record_failure().await {
                    tracing::warn!(
                        "Vault unlock temporarily rate limited after repeated failures ({retry_after_secs}s)"
                    );
                }
            }
            tracing::warn!("Vault unlock failed: {err}");
            Err(err.into())
        }
    }
}

async fn lock_vault(State(st): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let _guard = st.security.transition().await;
    st.security.require_unlocked()?;
    vault::lock(&st.vault).await;
    Ok(Json(serde_json::json!({ "unlocked": false })))
}

async fn reset_vault(
    State(st): State<AppState>,
    Json(body): Json<VaultResetRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let _guard = st.security.transition().await;
    st.security.require_unlocked()?;
    if body.confirmation.trim() != VAULT_RESET_CONFIRMATION {
        tracing::warn!("Vault reset rejected: confirmation phrase mismatch");
        return Err(AppError::BadRequest(format!(
            "Confirmation phrase mismatch. Type '{}' to proceed.",
            VAULT_RESET_CONFIRMATION,
        )));
    }

    // Ensure in-memory key material is dropped even if the DB reset fails.
    vault::lock(&st.vault).await;

    let mut tx = st.db.begin().await?;

    let detached_hosts =
        sqlx::query("UPDATE hosts SET credential_id = NULL WHERE credential_id IS NOT NULL")
            .execute(&mut *tx)
            .await?
            .rows_affected();

    // Clearing saved credentials must not discard the password that protects
    // the whole workspace. Password rotation has its own coordinated operation.
    let preserve_verifier = st.database_encryption.is_some();
    let deleted_items = sqlx::query("DELETE FROM vault_items WHERE ? = 0 OR name != ?")
        .bind(preserve_verifier)
        .bind(VAULT_CHECK_NAME)
        .execute(&mut *tx)
        .await?
        .rows_affected();

    tx.commit().await?;

    tracing::warn!(
        "Vault reset completed: detached_hosts={}, deleted_items={}",
        detached_hosts,
        deleted_items
    );

    Ok(Json(serde_json::json!({
        "reset": true,
        "unlocked": false,
        "initialized": preserve_verifier,
        "detached_hosts": detached_hosts,
        "deleted_items": deleted_items,
    })))
}

async fn change_vault_password(
    State(st): State<AppState>,
    Json(body): Json<VaultChangePasswordRequest>,
) -> AppResult<Json<serde_json::Value>> {
    let current_password = zeroize::Zeroizing::new(body.current_password);
    let new_password = zeroize::Zeroizing::new(body.new_password);
    let _guard = st.security.transition().await;
    st.security.require_unlocked()?;
    if new_password.chars().count() < 10 {
        return Err(AppError::BadRequest(
            "New master password must be at least 10 characters".into(),
        ));
    }
    if new_password.len() > crate::database_encryption::MAX_MASTER_PASSWORD_BYTES {
        return Err(AppError::BadRequest(
            "New master password must be at most 1024 UTF-8 bytes".into(),
        ));
    }
    if new_password == current_password {
        return Err(AppError::BadRequest(
            "New master password must be different from current password".into(),
        ));
    }

    if let Some(storage) = &st.database_encryption {
        let mut connection = st.db.acquire().await?;
        vault::verify_password_read_only(&mut connection, &current_password).await?;
        storage
            .prepare_password_change(&current_password, &new_password)
            .await
            .map_err(|_| {
                AppError::Internal(
                    "Unable to prepare database password change; the current password is unchanged"
                        .into(),
                )
            })?;
    }
    let rotation =
        vault::change_master_password(&st.vault, &st.db, &current_password, &new_password).await;
    if let Some(storage) = &st.database_encryption {
        let committed_password = if rotation.is_ok() {
            &new_password
        } else {
            &current_password
        };
        storage.finish_password_change(committed_password).await
            .map_err(|_| AppError::Internal("Password change requires recovery on restart; keep both current and new passwords".into()))?;
    }
    let rotated_items = rotation?;

    Ok(Json(serde_json::json!({
        "changed": true,
        "unlocked": true,
        "rotated_items": rotated_items,
    })))
}

async fn vault_status(State(st): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    let unlocked = vault::is_unlocked(&st.vault).await;
    let initialized = vault_is_initialized(&st.db).await?;
    let secret_items =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM vault_items WHERE name != ?")
            .bind(VAULT_CHECK_NAME)
            .fetch_one(&st.db)
            .await?
            .0;

    let linked_hosts =
        sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM hosts WHERE credential_id IS NOT NULL")
            .fetch_one(&st.db)
            .await?
            .0;

    Ok(Json(serde_json::json!({
        "unlocked": unlocked,
        "initialized": initialized,
        "secret_items": secret_items,
        "linked_hosts": linked_hosts,
    })))
}

async fn list_items(State(st): State<AppState>) -> AppResult<Json<Vec<VaultItemOut>>> {
    let rows = sqlx::query_as::<_, VaultItemRow>("SELECT * FROM vault_items")
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows.iter().map(VaultItemOut::from_row).collect()))
}

async fn create_secret(
    State(st): State<AppState>,
    Json(body): Json<SecretCreateRequest>,
) -> AppResult<impl IntoResponse> {
    if body.name.trim().is_empty() || body.name.len() > 255 || body.name.starts_with("__netrix_") {
        return Err(AppError::BadRequest(
            "Choose a non-reserved vault item name of 1–255 characters".into(),
        ));
    }
    if !vault::is_unlocked(&st.vault).await {
        return Err(AppError::Unauthorized(
            "Vault must be unlocked to store secrets".into(),
        ));
    }

    let meta = body.metadata.as_ref().map(|v| v.to_string());

    let item_id = vault::store_secret(
        &st.vault,
        &st.db,
        &body.name,
        body.plaintext.as_bytes(),
        meta.as_deref(),
    )
    .await?;

    let row = sqlx::query_as::<_, VaultItemRow>("SELECT * FROM vault_items WHERE id = ?")
        .bind(item_id)
        .fetch_one(&st.db)
        .await?;

    Ok((StatusCode::CREATED, Json(VaultItemOut::from_row(&row))))
}
