use axum::{
    extract::State,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

use crate::{
    auth::AppState,
    error::{AppError, AppResult},
    models::UnlockRequest,
    vault,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/security/status", get(status))
        .route("/security/lock", post(lock))
        .route("/security/unlock", post(unlock))
        .route("/security/activity", post(activity))
        .route("/security/policy", post(policy))
}

async fn snapshot(st: &AppState) -> AppResult<Json<Value>> {
    Ok(Json(json!({
        "locked": st.security.is_locked(),
        "revision": st.security.revision(),
        "vault_unlocked": vault::is_unlocked(&st.vault).await,
        "vault_initialized": super::vault::vault_is_initialized(&st.db).await?,
        "database_mode": "open",
        "database_encrypted": st.database_encryption.is_some(),
    })))
}

async fn status(State(st): State<AppState>) -> AppResult<Json<Value>> {
    let _guard = st.security.transition().await;
    snapshot(&st).await
}

async fn lock(State(st): State<AppState>) -> AppResult<Json<Value>> {
    st.security.lock_now(&st).await?;
    let _guard = st.security.transition().await;
    snapshot(&st).await
}

async fn unlock(
    State(st): State<AppState>,
    Json(body): Json<UnlockRequest>,
) -> AppResult<Json<Value>> {
    let password = Zeroizing::new(body.master_password);
    let _guard = st.security.transition().await;
    if !super::vault::vault_is_initialized(&st.db).await? {
        return Err(AppError::BadRequest(
            "The vault has no master password".into(),
        ));
    }
    let _ = super::vault::unlock_with_password(&st, &password).await?;
    st.security.unlock_after_verification().await;
    snapshot(&st).await
}

async fn activity(State(st): State<AppState>) -> AppResult<Json<Value>> {
    st.security.activity().await?;
    Ok(Json(json!({"ok": true})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Policy {
    app_timeout_seconds: Option<u64>,
    vault_timeout_seconds: Option<u64>,
}

async fn policy(State(st): State<AppState>, Json(body): Json<Policy>) -> AppResult<Json<Value>> {
    st.security
        .configure(body.app_timeout_seconds, body.vault_timeout_seconds)
        .await?;
    Ok(Json(json!({"ok": true})))
}
