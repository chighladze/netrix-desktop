/// Snippet CRUD + execution endpoints.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicI64, Ordering};

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::ssh::manager::SessionEvent;
use crate::ssh::saved_host;

const MAX_SNIPPET_HOSTS: usize = 32;
const MAX_SNIPPET_COMMAND_BYTES: usize = 64 * 1024;
const MAX_SNIPPET_OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_TRUNCATED_MARKER: &str = "\n[Netrix: output truncated at 1 MiB]\n";
static NEXT_SNIPPET_SESSION_ID: AtomicI64 = AtomicI64::new(-1);

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/snippets", get(list_snippets).post(create_snippet))
        .route(
            "/snippets/{snippet_id}",
            get(get_snippet)
                .put(update_snippet)
                .patch(update_snippet)
                .delete(delete_snippet),
        )
        .route("/snippets/{snippet_id}/run", post(run_snippet))
}

async fn list_snippets(State(st): State<AppState>) -> AppResult<Json<Vec<SnippetOut>>> {
    let rows = sqlx::query_as::<_, SnippetRow>("SELECT * FROM snippets")
        .fetch_all(&st.db)
        .await?;
    Ok(Json(rows.iter().map(SnippetOut::from_row).collect()))
}

async fn get_snippet(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Json<SnippetOut>> {
    let row = sqlx::query_as::<_, SnippetRow>("SELECT * FROM snippets WHERE id = ?")
        .bind(id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Snippet not found".into()))?;
    Ok(Json(SnippetOut::from_row(&row)))
}

async fn create_snippet(
    State(st): State<AppState>,
    Json(body): Json<SnippetCreate>,
) -> AppResult<impl IntoResponse> {
    let mut tx = st.db.begin_with("BEGIN IMMEDIATE").await?;
    validate_snippet(&mut tx, &body).await?;
    let vars = body
        .variables
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".into());

    let row = sqlx::query_as::<_, (i64,)>(
        "INSERT INTO snippets (title, template, variables, host_id) VALUES (?, ?, ?, ?) RETURNING id",
    )
    .bind(&body.title)
    .bind(&body.template)
    .bind(&vars)
    .bind(body.host_id)
    .fetch_one(&mut *tx)
    .await?;

    let snippet = sqlx::query_as::<_, SnippetRow>("SELECT * FROM snippets WHERE id = ?")
        .bind(row.0)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok((StatusCode::CREATED, Json(SnippetOut::from_row(&snippet))))
}

async fn update_snippet(
    State(st): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<SnippetUpdate>,
) -> AppResult<Json<SnippetOut>> {
    let mut tx = st.db.begin_with("BEGIN IMMEDIATE").await?;
    let previous = sqlx::query_as::<_, SnippetRow>("SELECT * FROM snippets WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Snippet not found".into()))?;
    let body = SnippetCreate {
        title: body.title.unwrap_or(previous.title),
        template: body.template.unwrap_or(previous.template),
        variables: body.variables.merge(
            previous
                .variables
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok()),
        ),
        host_id: body.host_id.merge(previous.host_id),
    };
    validate_snippet(&mut tx, &body).await?;

    let vars = body
        .variables
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_else(|| "{}".into());

    sqlx::query(
        "UPDATE snippets SET title = ?, template = ?, variables = ?, host_id = ? WHERE id = ?",
    )
    .bind(&body.title)
    .bind(&body.template)
    .bind(&vars)
    .bind(body.host_id)
    .bind(id)
    .execute(&mut *tx)
    .await?;

    let row = sqlx::query_as::<_, SnippetRow>("SELECT * FROM snippets WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(SnippetOut::from_row(&row)))
}

async fn validate_snippet(
    connection: &mut sqlx::SqliteConnection,
    body: &SnippetCreate,
) -> AppResult<()> {
    if body.title.trim().is_empty()
        || body.title.len() > 255
        || body.title.chars().any(char::is_control)
    {
        return Err(AppError::BadRequest(
            "Snippet title must contain 1–255 bytes without control characters".into(),
        ));
    }
    if body.template.trim().is_empty()
        || body.template.len() > MAX_SNIPPET_COMMAND_BYTES
        || body.template.contains('\0')
    {
        return Err(AppError::BadRequest(
            "Snippet command must contain 1–65536 bytes without NUL".into(),
        ));
    }
    if body.variables.as_ref().is_some_and(|value| {
        !value.is_object() || value.to_string().len() > MAX_SNIPPET_COMMAND_BYTES
    }) {
        return Err(AppError::BadRequest(
            "Snippet variables must be a JSON object of at most 65536 bytes".into(),
        ));
    }
    if let Some(id) = body.host_id {
        let exists = sqlx::query("SELECT 1 FROM hosts WHERE id=?")
            .bind(id)
            .fetch_optional(connection)
            .await?;
        if exists.is_none() {
            return Err(AppError::BadRequest("Snippet host not found".into()));
        }
    }
    Ok(())
}

async fn delete_snippet(
    State(st): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<impl IntoResponse> {
    let affected = sqlx::query("DELETE FROM snippets WHERE id = ?")
        .bind(id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound("Snippet not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct SnippetRunRequest {
    variables: Option<serde_json::Value>,
    host_ids: Option<Vec<i64>>,
}

fn append_bounded_output(output: &mut Vec<u8>, chunk: &[u8]) -> bool {
    let remaining = MAX_SNIPPET_OUTPUT_BYTES.saturating_sub(output.len());
    if remaining == 0 {
        return false;
    }
    let copied = remaining.min(chunk.len());
    output.extend_from_slice(&chunk[..copied]);
    copied == chunk.len()
}

async fn run_snippet(
    State(st): State<AppState>,
    Path(snippet_id): Path<i64>,
    Json(body): Json<SnippetRunRequest>,
) -> AppResult<Json<Vec<serde_json::Value>>> {
    let snippet = sqlx::query_as::<_, SnippetRow>("SELECT * FROM snippets WHERE id = ?")
        .bind(snippet_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Snippet not found".into()))?;

    let host_ids: Vec<i64> = body
        .host_ids
        .unwrap_or_else(|| snippet.host_id.into_iter().collect());

    if host_ids.is_empty() {
        return Err(AppError::BadRequest("No hosts specified".into()));
    }
    if host_ids.len() > MAX_SNIPPET_HOSTS {
        return Err(AppError::BadRequest(format!(
            "A snippet can run on at most {MAX_SNIPPET_HOSTS} hosts"
        )));
    }
    let mut seen_host_ids = HashSet::with_capacity(host_ids.len());
    let host_ids: Vec<i64> = host_ids
        .into_iter()
        .filter(|host_id| seen_host_ids.insert(*host_id))
        .collect();

    // Render template variables.
    let mut rendered = snippet.template.clone();
    if let Some(vars) = &body.variables {
        if let Some(obj) = vars.as_object() {
            for (k, v) in obj {
                let val = v.as_str().unwrap_or("");
                rendered = rendered.replace(&format!("{{{{ {k} }}}}"), val);
            }
        }
    }
    if rendered.len() > MAX_SNIPPET_COMMAND_BYTES {
        return Err(AppError::BadRequest(format!(
            "Rendered snippet cannot exceed {MAX_SNIPPET_COMMAND_BYTES} bytes"
        )));
    }

    // Execute on each host via SSH sessions.
    let mut results = Vec::new();
    for hid in &host_ids {
        let host = sqlx::query_as::<_, crate::models::Host>("SELECT * FROM hosts WHERE id = ?")
            .bind(hid)
            .fetch_optional(&st.db)
            .await?;
        let host = match host {
            Some(h) => h,
            None => {
                results.push(serde_json::json!({
                    "host": format!("id:{hid}"),
                    "output": "",
                    "error": "Host not found"
                }));
                continue;
            }
        };

        if !matches!(host.connection_type.as_str(), "ssh" | "telnet") {
            results.push(serde_json::json!({
                "host": host.name,
                "output": "",
                "error": format!(
                    "Snippet execution is not supported for {} hosts",
                    host.connection_type
                )
            }));
            continue;
        }

        let mut credentials = match saved_host::load_credentials(&st, &host).await {
            Ok(credentials) => credentials,
            Err(error) => {
                results.push(serde_json::json!({
                    "host": host.name,
                    "output": "",
                    "error": error.to_string()
                }));
                continue;
            }
        };

        // For snippet execution, we create a temporary session.
        // Allocate a process-unique negative ID so concurrent snippet runs on
        // the same host cannot accidentally share a temporary session.
        let sid = NEXT_SNIPPET_SESSION_ID.fetch_sub(1, Ordering::Relaxed);
        let host_info = serde_json::json!({
            "hostname": host.hostname,
            "port": host.port,
            "username": host.username,
            "password": credentials.password.take(),
            "private_key": credentials.private_key.take(),
            "passphrase": credentials.passphrase.take(),
            "connection_type": host.connection_type,
        });

        if host.connection_type == "ssh" {
            match st
                .sessions
                .execute_ssh(&host_info, &rendered, MAX_SNIPPET_OUTPUT_BYTES)
                .await
            {
                Ok(result) => {
                    let stdout = String::from_utf8_lossy(&result.stdout);
                    let stderr = String::from_utf8_lossy(&result.stderr);
                    let mut output = format!("{stdout}{stderr}");
                    if result.truncated {
                        output.push_str(OUTPUT_TRUNCATED_MARKER);
                    }
                    results.push(serde_json::json!({
                        "host": host.name, "output": output, "stdout": stdout, "stderr": stderr,
                        "exit_status": result.exit_status, "timed_out": result.timed_out,
                        "truncated": result.truncated, "error": result.error.unwrap_or_default(),
                    }));
                }
                Err(error) => {
                    results.push(serde_json::json!({"host":host.name,"output":"","error":error}))
                }
            }
            continue;
        }
        let handle = st.sessions.get_or_create(sid, host_info).await;
        match st.sessions.connect(&handle).await {
            Ok(()) => {
                // Subscribe before writing so even an immediate remote exit is observed.
                let (history, mut rx) = handle.read().await.subscribe();
                let command = format!("{rendered}\nexit\n");
                let mut error = st.sessions.write(&handle, command.as_bytes()).await.err();
                let mut output = Vec::new();
                let mut truncated = false;
                for chunk in history {
                    if !append_bounded_output(&mut output, &chunk) {
                        truncated = true;
                        break;
                    }
                }
                let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
                while !truncated && error.is_none() {
                    match tokio::time::timeout_at(deadline, rx.recv()).await {
                        Ok(Ok(SessionEvent::Data(data))) => {
                            truncated = !append_bounded_output(&mut output, &data)
                        }
                        Ok(Ok(SessionEvent::Ended(_)))
                        | Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                            error = Some(
                                "Command output was lost because the receiver fell behind".into(),
                            )
                        }
                        Err(_) => error = Some("Remote command timed out".into()),
                    }
                }
                st.sessions.cleanup(sid).await;
                let mut output = String::from_utf8_lossy(&output).into_owned();
                if truncated {
                    output.push_str(OUTPUT_TRUNCATED_MARKER);
                    error = Some("Command output exceeded 1 MiB".into());
                }
                results.push(serde_json::json!({"host":host.name,"output":output,"error":error.unwrap_or_default(),"exit_status":null,"truncated":truncated}));
            }
            Err(error) => {
                st.sessions.cleanup(sid).await;
                results.push(serde_json::json!({"host":host.name,"output":"","error":error}));
            }
        }
    }

    Ok(Json(results))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snippet_output_is_capped_without_growing_past_limit() {
        let mut output = vec![b'a'; MAX_SNIPPET_OUTPUT_BYTES - 2];
        assert!(!append_bounded_output(&mut output, b"bcdef"));
        assert_eq!(output.len(), MAX_SNIPPET_OUTPUT_BYTES);
        assert_eq!(&output[MAX_SNIPPET_OUTPUT_BYTES - 2..], b"bc");
        assert!(!append_bounded_output(&mut output, b"more"));
        assert_eq!(output.len(), MAX_SNIPPET_OUTPUT_BYTES);
    }
}
