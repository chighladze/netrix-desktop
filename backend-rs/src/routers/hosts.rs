/// Host CRUD endpoints.
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use sqlx::{FromRow, Row};

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::*;
use crate::vault;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/hosts", get(list_hosts).post(create_host))
        .route("/host-groups/move", post(move_group))
        .route(
            "/hosts/{host_id}",
            get(get_host)
                .put(update_host)
                .patch(patch_host)
                .delete(delete_host),
        )
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct GroupHostRevision {
    id: i64,
    revision: i64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MoveGroup {
    source: String,
    destination: String,
    hosts: Vec<GroupHostRevision>,
}

/// Rename or reparent a complete subtree in one transaction. Empty folders are
/// frontend preferences, but still pass through the destination collision check.
async fn move_group(
    State(st): State<AppState>,
    Json(body): Json<MoveGroup>,
) -> AppResult<Json<Vec<HostOut>>> {
    let source = canonical_group(Some(&body.source))?
        .ok_or_else(|| AppError::BadRequest("Choose a source folder".into()))?;
    let destination = canonical_group(Some(&body.destination))?
        .ok_or_else(|| AppError::BadRequest("Choose a destination folder".into()))?;
    let contains = |path: &str, root: &str| path == root || path.starts_with(&format!("{root}/"));
    if contains(&destination, &source) {
        return Err(AppError::BadRequest(
            "A folder cannot be moved into itself".into(),
        ));
    }
    if contains(&source, &destination) {
        return Err(AppError::Conflict(
            "A folder already exists at the destination".into(),
        ));
    }
    let expected: std::collections::BTreeMap<_, _> =
        body.hosts.iter().map(|h| (h.id, h.revision)).collect();
    if expected.len() != body.hosts.len() || body.hosts.iter().any(|h| h.id < 1 || h.revision < 0) {
        return Err(AppError::BadRequest("Invalid folder host revisions".into()));
    }
    let mut tx = st.db.begin_with("BEGIN IMMEDIATE").await?;
    let rows: Vec<(i64, i64, Option<String>)> =
        sqlx::query_as("SELECT id, revision, \"group\" FROM hosts")
            .fetch_all(&mut *tx)
            .await?;
    let mut changes = Vec::new();
    let mut actual = std::collections::BTreeMap::new();
    for (id, revision, group) in rows {
        let Some(group) = canonical_group(group.as_deref())? else {
            continue;
        };
        if contains(&group, &source) {
            let moved = format!("{destination}{}", &group[source.len()..]);
            canonical_group(Some(&moved))?;
            actual.insert(id, revision);
            changes.push((id, moved));
        } else if contains(&group, &destination) {
            return Err(AppError::Conflict(
                "A folder already exists at the destination".into(),
            ));
        }
    }
    if actual != expected {
        return Err(AppError::Conflict(
            "This folder changed. Refresh Hosts and try again".into(),
        ));
    }
    let mut updated = Vec::with_capacity(changes.len());
    for (id, group) in changes {
        sqlx::query("UPDATE hosts SET \"group\" = ? WHERE id = ?")
            .bind(group)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        updated.push(load_output(&mut tx, id).await?);
    }
    tx.commit().await?;
    Ok(Json(updated))
}

// ─── Input validation ───────────────────────────────────────────────

pub(crate) fn validate_host(body: &HostCreate) -> Result<(), AppError> {
    if let Some(appearance) = &body.terminal_appearance {
        appearance.validate()?;
    }
    if body.name.trim().is_empty() {
        return Err(AppError::BadRequest("Host name is required".into()));
    }
    if body.name.len() > 255 {
        return Err(AppError::BadRequest(
            "Host name too long (max 255 chars)".into(),
        ));
    }
    if body.hostname.trim().is_empty() {
        return Err(AppError::BadRequest("Hostname is required".into()));
    }
    if body.hostname.len() > 253 {
        return Err(AppError::BadRequest(
            "Hostname too long (max 253 chars)".into(),
        ));
    }
    let valid_types = ["ssh", "telnet", "serial", "local"];
    if !valid_types.contains(&body.connection_type.as_str()) {
        return Err(AppError::BadRequest(format!(
            "Invalid connection_type '{}'. Must be one of: {}",
            body.connection_type,
            valid_types.join(", ")
        )));
    }
    if body.connection_type == "serial" {
        if body
            .serial_port
            .as_ref()
            .map(|s| s.is_empty())
            .unwrap_or(true)
        {
            return Err(AppError::BadRequest(
                "serial_port is required for serial connections".into(),
            ));
        }
        if body.port < 0 || body.port > 65535 {
            return Err(AppError::BadRequest(
                "Port must be between 0 and 65535 for serial connections".into(),
            ));
        }
    } else if body.connection_type == "local" {
        // Local shells live on the user's machine; port is meaningless.
        if body.port < 0 || body.port > 65535 {
            return Err(AppError::BadRequest(
                "Port must be between 0 and 65535".into(),
            ));
        }
        if let Some(ref cmd) = body.local_command {
            if cmd.contains('\0') {
                return Err(AppError::BadRequest(
                    "local_command contains a NUL byte".into(),
                ));
            }
            if cmd.split(['/', '\\']).any(|seg| seg == "..") {
                return Err(AppError::BadRequest(
                    "local_command must not contain '..' path traversal".into(),
                ));
            }
        }
        if let Some(ref args) = body.local_args {
            for a in args {
                if a.contains('\0') {
                    return Err(AppError::BadRequest("local_args contain a NUL byte".into()));
                }
            }
        }
    } else if body.port < 1 || body.port > 65535 {
        return Err(AppError::BadRequest(
            "Port must be between 1 and 65535".into(),
        ));
    }
    if body
        .terminal_font_size
        .is_some_and(|size| !(6..=72).contains(&size))
    {
        return Err(AppError::BadRequest(
            "Terminal font size must be between 6 and 72".into(),
        ));
    }
    for (field, color) in [
        ("terminal_background", body.terminal_background.as_deref()),
        ("terminal_foreground", body.terminal_foreground.as_deref()),
    ] {
        if color.is_some_and(|color| {
            color.len() != 7
                || !color.starts_with('#')
                || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        }) {
            return Err(AppError::BadRequest(format!(
                "{field} must be a #RRGGBB color or null"
            )));
        }
    }
    if body.name.chars().any(char::is_control)
        || body.hostname.chars().any(char::is_control)
        || body
            .username
            .as_ref()
            .is_some_and(|s| s.chars().any(char::is_control))
    {
        return Err(AppError::BadRequest(
            "Host fields contain control characters".into(),
        ));
    }
    if let Some(ref group) = body.group {
        if group.chars().count() > 100 {
            return Err(AppError::BadRequest(
                "Group name too long (max 100 chars)".into(),
            ));
        }
    }
    if body.clear_credentials.unwrap_or(false)
        && (body.password.is_some() || body.private_key.is_some() || body.passphrase.is_some())
    {
        return Err(AppError::BadRequest(
            "clear_credentials cannot be combined with new credentials".into(),
        ));
    }
    if body
        .passphrase
        .as_ref()
        .map(|s| !s.is_empty())
        .unwrap_or(false)
        && body
            .private_key
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
    {
        return Err(AppError::BadRequest(
            "Passphrase requires a private key".into(),
        ));
    }
    // Prevent injection in hostname.
    if body.connection_type != "local" && body.hostname.contains([';', '|', '&', '$', '`', '\n']) {
        return Err(AppError::BadRequest(
            "Hostname contains invalid characters".into(),
        ));
    }
    Ok(())
}

pub(crate) async fn cleanup_orphan_credential(
    connection: &mut sqlx::SqliteConnection,
    credential_id: i64,
) -> AppResult<()> {
    let meta: Option<(Option<String>,)> =
        sqlx::query_as("SELECT item_metadata FROM vault_items WHERE id=?")
            .bind(credential_id)
            .fetch_optional(&mut *connection)
            .await?;
    if meta
        .and_then(|row| row.0)
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .is_some_and(|value| value["managed"] == true)
    {
        return Ok(());
    }
    let refs = sqlx::query_as::<_, (i64,)>("SELECT COUNT(*) FROM hosts WHERE credential_id = ?")
        .bind(credential_id)
        .fetch_one(&mut *connection)
        .await?
        .0;
    if refs == 0 {
        sqlx::query("DELETE FROM vault_items WHERE id = ?")
            .bind(credential_id)
            .execute(&mut *connection)
            .await?;
    }
    Ok(())
}

// ─── Handlers ───────────────────────────────────────────────────────

const SELECT_HOST: &str = "SELECT h.*, v.item_metadata AS credential_metadata FROM hosts h LEFT JOIN vault_items v ON v.id=h.credential_id";
fn output_host(row: &sqlx::sqlite::SqliteRow) -> AppResult<HostOut> {
    let host = Host::from_row(row)?;
    let mut out = HostOut::from_row(&host);
    let metadata: Option<String> = row.try_get("credential_metadata")?;
    if let Some(meta) = metadata.and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) {
        out.has_password |= meta["has_password"].as_bool().unwrap_or(false);
        out.has_private_key |= meta["has_private_key"].as_bool().unwrap_or(false);
    }
    // Old rows may predate canonical group paths. Normalize at the DTO boundary too.
    out.group = out
        .group
        .map(|group| {
            group
                .split('/')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        })
        .filter(|s| !s.is_empty());
    Ok(out)
}
async fn load_output(connection: &mut sqlx::SqliteConnection, id: i64) -> AppResult<HostOut> {
    let row = sqlx::query(&format!("{SELECT_HOST} WHERE h.id=?"))
        .bind(id)
        .fetch_optional(connection)
        .await?
        .ok_or_else(|| AppError::NotFound("Host not found".into()))?;
    output_host(&row)
}
async fn list_hosts(State(st): State<AppState>) -> AppResult<Json<Vec<HostOut>>> {
    let rows = sqlx::query(&format!(
        "{SELECT_HOST} ORDER BY h.name COLLATE NOCASE, h.id"
    ))
    .fetch_all(&st.db)
    .await?;
    Ok(Json(
        rows.iter().map(output_host).collect::<AppResult<_>>()?,
    ))
}
async fn get_host(State(st): State<AppState>, Path(id): Path<i64>) -> AppResult<Json<HostOut>> {
    Ok(Json(load_output(&mut *st.db.acquire().await?, id).await?))
}

pub(crate) fn canonical_group(group: Option<&str>) -> AppResult<Option<String>> {
    let Some(group) = group else { return Ok(None) };
    let parts: Vec<_> = group
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if parts.is_empty() {
        return Ok(None);
    }
    let normalized = parts.join("/");
    if normalized.chars().count() > 100
        || parts.len() > 16
        || parts
            .iter()
            .any(|s| *s == "." || *s == ".." || s.chars().any(char::is_control))
    {
        return Err(AppError::BadRequest("Invalid group path (max 100 characters and 16 levels; no control characters, '.' or '..')".into()));
    }
    Ok(Some(normalized))
}
async fn validate_jump(
    connection: &mut sqlx::SqliteConnection,
    id: Option<i64>,
    jump: Option<i64>,
) -> AppResult<()> {
    let mut next = jump;
    let mut visited = std::collections::HashSet::new();
    while let Some(current) = next {
        if Some(current) == id || !visited.insert(current) || visited.len() > 16 {
            return Err(AppError::BadRequest(
                "Jump host chain contains a cycle or exceeds 16 hosts".into(),
            ));
        }
        let row: Option<(String, Option<i64>)> =
            sqlx::query_as("SELECT connection_type,jump_host_id FROM hosts WHERE id=?")
                .bind(current)
                .fetch_optional(&mut *connection)
                .await?;
        let Some((kind, parent)) = row else {
            return Err(AppError::BadRequest("Jump host not found".into()));
        };
        if kind != "ssh" {
            return Err(AppError::BadRequest("Jump host must use SSH".into()));
        }
        next = parent;
    }
    Ok(())
}
async fn store_credentials(
    connection: &mut sqlx::SqliteConnection,
    key: &[u8; 32],
    body: &HostCreate,
) -> AppResult<i64> {
    let payload = zeroize::Zeroizing::new(json!({"password":body.password,"private_key":body.private_key,"passphrase":body.passphrase}).to_string());
    let metadata =
        vault::credential_metadata(payload.as_bytes(), Some(r#"{"type":"host_credentials"}"#));
    let (id,) = sqlx::query_as::<_, (i64,)>(
        "INSERT INTO vault_items(name,ciphertext,item_metadata) VALUES(?,?,?) RETURNING id",
    )
    .bind(format!("host:{}", body.name))
    .bind(vault::encrypt(payload.as_bytes(), key)?)
    .bind(metadata)
    .fetch_one(connection)
    .await?;
    Ok(id)
}

async fn create_host(
    State(st): State<AppState>,
    Json(mut body): Json<HostCreate>,
) -> AppResult<impl IntoResponse> {
    // Input validation.
    body.group = canonical_group(body.group.as_deref())?;
    validate_host(&body)?;

    // Match vault/reset lock ordering: vault operation guard before SQLite.
    let _vault_guard = vault::lock_vault_operation(&st.vault).await;
    let mut tx = st.db.begin_with("BEGIN IMMEDIATE").await?;
    validate_jump(&mut tx, None, body.jump_host_id).await?;
    let credential_id = if body.password.is_some() || body.private_key.is_some() {
        let key = vault::active_key(&st.vault).await?;
        Some(store_credentials(&mut tx, &key, &body).await?)
    } else {
        None
    };

    let result = sqlx::query_as::<_, (i64,)>(
        r#"INSERT INTO hosts
            (name, hostname, port, username, connection_type, serial_port,
             serial_speed, "group", credential_id, jump_host_id,
             terminal_theme, terminal_font_size, terminal_background, terminal_foreground, terminal_appearance,
             local_command, local_args, local_cwd)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING id"#,
    )
    .bind(&body.name)
    .bind(&body.hostname)
    .bind(body.port)
    .bind(&body.username)
    .bind(&body.connection_type)
    .bind(&body.serial_port)
    .bind(body.serial_speed)
    .bind(&body.group)
    .bind(credential_id)
    .bind(body.jump_host_id)
    .bind(&body.terminal_theme)
    .bind(body.terminal_font_size)
    .bind(&body.terminal_background)
    .bind(&body.terminal_foreground)
    .bind(body.terminal_appearance.as_ref().map(TerminalAppearance::to_json).transpose()?)
    .bind(&body.local_command)
    .bind(
        body.local_args
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default()),
    )
    .bind(&body.local_cwd)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| {
        if let sqlx::Error::Database(ref db_err) = e {
            if db_err.message().contains("UNIQUE") {
                return AppError::Conflict(format!(
                    "A host with the name '{}' already exists.",
                    body.name
                ));
            }
        }
        AppError::Db(e)
    })?;

    let out = load_output(&mut tx, result.0).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(out)))
}

async fn update_host(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
    Json(body): Json<HostUpdate>,
) -> AppResult<Json<HostOut>> {
    let _vault_guard = vault::lock_vault_operation(&st.vault).await;
    let mut tx = st.db.begin_with("BEGIN IMMEDIATE").await?;
    let existing = sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
        .bind(host_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Host not found".into()))?;
    if body
        .revision
        .is_some_and(|revision| revision != existing.revision)
    {
        return Err(AppError::Conflict("Host was changed in another view. Reopen the host editor and apply your changes again.".into()));
    }
    let mut body = body.merge(&existing);
    body.group = canonical_group(body.group.as_deref())?;
    validate_host(&body)?;
    validate_jump(&mut tx, Some(host_id), body.jump_host_id).await?;
    let has_new_credentials =
        body.password.is_some() || body.private_key.is_some() || body.passphrase.is_some();
    let previous_credential_id = existing.credential_id;
    let clear_credentials = body.clear_credentials.unwrap_or(false);

    // Update credentials in vault when provided.
    let mut credential_id: Option<i64> = previous_credential_id;
    if clear_credentials {
        credential_id = None;
    } else if has_new_credentials {
        let key = vault::active_key(&st.vault).await?;
        let cid = store_credentials(&mut tx, &key, &body).await?;
        credential_id = Some(cid);
    }

    // Legacy plaintext columns are a read-only migration source. Ordinary host
    // edits must not erase them before a successful vault migration, and no
    // current API path may write plaintext back into them.
    let update_sql = if clear_credentials || has_new_credentials {
        r#"UPDATE hosts SET
            name = ?, hostname = ?, port = ?, username = ?,
            connection_type = ?, serial_port = ?, serial_speed = ?,
            "group" = ?, credential_id = ?, jump_host_id = ?,
            terminal_theme = ?, terminal_font_size = ?, terminal_background = ?, terminal_foreground = ?, terminal_appearance = ?,
            local_command = ?, local_args = ?, local_cwd = ?,
            password = NULL, private_key = NULL
           WHERE id = ?"#
    } else {
        r#"UPDATE hosts SET
            name = ?, hostname = ?, port = ?, username = ?,
            connection_type = ?, serial_port = ?, serial_speed = ?,
            "group" = ?, credential_id = ?, jump_host_id = ?,
            terminal_theme = ?, terminal_font_size = ?, terminal_background = ?, terminal_foreground = ?, terminal_appearance = ?,
            local_command = ?, local_args = ?, local_cwd = ?
           WHERE id = ?"#
    };

    sqlx::query(update_sql)
        .bind(&body.name)
        .bind(&body.hostname)
        .bind(body.port)
        .bind(&body.username)
        .bind(&body.connection_type)
        .bind(&body.serial_port)
        .bind(body.serial_speed)
        .bind(&body.group)
        .bind(credential_id)
        .bind(body.jump_host_id)
        .bind(&body.terminal_theme)
        .bind(body.terminal_font_size)
        .bind(&body.terminal_background)
        .bind(&body.terminal_foreground)
        .bind(
            body.terminal_appearance
                .as_ref()
                .map(TerminalAppearance::to_json)
                .transpose()?,
        )
        .bind(&body.local_command)
        .bind(
            body.local_args
                .as_ref()
                .map(|v| serde_json::to_string(v).unwrap_or_default()),
        )
        .bind(&body.local_cwd)
        .bind(host_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            if let sqlx::Error::Database(ref db_err) = e {
                if db_err.message().contains("UNIQUE") {
                    return AppError::Conflict(format!(
                        "A host with the name '{}' already exists.",
                        body.name
                    ));
                }
            }
            AppError::Db(e)
        })?;

    if let Some(old_id) = previous_credential_id {
        if Some(old_id) != credential_id {
            cleanup_orphan_credential(&mut tx, old_id).await?;
        }
    }

    let out = load_output(&mut tx, host_id).await?;
    tx.commit().await?;
    Ok(Json(out))
}

async fn patch_host(
    state: State<AppState>,
    path: Path<i64>,
    Json(body): Json<HostUpdate>,
) -> AppResult<Json<HostOut>> {
    if body.revision.is_none() {
        return Err(AppError::BadRequest(
            "revision is required for PATCH; reload the host first".into(),
        ));
    }
    update_host(state, path, Json(body)).await
}

async fn delete_host(
    State(st): State<AppState>,
    Path(host_id): Path<i64>,
) -> AppResult<impl IntoResponse> {
    let _registration = st.sessions.tunnels().registration_gate().lock_owned().await;
    let mut tx = st.db.begin_with("BEGIN IMMEDIATE").await?;
    let existing = sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
        .bind(host_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Host not found".into()))?;

    let (jumps, snippets): (i64,i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM hosts WHERE jump_host_id=? AND id!=?), (SELECT COUNT(*) FROM snippets WHERE host_id=?)"
    ).bind(host_id).bind(host_id).bind(host_id).fetch_one(&mut *tx).await?;
    if jumps > 0 || snippets > 0 {
        return Err(AppError::Conflict(format!("Host is referenced by {jumps} jump host profile(s) and {snippets} snippet(s). Reassign or remove those references before deleting.")));
    }
    let affected = sqlx::query("DELETE FROM hosts WHERE id = ?")
        .bind(host_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound("Host not found".into()));
    }

    if let Some(credential_id) = existing.credential_id {
        cleanup_orphan_credential(&mut tx, credential_id).await?;
    }
    tx.commit().await?;
    st.sessions.tunnels().stop_host(host_id).await;
    st.sftp.transfers.cancel_host(host_id);
    st.sftp.disconnect_host(host_id).await;

    Ok(StatusCode::NO_CONTENT)
}
