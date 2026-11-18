use crate::ssh::sftp_transfers::{CancelOnDrop, Transfer, WorkerGuard};
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::Request;
use axum::http::StatusCode;
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures::TryStreamExt;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::io::StreamReader;

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::{Host, HostCapabilityOut, HostCapabilityRow, SftpEntryOut, SftpListOut};
use crate::ssh::saved_host;
use crate::ssh::sftp::{SftpProbeError, SftpProbeStatus, SftpProbeTarget};

const SFTP_CAPABILITY: &str = "sftp";
const MAX_SFTP_DOWNLOAD_BYTES: usize = 128 * 1024 * 1024;
const MAX_SFTP_PREVIEW_BYTES: usize = 2 * 1024 * 1024;
const MAX_SFTP_UPLOAD_BYTES: usize = 128 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/sftp/hosts/{host_id}/capability", get(get_capability))
        .route("/sftp/hosts/{host_id}/probe", post(probe_capability))
        .route("/sftp/hosts/{host_id}/list", get(list_directory))
        .route("/sftp/hosts/{host_id}/download", get(download_file))
        .route("/sftp/hosts/{host_id}/upload", post(upload_file))
        .route("/sftp/transfers", get(list_transfers))
        .route("/sftp/transfers/{id}", get(get_transfer))
        .route("/sftp/transfers/{id}/cancel", post(cancel_transfer))
        .route("/sftp/hosts/{host_id}/transfers", post(create_transfer))
        .route("/sftp/hosts/{host_id}/operations", post(mutate_file))
        .route("/sftp/hosts/{host_id}/disconnect", post(disconnect))
}

#[derive(Debug, Deserialize)]
struct SftpListQuery {
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SftpFileQuery {
    path: Option<String>,
    max_bytes: Option<usize>,
    #[serde(default)]
    truncate: bool,
    transfer_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SftpUploadQuery {
    path: Option<String>,
    transfer_id: Option<String>,
}

async fn get_host(st: &AppState, host_id: i64) -> AppResult<Host> {
    sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
        .bind(host_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Host not found".into()))
}

fn is_ssh_host(host: &Host) -> bool {
    host.connection_type.eq_ignore_ascii_case("ssh")
}

async fn cached_capability(
    st: &AppState,
    host_id: i64,
    can_probe: bool,
) -> AppResult<HostCapabilityOut> {
    let row = sqlx::query_as::<_, HostCapabilityRow>(
        r#"SELECT * FROM host_capabilities
           WHERE host_id = ?
             AND capability = ?
             AND (expires_at IS NULL OR expires_at > datetime('now'))"#,
    )
    .bind(host_id)
    .bind(SFTP_CAPABILITY)
    .fetch_optional(&st.db)
    .await?;

    Ok(row
        .map(|row| HostCapabilityOut::from_row(row, can_probe))
        .unwrap_or_else(|| HostCapabilityOut::unknown(host_id, SFTP_CAPABILITY, can_probe)))
}

async fn save_capability(
    st: &AppState,
    host_id: i64,
    status: &str,
    reason: Option<&str>,
) -> AppResult<HostCapabilityOut> {
    sqlx::query(
        r#"INSERT INTO host_capabilities
            (host_id, capability, status, reason, checked_at, expires_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now', '+12 hours'))
           ON CONFLICT(host_id, capability) DO UPDATE SET
             status = excluded.status,
             reason = excluded.reason,
             checked_at = excluded.checked_at,
             expires_at = excluded.expires_at"#,
    )
    .bind(host_id)
    .bind(SFTP_CAPABILITY)
    .bind(status)
    .bind(reason)
    .execute(&st.db)
    .await?;

    cached_capability(st, host_id, true).await
}

async fn get_capability(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
) -> AppResult<Json<HostCapabilityOut>> {
    let host = get_host(&st, host_id).await?;
    if !is_ssh_host(&host) {
        return Ok(Json(HostCapabilityOut::unsupported(
            host_id,
            SFTP_CAPABILITY,
            "SFTP is available only for SSH hosts",
        )));
    }

    saved_host::validate_route(&host)?;
    Ok(Json(cached_capability(&st, host_id, true).await?))
}

async fn probe_capability(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
) -> AppResult<Json<HostCapabilityOut>> {
    let host = get_host(&st, host_id).await?;
    if !is_ssh_host(&host) {
        return Ok(Json(HostCapabilityOut::unsupported(
            host_id,
            SFTP_CAPABILITY,
            "SFTP is available only for SSH hosts",
        )));
    }
    let (password, private_key, passphrase) = match load_host_credentials(&st, &host).await {
        Ok(credentials) => credentials,
        Err(AppError::Unauthorized(message)) => {
            let capability = save_capability(&st, host_id, "auth_failed", Some(&message)).await?;
            return Ok(Json(capability));
        }
        Err(error) => return Err(error),
    };

    let target = SftpProbeTarget {
        host_id,
        hostname: host.hostname.clone(),
        port: host.port as u16,
        username: host.username.clone().unwrap_or_default(),
        password,
        private_key,
        passphrase,
        connect_timeout_secs: 20,
    };

    let capability = match st.sftp.probe(target).await {
        Ok(SftpProbeStatus::Supported) => save_capability(&st, host_id, "supported", None).await?,
        Ok(SftpProbeStatus::Unsupported(reason)) => {
            save_capability(&st, host_id, "unsupported", Some(&reason)).await?
        }
        Err(SftpProbeError::AuthFailed) => {
            save_capability(&st, host_id, "auth_failed", Some("Authentication failed")).await?
        }
        Err(SftpProbeError::HostKeyMismatch) => {
            save_capability(
                &st,
                host_id,
                "error",
                Some("SSH host key mismatch detected"),
            )
            .await?
        }
        Err(SftpProbeError::Unsupported(reason)) => {
            save_capability(&st, host_id, "unsupported", Some(&reason)).await?
        }
        Err(SftpProbeError::Connect(error)) | Err(SftpProbeError::Probe(error)) => {
            save_capability(&st, host_id, "error", Some(&error)).await?
        }
    };

    Ok(Json(capability))
}

async fn list_directory(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
    Query(q): Query<SftpListQuery>,
) -> AppResult<Json<SftpListOut>> {
    let host = get_host(&st, host_id).await?;
    if !is_ssh_host(&host) {
        return Err(AppError::BadRequest(
            "SFTP is available only for SSH hosts".into(),
        ));
    }
    let (password, private_key, passphrase) =
        load_host_credentials_or_mark_auth_failed(&st, host_id, &host).await?;

    let requested_path = normalize_sftp_path(q.path)?;
    let target = SftpProbeTarget {
        host_id,
        hostname: host.hostname.clone(),
        port: host.port as u16,
        username: host.username.clone().unwrap_or_default(),
        password,
        private_key,
        passphrase,
        connect_timeout_secs: 20,
    };

    match st.sftp.list_dir(target, &requested_path).await {
        Ok(listing) => {
            save_capability(&st, host_id, "supported", None).await?;
            Ok(Json(SftpListOut {
                host_id,
                path: listing.path,
                entries: listing
                    .entries
                    .into_iter()
                    .map(|entry| SftpEntryOut {
                        name: entry.name,
                        path: entry.path,
                        entry_type: entry.entry_type,
                        size: entry.size,
                        modified_at: entry.modified_at,
                        permissions: entry.permissions,
                    })
                    .collect(),
            }))
        }
        Err(SftpProbeError::AuthFailed) => {
            save_capability(&st, host_id, "auth_failed", Some("Authentication failed")).await?;
            Err(AppError::Unauthorized(
                "SFTP authentication failed. Check credentials or unlock the vault.".into(),
            ))
        }
        Err(SftpProbeError::HostKeyMismatch) => {
            save_capability(
                &st,
                host_id,
                "error",
                Some("SSH host key mismatch detected"),
            )
            .await?;
            Err(AppError::Conflict(
                "SSH host key mismatch detected. Remove the stale known-host entry and retry."
                    .into(),
            ))
        }
        Err(SftpProbeError::Unsupported(reason)) => {
            save_capability(&st, host_id, "unsupported", Some(&reason)).await?;
            Err(AppError::Conflict(reason))
        }
        Err(SftpProbeError::Connect(error)) | Err(SftpProbeError::Probe(error)) => {
            save_capability(&st, host_id, "error", Some(&error)).await?;
            Err(AppError::BadRequest(format!("SFTP list failed: {error}")))
        }
    }
}

fn normalize_sftp_path(path: Option<String>) -> AppResult<String> {
    let path = path.unwrap_or_else(|| ".".into());
    if path.is_empty() {
        return Ok(".".into());
    }
    if path.len() > 4096 || path.contains('\0') {
        return Err(AppError::BadRequest("Invalid SFTP path".into()));
    }
    Ok(path)
}

fn normalize_required_sftp_path(path: Option<String>) -> AppResult<String> {
    let normalized = normalize_sftp_path(path)?;
    if normalized == "." || normalized == "/" || normalized.ends_with('/') {
        return Err(AppError::BadRequest(
            "SFTP upload path must include a file name".into(),
        ));
    }
    Ok(normalized)
}

async fn target_for(st: &AppState, host_id: i64) -> AppResult<SftpProbeTarget> {
    let host = get_host(st, host_id).await?;
    if !is_ssh_host(&host) {
        return Err(AppError::BadRequest(
            "SFTP is available only for SSH hosts".into(),
        ));
    }
    let (password, private_key, passphrase) =
        load_host_credentials_or_mark_auth_failed(st, host_id, &host).await?;
    Ok(SftpProbeTarget {
        host_id,
        hostname: host.hostname.clone(),
        port: host.port as u16,
        username: host.username.clone().unwrap_or_default(),
        password,
        private_key,
        passphrase,
        connect_timeout_secs: 20,
    })
}

async fn transfer_error(st: &AppState, host_id: i64, error: SftpProbeError) -> AppError {
    let (status, reason) = match &error {
        SftpProbeError::AuthFailed => ("auth_failed", "Authentication failed".into()),
        SftpProbeError::HostKeyMismatch => ("error", "SSH host key mismatch detected".into()),
        SftpProbeError::Unsupported(reason) => ("unsupported", reason.clone()),
        _ => ("error", error.to_string()),
    };
    let _ = save_capability(st, host_id, status, Some(&reason)).await;
    match error {
        SftpProbeError::AuthFailed => AppError::Unauthorized("SFTP authentication failed. Check credentials or unlock the vault.".into()),
        SftpProbeError::HostKeyMismatch => AppError::Conflict("SSH host key mismatch detected. Verify the server identity before replacing the known-host entry.".into()),
        SftpProbeError::Unsupported(reason) => AppError::Conflict(reason),
        other => AppError::BadRequest(other.to_string()),
    }
}

fn workspace_lease(st: &AppState) -> AppResult<tokio::sync::OwnedRwLockReadGuard<()>> {
    st.sessions
        .workspace_gate()
        .try_read_owned()
        .map_err(|_| AppError::Conflict("Workspace restore is in progress".into()))
}

fn claim_transfer(
    st: &AppState,
    id: Option<String>,
    host_id: i64,
    kind: &str,
    path: &str,
    total: Option<u64>,
) -> AppResult<Transfer> {
    let id = match id {
        Some(id) => id,
        None => {
            st.sftp
                .transfers
                .create(host_id, kind, path.into(), total, false)
                .map_err(AppError::RateLimited)?
                .info()
                .id
        }
    };
    st.sftp
        .transfers
        .claim(&id, host_id, kind, path)
        .map_err(AppError::Conflict)
}

async fn download_file(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
    Query(q): Query<SftpFileQuery>,
) -> AppResult<Response> {
    let target = target_for(&st, host_id).await?;
    let path = normalize_sftp_path(q.path)?;
    let max_allowed = if q.truncate {
        MAX_SFTP_PREVIEW_BYTES
    } else {
        MAX_SFTP_DOWNLOAD_BYTES
    };
    let max_bytes = q.max_bytes.unwrap_or(max_allowed).min(max_allowed);
    if max_bytes == 0 {
        return Err(AppError::BadRequest("Invalid SFTP read limit".into()));
    }
    if q.truncate {
        let file = match st.sftp.read_file(target, &path, max_bytes, true).await {
            Ok(file) => file,
            Err(error) => return Err(transfer_error(&st, host_id, error).await),
        };
        let mut response = file.data.into_response();
        file_headers(&mut response, &file.path, &file.filename);
        response.headers_mut().insert(
            "x-netrix-truncated",
            HeaderValue::from_static(if file.truncated { "true" } else { "false" }),
        );
        return Ok(response);
    }
    let lease = workspace_lease(&st)?;
    let job = claim_transfer(&st, q.transfer_id, host_id, "download", &path, None)?;
    let id = job.info().id;
    let (output, receiver) = mpsc::channel(4);
    let remote_path = path.clone();
    st.sftp.clone().spawn_transfer(async move {
        let _lease = lease;
        let _guard = WorkerGuard(job.clone());
        let result = st
            .sftp
            .download_stream(target, &remote_path, &job, max_bytes, output.clone())
            .await;
        match result {
            Ok(()) => {
                job.finish(Ok(()));
                let _ = save_capability(&st, host_id, "supported", None).await;
            }
            Err(error) => {
                let detail = error.to_string();
                job.finish(Err(detail.clone()));
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    output.send(Err(std::io::Error::other(detail))),
                )
                .await;
                if !job.cancel.is_cancelled() {
                    let _ = transfer_error(&st, host_id, error).await;
                }
            }
        }
    });
    let stream = futures::stream::unfold(receiver, |mut receiver| async {
        receiver.recv().await.map(|chunk| (chunk, receiver))
    });
    let mut response = Body::from_stream(stream).into_response();
    file_headers(
        &mut response,
        &path,
        path.rsplit('/').next().unwrap_or("download"),
    );
    if let Ok(value) = HeaderValue::from_str(&id) {
        response.headers_mut().insert("x-netrix-transfer-id", value);
    }
    Ok(response)
}

fn file_headers(response: &mut Response, path: &str, filename: &str) {
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        content_disposition_header(filename),
    );
    if let Ok(value) = HeaderValue::from_str(path) {
        response.headers_mut().insert("x-netrix-sftp-path", value);
    }
}

async fn upload_file(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
    Query(q): Query<SftpUploadQuery>,
    request: Request<Body>,
) -> AppResult<Json<serde_json::Value>> {
    let target = target_for(&st, host_id).await?;
    let path = normalize_required_sftp_path(q.path)?;
    validate_mutation_path(&path)?;
    let content_length = request
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if content_length.is_some_and(|size| size > MAX_SFTP_UPLOAD_BYTES as u64) {
        return Err(AppError::BadRequest(format!(
            "SFTP upload is limited to {MAX_SFTP_UPLOAD_BYTES} bytes"
        )));
    }
    let lease = workspace_lease(&st)?;
    let job = claim_transfer(&st, q.transfer_id, host_id, "upload", &path, content_length)?;
    if let (Some(actual), Some(declared)) = (content_length, job.info().bytes_total) {
        if actual != declared {
            job.finish(Err(
                "Upload size does not match the transfer declaration".into()
            ));
            return Err(AppError::BadRequest(
                "Upload size does not match the transfer declaration".into(),
            ));
        }
    }
    if job.info().bytes_total.is_none() {
        job.total(content_length);
    }
    let _cancel_on_disconnect = CancelOnDrop(job.clone());
    let reader = StreamReader::new(
        request
            .into_body()
            .into_data_stream()
            .map_err(std::io::Error::other),
    );
    let task = st.sftp.clone().spawn_transfer(async move {
        let _lease = lease;
        let _guard = WorkerGuard(job.clone());
        let result = st
            .sftp
            .upload_stream(target, reader, &job, MAX_SFTP_UPLOAD_BYTES)
            .await;
        match result {
            Ok(uploaded) => {
                job.finish(Ok(()));
                // A cache write must not turn a successful remote commit into a failed transfer.
                let _ = save_capability(&st, host_id, "supported", None).await;
                Ok(Json(
                    json!({ "host_id":host_id, "path":uploaded.path, "size":uploaded.size, "transfer_id":job.info().id }),
                ))
            }
            Err(error) => {
                job.finish(Err(error.to_string()));
                Err(transfer_error(&st, host_id, error).await)
            }
        }
    });
    task.await
        .map_err(|_| AppError::Internal("SFTP transfer worker stopped".into()))?
}

#[derive(Deserialize)]
struct NewTransfer {
    kind: String,
    path: String,
    bytes_total: Option<u64>,
    #[serde(default)]
    overwrite: bool,
    confirmation: Option<String>,
}

async fn create_transfer(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
    Json(body): Json<NewTransfer>,
) -> AppResult<impl IntoResponse> {
    let host = get_host(&st, host_id).await?;
    if !is_ssh_host(&host) {
        return Err(AppError::BadRequest(
            "SFTP is available only for SSH hosts".into(),
        ));
    }
    if !matches!(body.kind.as_str(), "upload" | "download") {
        return Err(AppError::BadRequest(
            "Transfer kind must be upload or download".into(),
        ));
    }
    validate_mutation_path(&body.path)?;
    if body
        .bytes_total
        .is_some_and(|size| size > MAX_SFTP_UPLOAD_BYTES as u64)
    {
        return Err(AppError::BadRequest(
            "Transfer exceeds the 128 MiB limit".into(),
        ));
    }
    if body.overwrite
        && (body.kind != "upload" || body.confirmation.as_deref() != Some("OVERWRITE"))
    {
        return Err(AppError::BadRequest(
            "Explicit OVERWRITE confirmation is required".into(),
        ));
    }
    let job = st
        .sftp
        .transfers
        .create(
            host_id,
            &body.kind,
            body.path,
            body.bytes_total,
            body.overwrite,
        )
        .map_err(AppError::RateLimited)?;
    Ok((StatusCode::CREATED, Json(job.info())))
}

async fn get_transfer(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<crate::ssh::sftp_transfers::TransferInfo>> {
    st.sftp
        .transfers
        .get(&id)
        .map(|job| Json(job.info()))
        .ok_or_else(|| AppError::NotFound("Transfer not found".into()))
}

async fn cancel_transfer(
    State(st): State<AppState>,
    Path(id): Path<String>,
) -> AppResult<Json<crate::ssh::sftp_transfers::TransferInfo>> {
    let job = st
        .sftp
        .transfers
        .get(&id)
        .ok_or_else(|| AppError::NotFound("Transfer not found".into()))?;
    job.request_cancel().map_err(AppError::Conflict)?;
    Ok(Json(job.info()))
}

fn validate_mutation_path(path: &str) -> AppResult<()> {
    let last = path.rsplit('/').next().unwrap_or_default();
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || matches!(last, "" | "." | "..")
    {
        return Err(AppError::BadRequest(
            "Invalid SFTP file or folder path".into(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct FileOperation {
    action: String,
    path: String,
    destination: Option<String>,
    permissions: Option<String>,
    confirmation: Option<String>,
}

async fn mutate_file(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
    Json(body): Json<FileOperation>,
) -> AppResult<StatusCode> {
    validate_mutation_path(&body.path)?;
    let mode = match body.action.as_str() {
        "mkdir" => None,
        "rename" => {
            validate_mutation_path(body.destination.as_deref().unwrap_or_default())?;
            None
        }
        "delete" => {
            if body.confirmation.as_deref() != Some(body.path.as_str()) {
                return Err(AppError::BadRequest(
                    "Confirm deletion by supplying the exact path".into(),
                ));
            }
            None
        }
        "chmod" => {
            let mode = body
                .permissions
                .as_deref()
                .filter(|mode| {
                    mode.len() == 3 && mode.bytes().all(|byte| (b'0'..=b'7').contains(&byte))
                })
                .and_then(|mode| u32::from_str_radix(mode, 8).ok())
                .ok_or_else(|| {
                    AppError::BadRequest(
                        "Permissions must be three octal digits, for example 644".into(),
                    )
                })?;
            Some(mode)
        }
        _ => return Err(AppError::BadRequest("Unknown SFTP operation".into())),
    };
    let target = target_for(&st, host_id).await?;
    if let Err(error) = st
        .sftp
        .mutate(
            target,
            &body.action,
            &body.path,
            body.destination.as_deref(),
            mode,
        )
        .await
    {
        return Err(transfer_error(&st, host_id, error).await);
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn disconnect(State(st): State<AppState>, Path(host_id): Path<i64>) -> StatusCode {
    st.sftp.transfers.cancel_host(host_id);
    st.sftp.disconnect_host(host_id).await;
    StatusCode::NO_CONTENT
}

fn content_disposition_header(filename: &str) -> HeaderValue {
    let safe = filename
        .chars()
        .map(|ch| match ch {
            '\r' | '\n' | '"' | '\\' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();

    HeaderValue::from_str(&format!("attachment; filename=\"{safe}\""))
        .unwrap_or_else(|_| HeaderValue::from_static("attachment; filename=\"download\""))
}

async fn list_transfers(State(st): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({ "transfers": st.sftp.transfers.list() }))
}

async fn load_host_credentials(
    st: &AppState,
    host: &Host,
) -> AppResult<(Option<String>, Option<String>, Option<String>)> {
    let mut credentials = saved_host::load_credentials(st, host).await?;
    Ok((
        credentials.password.take(),
        credentials.private_key.take(),
        credentials.passphrase.take(),
    ))
}

async fn load_host_credentials_or_mark_auth_failed(
    st: &AppState,
    host_id: i64,
    host: &Host,
) -> AppResult<(Option<String>, Option<String>, Option<String>)> {
    match load_host_credentials(st, host).await {
        Ok(credentials) => Ok(credentials),
        Err(AppError::Unauthorized(message)) => {
            save_capability(st, host_id, "auth_failed", Some(&message)).await?;
            Err(AppError::Unauthorized(message))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_sftp_path_preserves_names_and_rejects_invalid_values() {
        assert_eq!(normalize_sftp_path(None).unwrap(), ".");
        assert_eq!(normalize_sftp_path(Some("   ".into())).unwrap(), "   ");
        assert_eq!(
            normalize_sftp_path(Some(" /var/log ".into())).unwrap(),
            " /var/log "
        );

        assert!(matches!(
            normalize_sftp_path(Some("bad\0path".into())),
            Err(AppError::BadRequest(message)) if message == "Invalid SFTP path"
        ));
        assert!(matches!(
            normalize_sftp_path(Some("a".repeat(4097))),
            Err(AppError::BadRequest(message)) if message == "Invalid SFTP path"
        ));
    }

    #[test]
    fn normalize_required_sftp_path_requires_file_name() {
        for path in [
            None,
            Some(".".into()),
            Some("/".into()),
            Some("/tmp/".into()),
        ] {
            assert!(matches!(
                normalize_required_sftp_path(path),
                Err(AppError::BadRequest(message))
                    if message == "SFTP upload path must include a file name"
            ));
        }

        assert_eq!(
            normalize_required_sftp_path(Some(" /tmp/file.txt ".into())).unwrap(),
            " /tmp/file.txt "
        );
    }

    #[test]
    fn content_disposition_header_sanitizes_filename() {
        let header = content_disposition_header("bad\r\n\"name\\.txt");
        let value = header.to_str().unwrap();

        assert_eq!(value, "attachment; filename=\"bad___name_.txt\"");
        assert!(!value.contains('\r'));
        assert!(!value.contains('\n'));
    }
}
