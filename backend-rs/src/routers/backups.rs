//! Portable logical backups: files and responses contain authenticated ciphertext only.
use crate::{
    auth::AppState,
    error::{AppError, AppResult},
    vault,
};
use axum::{
    extract::{DefaultBodyLimit, State},
    routing::post,
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use zeroize::Zeroizing;

const LIMIT: usize = 16 * 1024 * 1024;
const TABLES: &[&str] = &[
    "vault_items",
    "hosts",
    "snippets",
    "quick_actions",
    "highlight_rules",
    "network_maps",
    "map_nodes",
    "map_edges",
    "recent_connections",
    "audit_logs",
    "host_capabilities",
    "ssh_tunnels",
];
const CHECK: &str = "__netrix_vault_check__";
#[derive(Serialize, Deserialize)]
pub struct Archive {
    version: u32,
    salt: String,
    ciphertext: String,
}
#[derive(Deserialize)]
struct Export {
    password: String,
    #[serde(default)]
    preferences: Value,
}
#[derive(Deserialize)]
struct Restore {
    password: String,
    archive: Archive,
    confirmation: String,
}
#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    schema_version: u32,
    tables: Map<String, Value>,
    preferences: Value,
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/backups/export", post(export))
        .route("/backups/restore", post(restore))
        .layer(DefaultBodyLimit::max(24 * 1024 * 1024))
}
fn invalid(message: &str) -> AppError {
    AppError::BadRequest(message.into())
}
async fn columns(connection: &mut sqlx::SqliteConnection, table: &str) -> AppResult<Vec<String>> {
    let rows = sqlx::query(&format!("PRAGMA table_info(\"{table}\")"))
        .fetch_all(connection)
        .await?;
    Ok(rows
        .iter()
        .map(|row| row.get::<String, _>("name"))
        .collect())
}
async fn export(State(st): State<AppState>, Json(body): Json<Export>) -> AppResult<Json<Archive>> {
    if body.password.chars().count() < 12 || body.password.len() > 1024 {
        return Err(invalid(
            "Backup password must have at least 12 characters (max 1024 bytes)",
        ));
    }
    if serde_json::to_vec(&body.preferences)
        .map_err(|_| invalid("Invalid preferences"))?
        .len()
        > 256 * 1024
    {
        return Err(invalid("Preferences are too large"));
    }
    let salt = rand::random::<[u8; 32]>();
    let backup_key = vault::portable_key(body.password, salt.to_vec()).await?;
    let plain = snapshot(&st, body.preferences).await?;
    Ok(Json(Archive {
        version: 1,
        salt: STANDARD.encode(salt),
        ciphertext: STANDARD.encode(vault::encrypt(&plain, &backup_key)?),
    }))
}

// Export's password is passed here explicitly, rather than persisting it in state.
async fn snapshot(st: &AppState, preferences: Value) -> AppResult<Zeroizing<Vec<u8>>> {
    let _guard = vault::lock_vault_operation(&st.vault).await;
    let key = vault::active_key(&st.vault).await?;
    let mut tx = st.db.begin().await?;
    let mut tables = Map::new();
    let mut approximate_bytes = 0usize;
    for &table in TABLES {
        let sql = format!("SELECT * FROM \"{table}\"");
        let mut rows = sqlx::query(&sql).fetch(&mut *tx);
        let mut records = Vec::new();
        while let Some(row) = rows.try_next().await? {
            if table == "vault_items" && row.try_get::<String, _>("name")? == CHECK {
                continue;
            }
            let mut record = Map::new();
            for (index, column) in row.columns().iter().enumerate() {
                let raw = row.try_get_raw(index)?;
                let value = if raw.is_null() {
                    Value::Null
                } else if table == "vault_items" && column.name() == "ciphertext" {
                    let plain =
                        Zeroizing::new(vault::decrypt(&row.try_get::<Vec<u8>, _>(index)?, &key)?);
                    json!(STANDARD.encode(plain.as_slice()))
                } else {
                    match raw.type_info().name() {
                        "INTEGER" => json!(row.try_get::<i64, _>(index)?),
                        "REAL" => json!(row.try_get::<f64, _>(index)?),
                        _ => json!(row.try_get::<String, _>(index)?),
                    }
                };
                record.insert(column.name().to_string(), value);
            }
            approximate_bytes += serde_json::to_vec(&record)
                .map_err(|e| AppError::Internal(e.to_string()))?
                .len();
            if approximate_bytes > LIMIT || records.len() >= 100_000 {
                return Err(invalid("Backup exceeds the record or 16 MiB size limit"));
            }
            records.push(Value::Object(record));
        }
        tables.insert(table.into(), Value::Array(records));
    }
    tx.commit().await?;
    let plain = Zeroizing::new(
        serde_json::to_vec(&Snapshot {
            version: 1,
            schema_version: 8,
            tables,
            preferences,
        })
        .map_err(|e| AppError::Internal(e.to_string()))?,
    );
    if plain.len() > LIMIT {
        return Err(invalid("Backup exceeds 16 MiB"));
    }
    Ok(plain)
}

async fn restore(State(st): State<AppState>, Json(body): Json<Restore>) -> AppResult<Json<Value>> {
    if body.confirmation != "RESTORE BACKUP" {
        return Err(invalid(
            "Type RESTORE BACKUP to replace the current workspace",
        ));
    }
    if !st.sessions.is_empty().await || !st.sessions.tunnels().is_empty().await {
        return Err(AppError::Conflict(
            "Close all terminal sessions and tunnels before restoring a backup".into(),
        ));
    }
    if st.sftp.transfers.has_active() {
        return Err(AppError::Conflict(
            "Finish or cancel SFTP transfers before restoring a backup".into(),
        ));
    }
    st.sftp.clear_idle().await;
    if body.password.len() > 1024
        || body.archive.version != 1
        || body.archive.ciphertext.len() > (LIMIT + 128) * 4 / 3 + 8
    {
        return Err(invalid("Unsupported or oversized backup"));
    }
    let salt = STANDARD
        .decode(body.archive.salt)
        .map_err(|_| invalid("Invalid backup salt"))?;
    if salt.len() != 32 {
        return Err(invalid("Invalid backup salt"));
    }
    let ciphertext = STANDARD
        .decode(body.archive.ciphertext)
        .map_err(|_| invalid("Invalid backup encoding"))?;
    let backup_key = vault::portable_key(body.password, salt).await?;
    let plain = Zeroizing::new(
        vault::decrypt(&ciphertext, &backup_key)
            .map_err(|_| invalid("Backup password is incorrect or the archive is damaged"))?,
    );
    if plain.len() > LIMIT {
        return Err(invalid("Backup exceeds 16 MiB"));
    }
    let data: Snapshot =
        serde_json::from_slice(&plain).map_err(|_| invalid("Invalid backup data"))?;
    if data.version != 1
        || !matches!(data.schema_version, 5..=8)
        || data.tables.len() != TABLES.len()
        || TABLES.iter().any(|name| !data.tables.contains_key(*name))
    {
        return Err(invalid("Unsupported backup schema"));
    }
    let _workspace_guard = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        st.sessions.workspace_gate().write_owned(),
    )
    .await
    .map_err(|_| {
        AppError::Conflict("Another operation is still running; finish it before restoring".into())
    })?;
    if !st.sessions.is_empty().await || !st.sessions.tunnels().is_empty().await {
        return Err(AppError::Conflict(
            "Close all terminal sessions and tunnels before restoring a backup".into(),
        ));
    }
    let _guard = vault::lock_vault_operation(&st.vault).await;
    let key = vault::active_key(&st.vault).await?;
    let mut tx = st.db.begin().await?;
    sqlx::query("PRAGMA defer_foreign_keys=ON")
        .execute(&mut *tx)
        .await?;
    let (previous_revision,): (i64,) =
        sqlx::query_as("SELECT COALESCE(MAX(revision),0) FROM hosts")
            .fetch_one(&mut *tx)
            .await?;
    let archive_revision = data.tables["hosts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["revision"].as_i64())
        .max()
        .unwrap_or(0);
    let restored_revision = previous_revision
        .max(archive_revision)
        .checked_add(1)
        .ok_or_else(|| invalid("Invalid host revision"))?;
    for &table in TABLES.iter().rev() {
        sqlx::query(&format!("DELETE FROM \"{table}\""))
            .execute(&mut *tx)
            .await?;
    }
    let mut count = 0;
    for &table in TABLES {
        let names = columns(&mut tx, table).await?;
        let rows = data.tables[table]
            .as_array()
            .ok_or_else(|| invalid("Invalid table records"))?;
        if rows.len() > 100_000 {
            return Err(invalid("Too many backup records"));
        }
        let sql = format!(
            "INSERT INTO \"{table}\" ({}) VALUES ({})",
            names
                .iter()
                .map(|s| format!("\"{s}\""))
                .collect::<Vec<_>>()
                .join(","),
            vec!["?"; names.len()].join(",")
        );
        for row in rows {
            let mut object = row
                .as_object()
                .cloned()
                .ok_or_else(|| invalid("Invalid backup record"))?;
            if table == "hosts" && data.schema_version == 5 {
                object.insert("revision".into(), json!(0));
            }
            if table == "hosts" && data.schema_version < 7 {
                object.insert("terminal_background".into(), Value::Null);
                object.insert("terminal_foreground".into(), Value::Null);
            }
            if table == "hosts" && data.schema_version < 8 {
                object.insert("terminal_appearance".into(), Value::Null);
            }
            if object.len() != names.len() || names.iter().any(|name| !object.contains_key(name)) {
                return Err(invalid("Backup columns do not match this version"));
            }
            if table == "hosts" {
                // Leave room for every inserted record while retaining exact
                // integer revisions in JavaScript clients.
                if object["revision"]
                    .as_i64()
                    .is_none_or(|v| !(0..=9_007_199_254_540_990).contains(&v))
                {
                    return Err(invalid("Invalid host revision"));
                }
                object.insert("revision".into(), json!(restored_revision));
                let group: Option<String> = serde_json::from_value(object["group"].clone())
                    .map_err(|_| invalid("Invalid host group in backup"))?;
                let group = super::hosts::canonical_group(group.as_deref())?;
                object.insert("group".into(), json!(group));
                let mut host = object.clone();
                if let Some(Value::String(appearance)) = host.get("terminal_appearance") {
                    host.insert(
                        "terminal_appearance".into(),
                        serde_json::from_str(appearance)
                            .map_err(|_| invalid("Invalid terminal appearance in backup"))?,
                    );
                }
                host.insert("password".into(), Value::Null);
                host.insert("private_key".into(), Value::Null);
                if let Some(Value::String(args)) = host.get("local_args") {
                    host.insert(
                        "local_args".into(),
                        serde_json::from_str(args)
                            .map_err(|_| invalid("Invalid local shell arguments in backup"))?,
                    );
                }
                let host: crate::models::HostCreate =
                    serde_json::from_value(Value::Object(host))
                        .map_err(|_| invalid("Invalid host in backup"))?;
                super::hosts::validate_host(&host)?;
            }
            if table == "vault_items" && object.get("name").and_then(Value::as_str) == Some(CHECK) {
                return Err(invalid("Reserved vault item in backup"));
            }
            if table == "vault_items" {
                let plain = Zeroizing::new(
                    STANDARD
                        .decode(
                            object["ciphertext"]
                                .as_str()
                                .ok_or_else(|| invalid("Invalid secret"))?,
                        )
                        .map_err(|_| invalid("Invalid secret encoding"))?,
                );
                let meta = vault::credential_metadata(
                    &plain,
                    object.get("item_metadata").and_then(Value::as_str),
                );
                object.insert("item_metadata".into(), json!(meta));
            }
            let mut query = sqlx::query(&sql);
            for name in &names {
                let value = &object[name];
                query = if table == "vault_items" && name == "ciphertext" {
                    let secret = Zeroizing::new(
                        STANDARD
                            .decode(value.as_str().ok_or_else(|| invalid("Invalid secret"))?)
                            .map_err(|_| invalid("Invalid secret encoding"))?,
                    );
                    query.bind(vault::encrypt(&secret, &key)?)
                } else if value.is_null()
                    || (table == "hosts" && (name == "password" || name == "private_key"))
                {
                    query.bind(Option::<String>::None)
                } else if let Some(value) = value.as_i64() {
                    query.bind(value)
                } else if let Some(value) = value.as_f64() {
                    query.bind(value)
                } else if let Some(value) = value.as_str() {
                    query.bind(value.to_owned())
                } else {
                    return Err(invalid("Invalid backup value"));
                };
            }
            query
                .execute(&mut *tx)
                .await
                .map_err(|_| invalid("Backup records are invalid; nothing was restored"))?;
            count += 1;
        }
    }
    sqlx::query("INSERT INTO vault_items(name,ciphertext,item_metadata) VALUES(?,?,'{}')")
        .bind(CHECK)
        .bind(vault::encrypt(b"netrix-vault-check-v1", &key)?)
        .execute(&mut *tx)
        .await?;
    tx.commit()
        .await
        .map_err(|_| invalid("Backup references are invalid; nothing was restored"))?;
    st.quick_connect_tickets.clear().await;
    st.sftp.transfers.clear_finished();
    Ok(Json(
        json!({"restored":true,"records":count,"preferences":data.preferences}),
    ))
}
