//! Protected application routes, mounted only after encrypted storage is open.
use crate::{
    auth::{self, AppState},
    routers,
};
use axum::{middleware, Router};

pub fn router(state: AppState) -> Router {
    Router::new()
        .merge(routers::health::router())
        .merge(routers::security::router())
        .merge(routers::credentials::router())
        .merge(routers::backups::router())
        .merge(routers::ssh_config::router())
        .merge(routers::tunnels::router())
        .merge(routers::local_files::router())
        .merge(routers::hosts::router())
        .merge(routers::sessions::router())
        .merge(routers::snippets::router())
        .merge(routers::logs::router())
        .merge(routers::network_tools::router())
        .merge(routers::quick_actions::router())
        .merge(routers::highlighting::router())
        .merge(routers::recent_connections::router())
        .merge(routers::vault::router())
        .merge(routers::network_map::router())
        .merge(routers::sftp::router())
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::workspace_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::auth_middleware,
        ))
        .with_state(state)
}
