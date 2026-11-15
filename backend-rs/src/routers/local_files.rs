//! Explicit read-only local browsing. All routes require the sidecar token.
use crate::{
    auth::AppState,
    error::{AppError, AppResult},
};
use axum::{body::Body, extract::Query, routing::get, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
const MAX_FILE: u64 = 128 * 1024 * 1024;
#[derive(Deserialize)]
struct Location {
    path: Option<String>,
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/local-files", get(list))
        .route("/local-files/content", get(content))
}
async fn resolve(path: Option<String>) -> AppResult<std::path::PathBuf> {
    let path = path
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(std::path::PathBuf::from)
        })
        .ok_or_else(|| AppError::BadRequest("Local path is required".into()))?;
    tokio::fs::canonicalize(path)
        .await
        .map_err(|_| AppError::BadRequest("Local path is unavailable or access was denied".into()))
}
async fn list(Query(query): Query<Location>) -> AppResult<Json<Value>> {
    let path = resolve(query.path).await?;
    let mut dir = tokio::fs::read_dir(&path)
        .await
        .map_err(|_| AppError::BadRequest("Cannot open this local directory".into()))?;
    let mut entries = Vec::new();
    let mut truncated = false;
    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|_| AppError::BadRequest("Cannot read this directory".into()))?
    {
        if entries.len() >= 10_000 {
            truncated = true;
            break;
        }
        if let Ok(metadata) = entry.metadata().await {
            entries.push(json!({"name":entry.file_name().to_string_lossy(),"path":entry.path().to_string_lossy(),"is_directory":metadata.is_dir(),"size":metadata.len()}));
        }
    }
    entries.sort_by(|a, b| {
        b["is_directory"]
            .as_bool()
            .cmp(&a["is_directory"].as_bool())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(Json(
        json!({"path":path.to_string_lossy(),"parent":path.parent().map(|p|p.to_string_lossy()),"entries":entries,"truncated":truncated}),
    ))
}
async fn content(Query(query): Query<Location>) -> AppResult<Body> {
    let path = resolve(query.path).await?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| AppError::BadRequest("Cannot read local file".into()))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| AppError::BadRequest("Cannot inspect local file".into()))?;
    if !metadata.is_file() || metadata.len() > MAX_FILE {
        return Err(AppError::BadRequest(
            "Choose a regular file up to 128 MiB".into(),
        ));
    }
    let stream = futures::stream::try_unfold(file.take(MAX_FILE), |mut file| async move {
        let mut chunk = vec![0; 64 * 1024];
        let size = file.read(&mut chunk).await?;
        if size == 0 {
            Ok::<_, std::io::Error>(None)
        } else {
            chunk.truncate(size);
            Ok(Some((chunk, file)))
        }
    });
    Ok(Body::from_stream(stream))
}
