/// Quick action CRUD endpoints.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, put};
use axum::{Json, Router};

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::*;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/quick-actions", get(list_actions).post(create_action))
        .route(
            "/quick-actions/{action_id}",
            put(update_action).delete(delete_action),
        )
}

async fn list_actions(State(st): State<AppState>) -> AppResult<Json<Vec<QuickActionRow>>> {
    let rows =
        sqlx::query_as::<_, QuickActionRow>("SELECT * FROM quick_actions ORDER BY created_at ASC")
            .fetch_all(&st.db)
            .await?;
    Ok(Json(rows))
}

async fn create_action(
    State(st): State<AppState>,
    Json(body): Json<QuickActionCreate>,
) -> AppResult<impl IntoResponse> {
    sqlx::query(
        "INSERT INTO quick_actions (id, label, command, color, category, description) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&body.id)
    .bind(&body.label)
    .bind(&body.command)
    .bind(&body.color)
    .bind(&body.category)
    .bind(&body.description)
    .execute(&st.db)
    .await?;

    let row = sqlx::query_as::<_, QuickActionRow>("SELECT * FROM quick_actions WHERE id = ?")
        .bind(&body.id)
        .fetch_one(&st.db)
        .await?;

    Ok((StatusCode::CREATED, Json(row)))
}

async fn update_action(
    State(st): State<AppState>,
    Path(action_id): Path<String>,
    Json(body): Json<QuickActionUpdate>,
) -> AppResult<Json<QuickActionRow>> {
    let existing = sqlx::query_as::<_, QuickActionRow>("SELECT * FROM quick_actions WHERE id = ?")
        .bind(&action_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Action not found".into()))?;

    let label = body.label.as_deref().unwrap_or(&existing.label);
    let command = body.command.as_deref().unwrap_or(&existing.command);
    let color = body.color.as_deref().unwrap_or(&existing.color);
    let category = body.category.as_deref().unwrap_or(&existing.category);
    let description = body
        .description
        .as_deref()
        .or(existing.description.as_deref());

    sqlx::query(
        "UPDATE quick_actions SET label = ?, command = ?, color = ?, category = ?, description = ? WHERE id = ?",
    )
    .bind(label)
    .bind(command)
    .bind(color)
    .bind(category)
    .bind(description)
    .bind(&action_id)
    .execute(&st.db)
    .await?;

    let row = sqlx::query_as::<_, QuickActionRow>("SELECT * FROM quick_actions WHERE id = ?")
        .bind(&action_id)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(row))
}

async fn delete_action(
    State(st): State<AppState>,
    Path(action_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let affected = sqlx::query("DELETE FROM quick_actions WHERE id = ?")
        .bind(&action_id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound("Action not found".into()));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}
