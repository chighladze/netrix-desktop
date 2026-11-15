/// Recent connections endpoints.
use axum::extract::{Path, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/recent-connections", get(list_recent).delete(clear_recent))
        .route(
            "/recent-connections/{id}",
            post(add_recent).delete(delete_recent),
        )
}

#[derive(Deserialize)]
struct ListQuery {
    #[serde(default = "default_limit")]
    limit: i64,
}
fn default_limit() -> i64 {
    10
}

async fn list_recent(
    State(st): State<AppState>,
    Query(q): Query<ListQuery>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let rows = sqlx::query_as::<_, RecentConnectionRow>(
        "SELECT * FROM recent_connections ORDER BY connected_at DESC LIMIT ?",
    )
    .bind(q.limit)
    .fetch_all(&st.db)
    .await?;

    let mut result = Vec::new();
    for rc in &rows {
        let host = sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
            .bind(rc.host_id)
            .fetch_optional(&st.db)
            .await?;
        if let Some(h) = host {
            result.push(serde_json::json!({
                "id": rc.id,
                "host": {
                    "id": h.id,
                    "name": h.name,
                    "hostname": h.hostname,
                    "port": h.port,
                    "username": h.username,
                    "connection_type": h.connection_type,
                    "serial_port": h.serial_port,
                    "serial_speed": h.serial_speed,
                    "group": h.group,
                    "credential_id": h.credential_id,
                    "terminal_theme": h.terminal_theme,
                    "terminal_font_size": h.terminal_font_size,
                    "terminal_background": h.terminal_background,
                    "terminal_foreground": h.terminal_foreground,
                    "terminal_appearance": h.terminal_appearance.as_deref().and_then(|value| serde_json::from_str::<crate::models::TerminalAppearance>(value).ok()),
                },
                "connected_at": rc.connected_at,
            }));
        }
    }
    Ok(Json(result))
}

async fn add_recent(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    // Verify host exists.
    let exists = sqlx::query("SELECT 1 FROM hosts WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("Host not found".into()));
    }

    // Remove existing entry for this host.
    sqlx::query("DELETE FROM recent_connections WHERE host_id = ?")
        .bind(id)
        .execute(&st.db)
        .await?;

    // Insert new entry.
    let row: (i64,) =
        sqlx::query_as("INSERT INTO recent_connections (host_id) VALUES (?) RETURNING id")
            .bind(id)
            .fetch_one(&st.db)
            .await?;

    Ok(Json(serde_json::json!({
        "message": "Connection recorded",
        "id": row.0
    })))
}

async fn clear_recent(State(st): State<AppState>) -> AppResult<Json<serde_json::Value>> {
    sqlx::query("DELETE FROM recent_connections")
        .execute(&st.db)
        .await?;
    Ok(Json(
        serde_json::json!({ "message": "Recent connections cleared" }),
    ))
}

async fn delete_recent(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<serde_json::Value>> {
    let affected = sqlx::query("DELETE FROM recent_connections WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound("Connection not found".into()));
    }
    Ok(Json(serde_json::json!({ "message": "Connection removed" })))
}
