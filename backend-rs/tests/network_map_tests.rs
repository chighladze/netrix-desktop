mod common;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use netrix_backend::auth::{AppState, QuickConnectTicketStore, VaultUnlockLimiter};
use netrix_backend::routers;
use netrix_backend::ssh::{SessionManager, SftpManager};
use serde_json::{json, Value};
use tower::ServiceExt;

async fn setup_app() -> (Router, String, sqlx::SqlitePool) {
    common::init();
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect to in-memory database");
    for schema in [
        include_str!("../migrations/001_initial_schema.sql"),
        include_str!("../migrations/002_add_group_index.sql"),
        include_str!("../migrations/003_add_host_capabilities.sql"),
        include_str!("../migrations/004_add_local_shell_fields.sql"),
        include_str!("../migrations/005_ssh_tunnels.sql"),
        include_str!("../migrations/006_host_revisions.sql"),
        include_str!("../migrations/007_terminal_colors.sql"),
        include_str!("../migrations/008_terminal_appearance.sql"),
    ] {
        sqlx::raw_sql(schema)
            .execute(&pool)
            .await
            .expect("apply schema");
    }

    let token = "network-map-test-token".to_string();
    let state = AppState {
        database_encryption: None,
        security: netrix_backend::security::AppSecurity::default(),
        db: pool.clone(),
        vault: netrix_backend::vault::new_vault(),
        api_token: token.clone(),
        sessions: SessionManager::new(),
        sftp: SftpManager::new(),
        quick_connect_tickets: QuickConnectTicketStore::new(),
        vault_unlock_limiter: VaultUnlockLimiter::new(),
    };
    let app = Router::new()
        .merge(routers::network_map::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            netrix_backend::auth::auth_middleware,
        ))
        .with_state(state);
    (app, token, pool)
}

fn json_request(method: &str, uri: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .header("X-API-Token", token)
        .body(Body::from(serde_json::to_vec(&body).unwrap()))
        .unwrap()
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

async fn create_map(app: &Router, token: &str, name: &str) -> String {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/network-map/maps",
            token,
            json!({ "name": name }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response_json(response).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

async fn create_node(app: &Router, token: &str, map_id: &str, label: &str) -> String {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/network-map/nodes",
            token,
            json!({ "map_id": map_id, "label": label }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response_json(response).await["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn edge_endpoints_must_belong_to_the_same_map() {
    let (app, token, pool) = setup_app().await;
    let first_map = create_map(&app, &token, "First").await;
    let second_map = create_map(&app, &token, "Second").await;
    let source = create_node(&app, &token, &first_map, "Source").await;
    let target = create_node(&app, &token, &second_map, "Target").await;

    let response = app
        .oneshot(json_request(
            "POST",
            "/network-map/edges",
            &token,
            json!({
                "source_node_id": source,
                "target_node_id": target,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);

    let edge_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM map_edges")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(edge_count.0, 0);
}

#[tokio::test]
async fn edge_map_id_must_match_its_endpoint_nodes() {
    let (app, token, _) = setup_app().await;
    let map_id = create_map(&app, &token, "Main").await;
    let other_map_id = create_map(&app, &token, "Other").await;
    let source = create_node(&app, &token, &map_id, "Source").await;
    let target = create_node(&app, &token, &map_id, "Target").await;

    let response = app
        .oneshot(json_request(
            "POST",
            "/network-map/edges",
            &token,
            json!({
                "map_id": other_map_id,
                "source_node_id": source,
                "target_node_id": target,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn node_geometry_and_colors_are_validated_at_the_api_boundary() {
    let (app, token, _) = setup_app().await;
    let map_id = create_map(&app, &token, "Main").await;

    let response = app
        .oneshot(json_request(
            "POST",
            "/network-map/nodes",
            &token,
            json!({
                "map_id": map_id,
                "color": "red",
                "width": 1,
                "x": 2_000_000,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn duplicate_and_delete_keep_map_graph_consistent() {
    let (app, token, pool) = setup_app().await;
    let map_id = create_map(&app, &token, "Main").await;
    let source = create_node(&app, &token, &map_id, "Source").await;
    let target = create_node(&app, &token, &map_id, "Target").await;
    let edge_response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/network-map/edges",
            &token,
            json!({
                "source_node_id": source,
                "target_node_id": target,
            }),
        ))
        .await
        .unwrap();
    assert_eq!(edge_response.status(), StatusCode::CREATED);

    let duplicate_response = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/network-map/maps/{map_id}/duplicate"),
            &token,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(duplicate_response.status(), StatusCode::OK);
    let duplicate_id = response_json(duplicate_response).await["id"]
        .as_str()
        .unwrap()
        .to_string();

    let duplicate_counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM map_nodes WHERE map_id = ?), (SELECT COUNT(*) FROM map_edges WHERE map_id = ?)",
    )
    .bind(&duplicate_id)
    .bind(&duplicate_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(duplicate_counts, (2, 1));

    let delete_response = app
        .oneshot(json_request(
            "DELETE",
            &format!("/network-map/maps/{map_id}"),
            &token,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(delete_response.status(), StatusCode::NO_CONTENT);
    let original_counts: (i64, i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM network_maps WHERE id = ?), (SELECT COUNT(*) FROM map_nodes WHERE map_id = ?), (SELECT COUNT(*) FROM map_edges WHERE map_id = ?)",
    )
    .bind(&map_id)
    .bind(&map_id)
    .bind(&map_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(original_counts, (0, 0, 0));
}
