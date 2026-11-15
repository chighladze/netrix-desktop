/// Unified error types for the Netrix backend.
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::vault::VaultError;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Netrix is locked. Enter the master password to continue.")]
    Locked,
    #[error("not found: {0}")]
    NotFound(String),

    #[error("conflict: {0}")]
    Conflict(String),

    #[error("bad request: {0}")]
    BadRequest(String),

    #[error("unauthorized: {0}")]
    Unauthorized(String),

    #[error("rate limited: {0}")]
    RateLimited(String),

    #[error("vault error: {0}")]
    Vault(#[from] VaultError),

    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),

    #[error("internal error: {0}")]
    Internal(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, detail) = match &self {
            AppError::Locked => (StatusCode::LOCKED, self.to_string()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            AppError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::Unauthorized(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::RateLimited(msg) => (StatusCode::TOO_MANY_REQUESTS, msg.clone()),
            AppError::Vault(VaultError::Locked) => {
                (StatusCode::UNAUTHORIZED, "Vault must be unlocked".into())
            }
            AppError::Vault(VaultError::InvalidPassword) => {
                (StatusCode::UNAUTHORIZED, "Invalid master password".into())
            }
            AppError::Vault(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            AppError::Db(e) => {
                tracing::error!("Database error: {e}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error".into(),
                )
            }
            AppError::Internal(msg) => {
                tracing::error!("Internal error: {msg}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal Server Error".into(),
                )
            }
        };

        (status, Json(json!({ "detail": detail }))).into_response()
    }
}

/// Convenience alias.
pub type AppResult<T> = Result<T, AppError>;
