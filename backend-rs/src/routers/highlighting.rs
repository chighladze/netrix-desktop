/// Highlight rule CRUD endpoints.
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
        .route("/highlight-rules", get(list_rules).post(create_rule))
        .route(
            "/highlight-rules/{rule_id}",
            put(update_rule).delete(delete_rule),
        )
}

async fn list_rules(State(st): State<AppState>) -> AppResult<Json<Vec<HighlightRuleRow>>> {
    let rows = sqlx::query_as::<_, HighlightRuleRow>(
        "SELECT * FROM highlight_rules ORDER BY created_at ASC",
    )
    .fetch_all(&st.db)
    .await?;
    Ok(Json(rows))
}

async fn create_rule(
    State(st): State<AppState>,
    Json(body): Json<HighlightRuleCreate>,
) -> AppResult<impl IntoResponse> {
    sqlx::query(
        "INSERT INTO highlight_rules (id, keyword, color, highlight_type, is_active) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&body.id)
    .bind(&body.keyword)
    .bind(&body.color)
    .bind(&body.highlight_type)
    .bind(body.is_active)
    .execute(&st.db)
    .await?;

    let row = sqlx::query_as::<_, HighlightRuleRow>("SELECT * FROM highlight_rules WHERE id = ?")
        .bind(&body.id)
        .fetch_one(&st.db)
        .await?;

    Ok((StatusCode::CREATED, Json(row)))
}

async fn update_rule(
    State(st): State<AppState>,
    Path(rule_id): Path<String>,
    Json(body): Json<HighlightRuleUpdate>,
) -> AppResult<Json<HighlightRuleRow>> {
    let existing =
        sqlx::query_as::<_, HighlightRuleRow>("SELECT * FROM highlight_rules WHERE id = ?")
            .bind(&rule_id)
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| AppError::NotFound("Rule not found".into()))?;

    let keyword = body.keyword.as_deref().unwrap_or(&existing.keyword);
    let color = body.color.as_deref().unwrap_or(&existing.color);
    let highlight_type = body
        .highlight_type
        .as_deref()
        .unwrap_or(&existing.highlight_type);
    let is_active = body.is_active.unwrap_or(existing.is_active);

    sqlx::query(
        "UPDATE highlight_rules SET keyword = ?, color = ?, highlight_type = ?, is_active = ? WHERE id = ?",
    )
    .bind(keyword)
    .bind(color)
    .bind(highlight_type)
    .bind(is_active)
    .bind(&rule_id)
    .execute(&st.db)
    .await?;

    let row = sqlx::query_as::<_, HighlightRuleRow>("SELECT * FROM highlight_rules WHERE id = ?")
        .bind(&rule_id)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(row))
}

async fn delete_rule(
    State(st): State<AppState>,
    Path(rule_id): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let affected = sqlx::query("DELETE FROM highlight_rules WHERE id = ?")
        .bind(&rule_id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound("Rule not found".into()));
    }
    Ok(Json(serde_json::json!({ "ok": true })))
}
