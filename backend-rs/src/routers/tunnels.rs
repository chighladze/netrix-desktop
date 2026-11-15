use crate::{
    auth::AppState,
    error::{AppError, AppResult},
    models::Host,
    ssh::saved_host,
    ssh::tunnels::TunnelRule,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tunnels", get(list).post(create))
        .route("/tunnels/{id}", axum::routing::delete(remove))
        .route("/tunnels/{id}/start", post(start))
        .route("/tunnels/{id}/stop", post(stop))
}
#[derive(Deserialize)]
struct Input {
    name: String,
    host_id: i64,
    kind: String,
    bind_port: i64,
    destination_host: Option<String>,
    destination_port: Option<i64>,
}
async fn list(State(st): State<AppState>) -> AppResult<Json<Vec<Value>>> {
    let rules=sqlx::query_as::<_,TunnelRule>("SELECT id,name,host_id,kind,bind_port,destination_host,destination_port FROM ssh_tunnels ORDER BY name").fetch_all(&st.db).await?;
    let mut result = Vec::new();
    for rule in rules {
        let port = st.sessions.tunnels().status(&rule.id).await;
        let mut value =
            serde_json::to_value(rule).map_err(|e| AppError::Internal(e.to_string()))?;
        value["active"] = json!(port.is_some());
        value["actual_port"] = json!(port);
        result.push(value);
    }
    Ok(Json(result))
}
async fn create(
    State(st): State<AppState>,
    Json(body): Json<Input>,
) -> AppResult<(StatusCode, Json<Value>)> {
    if body.name.trim().is_empty()
        || body.name.len() > 255
        || !["local", "dynamic"].contains(&body.kind.as_str())
        || !(0..=65535).contains(&body.bind_port)
    {
        return Err(AppError::BadRequest(
            "Invalid tunnel name, kind or port".into(),
        ));
    }
    if body.kind == "local"
        && (body
            .destination_host
            .as_ref()
            .is_none_or(|h| h.is_empty() || h.len() > 253 || h.contains(['\0', '\r', '\n', ' ']))
            || body
                .destination_port
                .is_none_or(|p| !(1..=65535).contains(&p)))
    {
        return Err(AppError::BadRequest(
            "Local forwarding needs a destination host and port".into(),
        ));
    }
    let host: Option<(String,)> = sqlx::query_as("SELECT connection_type FROM hosts WHERE id=?")
        .bind(body.host_id)
        .fetch_optional(&st.db)
        .await?;
    if host.is_none_or(|row| row.0 != "ssh") {
        return Err(AppError::BadRequest("Choose an SSH host".into()));
    }
    let id = uuid::Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO ssh_tunnels(id,name,host_id,kind,bind_port,destination_host,destination_port) VALUES(?,?,?,?,?,?,?)")
        .bind(&id).bind(body.name.trim()).bind(body.host_id).bind(body.kind).bind(body.bind_port).bind(body.destination_host).bind(body.destination_port).execute(&st.db).await?;
    Ok((StatusCode::CREATED, Json(json!({"id":id}))))
}
async fn start(State(st): State<AppState>, Path(id): Path<String>) -> AppResult<Json<Value>> {
    let registration = st.sessions.tunnels().registration_gate().lock_owned().await;
    let rule=sqlx::query_as::<_,TunnelRule>("SELECT id,name,host_id,kind,bind_port,destination_host,destination_port FROM ssh_tunnels WHERE id=?").bind(&id).fetch_optional(&st.db).await?.ok_or_else(||AppError::NotFound("Tunnel not found".into()))?;
    let host =
        sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id=? AND connection_type='ssh'")
            .bind(rule.host_id)
            .fetch_optional(&st.db)
            .await?
            .ok_or_else(|| AppError::NotFound("SSH host not found".into()))?;
    let mut credentials = saved_host::load_credentials(&st, &host).await?;
    let target = json!({"hostname":host.hostname,"port":host.port,"username":host.username,"password":credentials.password.take(),"private_key":credentials.private_key.take(),"passphrase":credentials.passphrase.take()});
    let port = st
        .sessions
        .tunnels()
        .start_registered(&st.sessions, rule, target, Some(registration))
        .await
        .map_err(AppError::BadRequest)?;
    Ok(Json(json!({"active":true,"port":port})))
}
async fn stop(State(st): State<AppState>, Path(id): Path<String>) -> Json<Value> {
    let _registration = st.sessions.tunnels().registration_gate().lock_owned().await;
    Json(json!({"stopped":st.sessions.tunnels().stop(&id).await}))
}
async fn remove(State(st): State<AppState>, Path(id): Path<String>) -> AppResult<StatusCode> {
    let _registration = st.sessions.tunnels().registration_gate().lock_owned().await;
    st.sessions.tunnels().stop(&id).await;
    sqlx::query("DELETE FROM ssh_tunnels WHERE id=?")
        .bind(id)
        .execute(&st.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
