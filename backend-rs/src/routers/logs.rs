/// Audit log endpoints.
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};

use crate::auth::AppState;
use crate::error::AppResult;
use crate::models::*;

pub fn router() -> Router<AppState> {
    Router::new().route("/logs", get(list_logs))
}

async fn list_logs(State(st): State<AppState>) -> AppResult<Json<Vec<AuditLogOut>>> {
    let rows = sqlx::query_as::<_, AuditLogRow>("SELECT * FROM audit_logs ORDER BY timestamp DESC")
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows.iter().map(AuditLogOut::from_row).collect()))
}
