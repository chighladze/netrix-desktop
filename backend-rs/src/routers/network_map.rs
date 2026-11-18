/// Network Map — visual topology CRUD + auto-populate + ping.
use std::collections::{HashMap, HashSet};

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::AppState;
use crate::error::{AppError, AppResult};
use crate::models::*;

pub fn router() -> Router<AppState> {
    Router::new()
        // Map sheets.
        .route("/network-map/maps", get(list_maps).post(create_map))
        .route(
            "/network-map/maps/{map_id}",
            get(get_map).put(update_map).delete(delete_map),
        )
        .route("/network-map/maps/{map_id}/duplicate", post(duplicate_map))
        .route(
            "/network-map/maps/{map_id}/auto-populate",
            post(auto_populate_map_by_id),
        )
        .route("/network-map/maps/{map_id}/ping", post(ping_map_hosts))
        // Legacy root.
        .route("/network-map", get(get_default_map))
        .route("/network-map/auto-populate", post(auto_populate_default))
        // Nodes.
        .route("/network-map/nodes", post(create_node))
        .route(
            "/network-map/nodes/{node_id}",
            put(update_node).delete(delete_node),
        )
        .route(
            "/network-map/nodes/{node_id}/position",
            patch(update_node_position),
        )
        // Edges.
        .route("/network-map/edges", post(create_edge))
        .route(
            "/network-map/edges/{edge_id}",
            put(update_edge).delete(delete_edge),
        )
}

// ─── Response types ─────────────────────────────────────────────────

#[derive(Serialize)]
struct NetworkMapOut {
    map_id: String,
    map_name: String,
    nodes: Vec<MapNodeOut>,
    edges: Vec<MapEdgeOut>,
}

#[derive(Debug, Deserialize)]
struct MapNodePosition {
    x: Option<i64>,
    y: Option<i64>,
}

// ─── Helpers ────────────────────────────────────────────────────────

async fn ensure_default_map(db: &crate::db::Db) -> Result<NetworkMapRow, sqlx::Error> {
    if let Some(sheet) = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps LIMIT 1")
        .fetch_optional(db)
        .await?
    {
        return Ok(sheet);
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO network_maps (id, name, description) VALUES (?, 'Default Map', 'Auto-created default network map')",
    )
    .bind(&id)
    .execute(db)
    .await?;
    sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&id)
        .fetch_one(db)
        .await
}

async fn node_out(db: &crate::db::Db, n: &MapNodeRow) -> MapNodeOut {
    let host = if let Some(hid) = n.host_id {
        sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
            .bind(hid)
            .fetch_optional(db)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    MapNodeOut {
        id: n.id.clone(),
        map_id: n.map_id.clone(),
        host_id: n.host_id,
        label: n
            .label
            .clone()
            .or_else(|| host.as_ref().map(|h| h.name.clone())),
        icon: n.icon.clone(),
        x: n.x,
        y: n.y,
        color: n.color.clone(),
        width: n.width,
        height: n.height,
        host_name: host.as_ref().map(|h| h.name.clone()),
        host_hostname: host.as_ref().map(|h| h.hostname.clone()),
        host_connection_type: host.as_ref().map(|h| h.connection_type.clone()),
        host_group: host.as_ref().and_then(|h| h.group.clone()),
        host_port: host.as_ref().map(|h| h.port),
        host_username: host.as_ref().and_then(|h| h.username.clone()),
    }
}

const MAX_MAP_NAME_CHARS: usize = 128;
const MAX_LABEL_CHARS: usize = 256;
const MAX_DESCRIPTION_CHARS: usize = 4_096;
const MAX_METADATA_BYTES: usize = 65_536;
const MAX_ABS_COORDINATE: i64 = 1_000_000;
const MIN_NODE_DIMENSION: i64 = 40;
const MAX_NODE_DIMENSION: i64 = 4_096;
const MAX_WAYPOINTS: usize = 256;

fn validate_required_text(value: &str, field: &str, max_chars: usize) -> AppResult<()> {
    let length = value.chars().count();
    if value.trim().is_empty() {
        return Err(AppError::BadRequest(format!("{field} cannot be empty")));
    }
    if length > max_chars {
        return Err(AppError::BadRequest(format!(
            "{field} cannot exceed {max_chars} characters"
        )));
    }
    Ok(())
}

fn validate_optional_text(value: Option<&str>, field: &str, max_chars: usize) -> AppResult<()> {
    if let Some(value) = value {
        if value.chars().count() > max_chars {
            return Err(AppError::BadRequest(format!(
                "{field} cannot exceed {max_chars} characters"
            )));
        }
    }
    Ok(())
}

fn validate_color(value: &str, field: &str) -> AppResult<()> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 7
        && bytes.first() == Some(&b'#')
        && bytes[1..].iter().all(u8::is_ascii_hexdigit);
    if !valid {
        return Err(AppError::BadRequest(format!(
            "{field} must be a six-digit hexadecimal color"
        )));
    }
    Ok(())
}

fn validate_coordinate(value: i64, field: &str) -> AppResult<()> {
    if !(-MAX_ABS_COORDINATE..=MAX_ABS_COORDINATE).contains(&value) {
        return Err(AppError::BadRequest(format!(
            "{field} must be between -{MAX_ABS_COORDINATE} and {MAX_ABS_COORDINATE}"
        )));
    }
    Ok(())
}

fn validate_node_fields(
    label: Option<&str>,
    icon: &str,
    x: i64,
    y: i64,
    color: &str,
    width: i64,
    height: i64,
) -> AppResult<()> {
    validate_optional_text(label, "Node label", MAX_LABEL_CHARS)?;
    validate_required_text(icon, "Node icon", 64)?;
    if !icon
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppError::BadRequest(
            "Node icon contains invalid characters".into(),
        ));
    }
    validate_coordinate(x, "Node x coordinate")?;
    validate_coordinate(y, "Node y coordinate")?;
    validate_color(color, "Node color")?;
    if !(MIN_NODE_DIMENSION..=MAX_NODE_DIMENSION).contains(&width)
        || !(MIN_NODE_DIMENSION..=MAX_NODE_DIMENSION).contains(&height)
    {
        return Err(AppError::BadRequest(format!(
            "Node dimensions must be between {MIN_NODE_DIMENSION} and {MAX_NODE_DIMENSION}"
        )));
    }
    Ok(())
}

fn validate_json_metadata(value: Option<&str>, field: &str, require_array: bool) -> AppResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    if value.len() > MAX_METADATA_BYTES {
        return Err(AppError::BadRequest(format!(
            "{field} cannot exceed {MAX_METADATA_BYTES} bytes"
        )));
    }
    let parsed: serde_json::Value = serde_json::from_str(value)
        .map_err(|_| AppError::BadRequest(format!("{field} must be valid JSON")))?;
    if require_array {
        let points = parsed
            .as_array()
            .ok_or_else(|| AppError::BadRequest(format!("{field} must be a JSON array")))?;
        if points.len() > MAX_WAYPOINTS {
            return Err(AppError::BadRequest(format!(
                "{field} cannot contain more than {MAX_WAYPOINTS} points"
            )));
        }
        for point in points {
            let x = point
                .get("x")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| {
                    AppError::BadRequest(format!("{field} points require integer x and y values"))
                })?;
            let y = point
                .get("y")
                .and_then(serde_json::Value::as_i64)
                .ok_or_else(|| {
                    AppError::BadRequest(format!("{field} points require integer x and y values"))
                })?;
            validate_coordinate(x, "Waypoint x coordinate")?;
            validate_coordinate(y, "Waypoint y coordinate")?;
        }
    } else if !parsed.is_object() {
        return Err(AppError::BadRequest(format!(
            "{field} must be a JSON object"
        )));
    }
    Ok(())
}

struct EdgeFields<'a> {
    label: Option<&'a str>,
    color: &'a str,
    stroke_width: i64,
    style: &'a str,
    waypoints: Option<&'a str>,
    ports_count: i64,
    connection_type: &'a str,
    connection_properties: Option<&'a str>,
}

fn validate_edge_fields(fields: EdgeFields<'_>) -> AppResult<()> {
    validate_optional_text(fields.label, "Edge label", MAX_LABEL_CHARS)?;
    validate_color(fields.color, "Edge color")?;
    if !(1..=32).contains(&fields.stroke_width) {
        return Err(AppError::BadRequest(
            "Edge stroke width must be between 1 and 32".into(),
        ));
    }
    if !matches!(fields.style, "solid" | "dashed" | "dotted") {
        return Err(AppError::BadRequest(
            "Edge style must be solid, dashed, or dotted".into(),
        ));
    }
    if !(1..=999).contains(&fields.ports_count) {
        return Err(AppError::BadRequest(
            "Edge ports count must be between 1 and 999".into(),
        ));
    }
    validate_required_text(fields.connection_type, "Connection type", 64)?;
    if !fields
        .connection_type
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(AppError::BadRequest(
            "Connection type contains invalid characters".into(),
        ));
    }
    validate_json_metadata(fields.waypoints, "Edge waypoints", true)?;
    validate_json_metadata(
        fields.connection_properties,
        "Edge connection properties",
        false,
    )?;
    Ok(())
}

async fn ensure_map_exists(db: &crate::db::Db, map_id: &str) -> AppResult<()> {
    let exists = sqlx::query("SELECT 1 FROM network_maps WHERE id = ?")
        .bind(map_id)
        .fetch_optional(db)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("Map not found".into()));
    }
    Ok(())
}

// ─── Map Sheets CRUD ────────────────────────────────────────────────

async fn list_maps(State(st): State<AppState>) -> AppResult<Json<Vec<MapSheetOut>>> {
    let sheets =
        sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps ORDER BY created_at")
            .fetch_all(&st.db)
            .await?;

    let sheets = if sheets.is_empty() {
        vec![ensure_default_map(&st.db).await?]
    } else {
        sheets
    };

    let mut out = Vec::new();
    for s in &sheets {
        let nc: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM map_nodes WHERE map_id = ?")
            .bind(&s.id)
            .fetch_one(&st.db)
            .await?;
        let ec: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM map_edges WHERE map_id = ?")
            .bind(&s.id)
            .fetch_one(&st.db)
            .await?;
        out.push(MapSheetOut {
            id: s.id.clone(),
            name: s.name.clone(),
            description: s.description.clone(),
            node_count: nc.0,
            edge_count: ec.0,
            created_at: s.created_at.clone(),
            updated_at: s.updated_at.clone(),
        });
    }
    Ok(Json(out))
}

async fn create_map(
    State(st): State<AppState>,
    Json(body): Json<MapSheetCreate>,
) -> AppResult<impl IntoResponse> {
    validate_required_text(&body.name, "Map name", MAX_MAP_NAME_CHARS)?;
    validate_optional_text(
        body.description.as_deref(),
        "Map description",
        MAX_DESCRIPTION_CHARS,
    )?;
    let id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO network_maps (id, name, description) VALUES (?, ?, ?)")
        .bind(&id)
        .bind(&body.name)
        .bind(&body.description)
        .execute(&st.db)
        .await?;
    let sheet = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&id)
        .fetch_one(&st.db)
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(MapSheetOut {
            id: sheet.id,
            name: sheet.name,
            description: sheet.description,
            node_count: 0,
            edge_count: 0,
            created_at: sheet.created_at,
            updated_at: sheet.updated_at,
        }),
    ))
}

async fn get_map(
    State(st): State<AppState>,
    Path(map_id): Path<String>,
) -> AppResult<Json<NetworkMapOut>> {
    let sheet = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Map not found".into()))?;

    let nodes = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE map_id = ?")
        .bind(&map_id)
        .fetch_all(&st.db)
        .await?;
    let edges = sqlx::query_as::<_, MapEdgeRow>("SELECT * FROM map_edges WHERE map_id = ?")
        .bind(&map_id)
        .fetch_all(&st.db)
        .await?;

    let mut node_outs = Vec::new();
    for n in &nodes {
        node_outs.push(node_out(&st.db, n).await);
    }

    Ok(Json(NetworkMapOut {
        map_id: sheet.id,
        map_name: sheet.name,
        nodes: node_outs,
        edges: edges.iter().map(MapEdgeOut::from_row).collect(),
    }))
}

async fn update_map(
    State(st): State<AppState>,
    Path(map_id): Path<String>,
    Json(body): Json<MapSheetUpdate>,
) -> AppResult<Json<MapSheetOut>> {
    let existing = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Map not found".into()))?;

    let name = body.name.as_deref().unwrap_or(&existing.name);
    let desc = body
        .description
        .as_deref()
        .or(existing.description.as_deref());
    validate_required_text(name, "Map name", MAX_MAP_NAME_CHARS)?;
    validate_optional_text(desc, "Map description", MAX_DESCRIPTION_CHARS)?;

    sqlx::query("UPDATE network_maps SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(name)
        .bind(desc)
        .bind(&map_id)
        .execute(&st.db)
        .await?;

    let sheet = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .fetch_one(&st.db)
        .await?;
    let nc: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM map_nodes WHERE map_id = ?")
        .bind(&map_id)
        .fetch_one(&st.db)
        .await?;
    let ec: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM map_edges WHERE map_id = ?")
        .bind(&map_id)
        .fetch_one(&st.db)
        .await?;

    Ok(Json(MapSheetOut {
        id: sheet.id,
        name: sheet.name,
        description: sheet.description,
        node_count: nc.0,
        edge_count: ec.0,
        created_at: sheet.created_at,
        updated_at: sheet.updated_at,
    }))
}

async fn delete_map(
    State(st): State<AppState>,
    Path(map_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let mut tx = st.db.begin().await?;
    let exists = sqlx::query("SELECT 1 FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("Map not found".into()));
    }

    sqlx::query("DELETE FROM map_edges WHERE map_id = ?")
        .bind(&map_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM map_nodes WHERE map_id = ?")
        .bind(&map_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn duplicate_map(
    State(st): State<AppState>,
    Path(map_id): Path<String>,
) -> AppResult<Json<MapSheetOut>> {
    let mut tx = st.db.begin().await?;
    let sheet = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Map not found".into()))?;

    let new_id = Uuid::new_v4().to_string();
    let duplicate_name = format!("{} (Copy)", sheet.name);
    validate_required_text(&duplicate_name, "Map name", MAX_MAP_NAME_CHARS)?;
    sqlx::query("INSERT INTO network_maps (id, name, description) VALUES (?, ?, ?)")
        .bind(&new_id)
        .bind(&duplicate_name)
        .bind(&sheet.description)
        .execute(&mut *tx)
        .await?;

    // Copy nodes.
    let nodes = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE map_id = ?")
        .bind(&map_id)
        .fetch_all(&mut *tx)
        .await?;

    let mut node_id_map: HashMap<String, String> = HashMap::new();
    for n in &nodes {
        let nid = Uuid::new_v4().to_string();
        node_id_map.insert(n.id.clone(), nid.clone());
        sqlx::query(
            "INSERT INTO map_nodes (id, map_id, host_id, label, icon, x, y, color, width, height) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .bind(&nid)
        .bind(&new_id)
        .bind(n.host_id)
        .bind(&n.label)
        .bind(&n.icon)
        .bind(n.x)
        .bind(n.y)
        .bind(&n.color)
        .bind(n.width)
        .bind(n.height)
        .execute(&mut *tx)
        .await?;
    }

    // Copy edges.
    let edges = sqlx::query_as::<_, MapEdgeRow>("SELECT * FROM map_edges WHERE map_id = ?")
        .bind(&map_id)
        .fetch_all(&mut *tx)
        .await?;
    for e in &edges {
        if let (Some(src), Some(tgt)) = (
            node_id_map.get(&e.source_node_id),
            node_id_map.get(&e.target_node_id),
        ) {
            let eid = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO map_edges (id,map_id,source_node_id,target_node_id,label,color,stroke_width,style,waypoints,ports_count,connection_type,connection_properties) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(&eid)
            .bind(&new_id)
            .bind(src)
            .bind(tgt)
            .bind(&e.label)
            .bind(&e.color)
            .bind(e.stroke_width)
            .bind(&e.style)
            .bind(&e.waypoints)
            .bind(e.ports_count)
            .bind(&e.connection_type)
            .bind(&e.connection_properties)
            .execute(&mut *tx)
            .await?;
        }
    }

    let new_sheet = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&new_id)
        .fetch_one(&mut *tx)
        .await?;
    let nc: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM map_nodes WHERE map_id = ?")
        .bind(&new_id)
        .fetch_one(&mut *tx)
        .await?;
    let ec2: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM map_edges WHERE map_id = ?")
        .bind(&new_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(Json(MapSheetOut {
        id: new_sheet.id,
        name: new_sheet.name,
        description: new_sheet.description,
        node_count: nc.0,
        edge_count: ec2.0,
        created_at: new_sheet.created_at,
        updated_at: new_sheet.updated_at,
    }))
}

// ─── Legacy root endpoint ───────────────────────────────────────────

async fn get_default_map(State(st): State<AppState>) -> AppResult<Json<NetworkMapOut>> {
    let sheet = ensure_default_map(&st.db).await?;
    let map_id = &sheet.id;

    let nodes = sqlx::query_as::<_, MapNodeRow>(
        "SELECT * FROM map_nodes WHERE map_id = ? OR map_id IS NULL",
    )
    .bind(map_id)
    .fetch_all(&st.db)
    .await?;

    let edges = sqlx::query_as::<_, MapEdgeRow>(
        "SELECT * FROM map_edges WHERE map_id = ? OR map_id IS NULL",
    )
    .bind(map_id)
    .fetch_all(&st.db)
    .await?;

    let mut node_outs = Vec::new();
    for n in &nodes {
        node_outs.push(node_out(&st.db, n).await);
    }

    Ok(Json(NetworkMapOut {
        map_id: sheet.id,
        map_name: sheet.name,
        nodes: node_outs,
        edges: edges.iter().map(MapEdgeOut::from_row).collect(),
    }))
}

// ─── Nodes CRUD ─────────────────────────────────────────────────────

async fn create_node(
    State(st): State<AppState>,
    Json(body): Json<MapNodeCreate>,
) -> AppResult<impl IntoResponse> {
    if let Some(hid) = body.host_id {
        let exists = sqlx::query("SELECT 1 FROM hosts WHERE id = ?")
            .bind(hid)
            .fetch_optional(&st.db)
            .await?;
        if exists.is_none() {
            return Err(AppError::NotFound("Host not found".into()));
        }
    }

    let map_id = match &body.map_id {
        Some(id) => id.clone(),
        None => ensure_default_map(&st.db).await?.id,
    };
    ensure_map_exists(&st.db, &map_id).await?;
    validate_node_fields(
        body.label.as_deref(),
        &body.icon,
        body.x,
        body.y,
        &body.color,
        body.width,
        body.height,
    )?;

    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO map_nodes (id, map_id, host_id, label, icon, x, y, color, width, height) VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&map_id)
    .bind(body.host_id)
    .bind(&body.label)
    .bind(&body.icon)
    .bind(body.x)
    .bind(body.y)
    .bind(&body.color)
    .bind(body.width)
    .bind(body.height)
    .execute(&st.db)
    .await?;

    let row = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE id = ?")
        .bind(&id)
        .fetch_one(&st.db)
        .await?;

    Ok((StatusCode::CREATED, Json(node_out(&st.db, &row).await)))
}

async fn update_node(
    State(st): State<AppState>,
    Path(node_id): Path<String>,
    Json(body): Json<MapNodeUpdate>,
) -> AppResult<Json<MapNodeOut>> {
    let existing = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE id = ?")
        .bind(&node_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;

    let map_id = body.map_id.as_deref().or(existing.map_id.as_deref());
    let host_id = body.host_id.or(existing.host_id);
    let label = body.label.as_deref().or(existing.label.as_deref());
    let icon = body.icon.as_deref().unwrap_or(&existing.icon);
    let x = body.x.unwrap_or(existing.x);
    let y = body.y.unwrap_or(existing.y);
    let color = body.color.as_deref().unwrap_or(&existing.color);
    let width = body.width.unwrap_or(existing.width);
    let height = body.height.unwrap_or(existing.height);

    if let Some(map_id) = map_id {
        ensure_map_exists(&st.db, map_id).await?;
    }
    if let Some(host_id) = host_id {
        let host_exists = sqlx::query("SELECT 1 FROM hosts WHERE id = ?")
            .bind(host_id)
            .fetch_optional(&st.db)
            .await?;
        if host_exists.is_none() {
            return Err(AppError::NotFound("Host not found".into()));
        }
    }
    validate_node_fields(label, icon, x, y, color, width, height)?;

    if existing.map_id.as_deref() != map_id {
        let edge_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM map_edges WHERE source_node_id = ? OR target_node_id = ?",
        )
        .bind(&node_id)
        .bind(&node_id)
        .fetch_one(&st.db)
        .await?;
        if edge_count.0 > 0 {
            return Err(AppError::Conflict(
                "Cannot move a connected node to another map".into(),
            ));
        }
    }

    sqlx::query(
        "UPDATE map_nodes SET map_id=?, host_id=?, label=?, icon=?, x=?, y=?, color=?, width=?, height=? WHERE id=?",
    )
    .bind(map_id)
    .bind(host_id)
    .bind(label)
    .bind(icon)
    .bind(x)
    .bind(y)
    .bind(color)
    .bind(width)
    .bind(height)
    .bind(&node_id)
    .execute(&st.db)
    .await?;

    let row = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE id = ?")
        .bind(&node_id)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(node_out(&st.db, &row).await))
}

async fn delete_node(
    State(st): State<AppState>,
    Path(node_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let mut tx = st.db.begin().await?;
    let exists = sqlx::query("SELECT 1 FROM map_nodes WHERE id = ?")
        .bind(&node_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound("Node not found".into()));
    }

    sqlx::query("DELETE FROM map_edges WHERE source_node_id = ? OR target_node_id = ?")
        .bind(&node_id)
        .bind(&node_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM map_nodes WHERE id = ?")
        .bind(&node_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn update_node_position(
    State(st): State<AppState>,
    Path(node_id): Path<String>,
    Json(pos): Json<MapNodePosition>,
) -> AppResult<Json<serde_json::Value>> {
    let existing = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE id = ?")
        .bind(&node_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Node not found".into()))?;
    if pos.x.is_none() && pos.y.is_none() {
        return Err(AppError::BadRequest(
            "At least one node coordinate is required".into(),
        ));
    }
    let x = pos.x.unwrap_or(existing.x);
    let y = pos.y.unwrap_or(existing.y);
    validate_coordinate(x, "Node x coordinate")?;
    validate_coordinate(y, "Node y coordinate")?;
    sqlx::query("UPDATE map_nodes SET x = ?, y = ? WHERE id = ?")
        .bind(x)
        .bind(y)
        .bind(&node_id)
        .execute(&st.db)
        .await?;

    Ok(Json(serde_json::json!({ "status": "ok" })))
}

// ─── Edges CRUD ─────────────────────────────────────────────────────

async fn create_edge(
    State(st): State<AppState>,
    Json(body): Json<MapEdgeCreate>,
) -> AppResult<impl IntoResponse> {
    if body.source_node_id == body.target_node_id {
        return Err(AppError::BadRequest(
            "An edge must connect two different nodes".into(),
        ));
    }
    validate_edge_fields(EdgeFields {
        label: body.label.as_deref(),
        color: &body.color,
        stroke_width: body.stroke_width,
        style: &body.style,
        waypoints: body.waypoints.as_deref(),
        ports_count: body.ports_count,
        connection_type: &body.connection_type,
        connection_properties: body.connection_properties.as_deref(),
    })?;

    let mut tx = st.db.begin().await?;
    let src = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE id = ?")
        .bind(&body.source_node_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Source node not found".into()))?;
    let tgt = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE id = ?")
        .bind(&body.target_node_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| AppError::NotFound("Target node not found".into()))?;

    let source_map_id = src
        .map_id
        .as_deref()
        .ok_or_else(|| AppError::Conflict("Source node is not assigned to a map".into()))?;
    let target_map_id = tgt
        .map_id
        .as_deref()
        .ok_or_else(|| AppError::Conflict("Target node is not assigned to a map".into()))?;
    if source_map_id != target_map_id {
        return Err(AppError::Conflict(
            "An edge cannot connect nodes from different maps".into(),
        ));
    }
    if body
        .map_id
        .as_deref()
        .is_some_and(|map_id| map_id != source_map_id)
    {
        return Err(AppError::BadRequest(
            "Edge map_id must match both endpoint nodes".into(),
        ));
    }
    let map_id = source_map_id.to_string();
    let map_exists = sqlx::query("SELECT 1 FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .fetch_optional(&mut *tx)
        .await?;
    if map_exists.is_none() {
        return Err(AppError::Conflict(
            "Endpoint nodes reference a missing map".into(),
        ));
    }

    // Prevent duplicate.
    let dup = sqlx::query(
        "SELECT 1 FROM map_edges WHERE (source_node_id = ? AND target_node_id = ?) OR (source_node_id = ? AND target_node_id = ?)",
    )
    .bind(&body.source_node_id)
    .bind(&body.target_node_id)
    .bind(&body.target_node_id)
    .bind(&body.source_node_id)
    .fetch_optional(&mut *tx)
    .await?;
    if dup.is_some() {
        return Err(AppError::Conflict(
            "Edge already exists between these nodes".into(),
        ));
    }

    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO map_edges (id,map_id,source_node_id,target_node_id,label,color,stroke_width,style,waypoints,ports_count,connection_type,connection_properties) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&map_id)
    .bind(&body.source_node_id)
    .bind(&body.target_node_id)
    .bind(&body.label)
    .bind(&body.color)
    .bind(body.stroke_width)
    .bind(&body.style)
    .bind(&body.waypoints)
    .bind(body.ports_count)
    .bind(&body.connection_type)
    .bind(&body.connection_properties)
    .execute(&mut *tx)
    .await?;

    let row = sqlx::query_as::<_, MapEdgeRow>("SELECT * FROM map_edges WHERE id = ?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok((StatusCode::CREATED, Json(MapEdgeOut::from_row(&row))))
}

async fn update_edge(
    State(st): State<AppState>,
    Path(edge_id): Path<String>,
    Json(body): Json<MapEdgeUpdate>,
) -> AppResult<Json<MapEdgeOut>> {
    let existing = sqlx::query_as::<_, MapEdgeRow>("SELECT * FROM map_edges WHERE id = ?")
        .bind(&edge_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Edge not found".into()))?;

    let label = body.label.as_deref().or(existing.label.as_deref());
    let color = body.color.as_deref().unwrap_or(&existing.color);
    let stroke_width = body.stroke_width.unwrap_or(existing.stroke_width);
    let style = body.style.as_deref().unwrap_or(&existing.style);
    let waypoints = body.waypoints.as_deref().or(existing.waypoints.as_deref());
    let ports_count = body.ports_count.unwrap_or(existing.ports_count);
    let connection_type = body
        .connection_type
        .as_deref()
        .unwrap_or(&existing.connection_type);
    let connection_properties = body
        .connection_properties
        .as_deref()
        .or(existing.connection_properties.as_deref());
    validate_edge_fields(EdgeFields {
        label,
        color,
        stroke_width,
        style,
        waypoints,
        ports_count,
        connection_type,
        connection_properties,
    })?;

    sqlx::query(
        "UPDATE map_edges SET label=?, color=?, stroke_width=?, style=?, waypoints=?, ports_count=?, connection_type=?, connection_properties=? WHERE id=?",
    )
    .bind(label)
    .bind(color)
    .bind(stroke_width)
    .bind(style)
    .bind(waypoints)
    .bind(ports_count)
    .bind(connection_type)
    .bind(connection_properties)
    .bind(&edge_id)
    .execute(&st.db)
    .await?;

    let row = sqlx::query_as::<_, MapEdgeRow>("SELECT * FROM map_edges WHERE id = ?")
        .bind(&edge_id)
        .fetch_one(&st.db)
        .await?;
    Ok(Json(MapEdgeOut::from_row(&row)))
}

async fn delete_edge(
    State(st): State<AppState>,
    Path(edge_id): Path<String>,
) -> AppResult<impl IntoResponse> {
    let affected = sqlx::query("DELETE FROM map_edges WHERE id = ?")
        .bind(&edge_id)
        .execute(&st.db)
        .await?
        .rows_affected();
    if affected == 0 {
        return Err(AppError::NotFound("Edge not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

// ─── Auto-populate ──────────────────────────────────────────────────

async fn auto_populate_default(State(st): State<AppState>) -> AppResult<Json<NetworkMapOut>> {
    let sheet = ensure_default_map(&st.db).await?;
    auto_populate_impl(&st.db, &sheet).await
}

async fn auto_populate_map_by_id(
    State(st): State<AppState>,
    Path(map_id): Path<String>,
) -> AppResult<Json<NetworkMapOut>> {
    let sheet = sqlx::query_as::<_, NetworkMapRow>("SELECT * FROM network_maps WHERE id = ?")
        .bind(&map_id)
        .fetch_optional(&st.db)
        .await?
        .ok_or_else(|| AppError::NotFound("Map not found".into()))?;
    auto_populate_impl(&st.db, &sheet).await
}

async fn auto_populate_impl(
    db: &crate::db::Db,
    sheet: &NetworkMapRow,
) -> AppResult<Json<NetworkMapOut>> {
    let existing: Vec<(Option<i64>,)> =
        sqlx::query_as("SELECT host_id FROM map_nodes WHERE map_id = ? AND host_id IS NOT NULL")
            .bind(&sheet.id)
            .fetch_all(db)
            .await?;
    let existing_ids: HashSet<i64> = existing.iter().filter_map(|r| r.0).collect();

    let all_hosts = sqlx::query_as::<_, Host>("SELECT * FROM hosts")
        .fetch_all(db)
        .await?;
    let new_hosts: Vec<&Host> = all_hosts
        .iter()
        .filter(|h| !existing_ids.contains(&h.id))
        .collect();

    let cols = (new_hosts.len() as f64).sqrt() as i64 + 1;
    let cols = cols.max(4);
    let (sx, sy) = (100i64, 100i64);
    let (dx, dy) = (200i64, 150i64);

    let mut col_idx = 0i64;
    let mut row_idx = 0i64;

    for host in &new_hosts {
        let icon = match host.connection_type.as_str() {
            "telnet" => "router",
            "serial" => "switch",
            _ => "server",
        };
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO map_nodes (id, map_id, host_id, label, icon, x, y, color) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(&id)
        .bind(&sheet.id)
        .bind(host.id)
        .bind(&host.name)
        .bind(icon)
        .bind(sx + col_idx * dx)
        .bind(sy + row_idx * dy)
        .bind("#3b82f6")
        .execute(db)
        .await?;
        col_idx += 1;
        if col_idx >= cols {
            col_idx = 0;
            row_idx += 1;
        }
    }

    // Return the full map.
    let nodes = sqlx::query_as::<_, MapNodeRow>("SELECT * FROM map_nodes WHERE map_id = ?")
        .bind(&sheet.id)
        .fetch_all(db)
        .await?;
    let edges = sqlx::query_as::<_, MapEdgeRow>("SELECT * FROM map_edges WHERE map_id = ?")
        .bind(&sheet.id)
        .fetch_all(db)
        .await?;

    let mut node_outs = Vec::new();
    for n in &nodes {
        node_outs.push(node_out(db, n).await);
    }

    Ok(Json(NetworkMapOut {
        map_id: sheet.id.clone(),
        map_name: sheet.name.clone(),
        nodes: node_outs,
        edges: edges.iter().map(MapEdgeOut::from_row).collect(),
    }))
}

// ─── Ping ───────────────────────────────────────────────────────────

async fn ping_map_hosts(
    State(st): State<AppState>,
    Path(map_id): Path<String>,
) -> AppResult<Json<HashMap<String, serde_json::Value>>> {
    let nodes = sqlx::query_as::<_, MapNodeRow>(
        "SELECT * FROM map_nodes WHERE map_id = ? AND host_id IS NOT NULL",
    )
    .bind(&map_id)
    .fetch_all(&st.db)
    .await?;

    if nodes.is_empty() {
        return Ok(Json(HashMap::new()));
    }

    let host_ids: Vec<i64> = nodes.iter().filter_map(|n| n.host_id).collect();
    let mut hosts_map: HashMap<i64, Host> = HashMap::new();
    for hid in &host_ids {
        if let Some(h) = sqlx::query_as::<_, Host>("SELECT * FROM hosts WHERE id = ?")
            .bind(hid)
            .fetch_optional(&st.db)
            .await?
        {
            hosts_map.insert(h.id, h);
        }
    }

    // Deduplicate by hostname.
    let mut hostname_to_hids: HashMap<String, Vec<i64>> = HashMap::new();
    for (hid, h) in &hosts_map {
        hostname_to_hids
            .entry(h.hostname.clone())
            .or_default()
            .push(*hid);
    }

    // Ping concurrently.
    let hostname_reachable: HashMap<_, _> = futures::future::join_all(
        hostname_to_hids
            .keys()
            .map(|hostname| async move { (hostname, ping_host(hostname).await) }),
    )
    .await
    .into_iter()
    .collect();

    let mut response = HashMap::new();
    for node in &nodes {
        if let Some(hid) = node.host_id {
            if let Some(host) = hosts_map.get(&hid) {
                response.insert(
                    node.id.clone(),
                    serde_json::json!({
                        "reachable": hostname_reachable.get(&host.hostname).copied().unwrap_or(false),
                        "hostname": host.hostname,
                        "latency_ms": null,
                    }),
                );
            }
        }
    }

    Ok(Json(response))
}

async fn ping_host(hostname: &str) -> bool {
    let param = if cfg!(windows) { "-n" } else { "-c" };
    let timeout_flag = if cfg!(windows) { "-w" } else { "-W" };
    let timeout_val = if cfg!(windows) { "2000" } else { "2" };

    match tokio::process::Command::new("ping")
        .args([param, "1", timeout_flag, timeout_val, hostname])
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
    {
        Ok(status) => status.success(),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_geometry_and_color_are_bounded() {
        assert!(validate_node_fields(None, "server", 0, 0, "#3b82f6", 120, 60).is_ok());
        assert!(validate_node_fields(
            None,
            "server",
            MAX_ABS_COORDINATE + 1,
            0,
            "#3b82f6",
            120,
            60,
        )
        .is_err());
        assert!(validate_node_fields(None, "server", 0, 0, "red", 120, 60).is_err());
        assert!(validate_node_fields(None, "server", 0, 0, "#3b82f6", 1, 60).is_err());
    }

    #[test]
    fn edge_metadata_and_dimensions_are_bounded() {
        assert!(validate_edge_fields(EdgeFields {
            label: Some("uplink"),
            color: "#4b5563",
            stroke_width: 2,
            style: "solid",
            waypoints: Some(r#"[{"x":10,"y":20}]"#),
            ports_count: 2,
            connection_type: "ethernet",
            connection_properties: Some(r#"{"speed":"10 Gbps"}"#),
        })
        .is_ok());
        assert!(validate_edge_fields(EdgeFields {
            label: None,
            color: "#4b5563",
            stroke_width: 0,
            style: "solid",
            waypoints: None,
            ports_count: 1,
            connection_type: "ethernet",
            connection_properties: None,
        })
        .is_err());
        assert!(validate_edge_fields(EdgeFields {
            label: None,
            color: "#4b5563",
            stroke_width: 2,
            style: "animated",
            waypoints: None,
            ports_count: 1,
            connection_type: "ethernet",
            connection_properties: None,
        })
        .is_err());
        assert!(validate_edge_fields(EdgeFields {
            label: None,
            color: "#4b5563",
            stroke_width: 2,
            style: "solid",
            waypoints: Some("not-json"),
            ports_count: 1,
            connection_type: "ethernet",
            connection_properties: None,
        })
        .is_err());
    }
}
