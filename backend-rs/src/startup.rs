//! Before password entry there is no database pool or protected application router.
use crate::{
    auth::{self, AppState},
    database_encryption::{StartupMode, Storage},
    error::AppError,
    models::UnlockRequest,
    security, ssh, vault,
};
use axum::{
    body::to_bytes,
    extract::{Request, State},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use serde_json::json;
use std::sync::{Arc, OnceLock};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use tower::ServiceExt;
use zeroize::Zeroizing;

pub struct Startup {
    storage: Arc<Storage>,
    token: String,
    active: OnceLock<ActiveWorkspace>,
    opening: Arc<Mutex<()>>,
    limiter: auth::VaultUnlockLimiter,
}

struct ActiveWorkspace {
    router: Router,
    monitor: tokio::task::AbortHandle,
    // Tests must await SQLx worker termination before the process tears down
    // SQLCipher. Dropping a pool only schedules connection cleanup.
    #[cfg(test)]
    db: crate::db::Db,
}

pub fn router(storage: Arc<Storage>, token: String) -> Router {
    router_with_state(storage, token).0
}

fn router_with_state(storage: Arc<Storage>, token: String) -> (Router, Arc<Startup>) {
    let startup = Arc::new(Startup {
        storage,
        token,
        active: OnceLock::new(),
        opening: Arc::new(Mutex::new(())),
        limiter: auth::VaultUnlockLimiter::new(),
    });
    (
        Router::new().fallback(dispatch).with_state(startup.clone()),
        startup,
    )
}

async fn dispatch(State(startup): State<Arc<Startup>>, request: Request) -> Response {
    if let Some(active) = startup.active.get() {
        return match active.router.clone().oneshot(request).await {
            Ok(response) => response,
            Err(never) => match never {},
        };
    }
    let supplied = request
        .headers()
        .get("X-API-Token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if startup.token.is_empty() || !bool::from(startup.token.as_bytes().ct_eq(supplied.as_bytes()))
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"detail":"Forbidden: Invalid API Token"})),
        )
            .into_response();
    }
    match (request.method(), request.uri().path()) {
        (&Method::GET, "/health") => Json(json!({"status":"ok"})).into_response(),
        (&Method::GET, "/security/status") => startup.snapshot().into_response(),
        (&Method::POST, "/security/unlock") => {
            // A 1024-byte password can expand sixfold through JSON escapes.
            let body = match to_bytes(request.into_body(), 8192).await {
                Ok(body) => Zeroizing::new(body.to_vec()),
                Err(_) => {
                    return AppError::BadRequest("Unlock request is too large".into())
                        .into_response()
                }
            };
            let body: UnlockRequest = match serde_json::from_slice(&body) {
                Ok(body) => body,
                Err(_) => {
                    return AppError::BadRequest("Enter a master password".into()).into_response()
                }
            };
            let password = Zeroizing::new(body.master_password);
            let guard = match startup.opening.clone().try_lock_owned() {
                Ok(guard) => guard,
                Err(_) => {
                    return AppError::Conflict(
                        "The workspace is already opening; please wait".into(),
                    )
                    .into_response()
                }
            };
            // HTTP cancellation must not interrupt publication of a verified database.
            // Export/publication also does fsync and atomic filesystem moves.
            // Keep those off the async workers while SQLx/KDF await the runtime.
            let runtime = tokio::runtime::Handle::current();
            match tokio::task::spawn_blocking(move || {
                let _guard = guard;
                runtime.block_on(startup.open(&password))
            })
            .await
            {
                Ok(response) => response,
                Err(_) => AppError::Internal("Database opening task failed".into()).into_response(),
            }
        }
        _ => AppError::Locked.into_response(),
    }
}

impl Startup {
    fn snapshot(&self) -> Json<serde_json::Value> {
        Json(json!({"locked":true,"revision":0,"vault_unlocked":false,
            "vault_initialized":self.storage.mode != StartupMode::Setup,
            "database_mode":self.storage.mode.name(),
            "database_encrypted":self.storage.mode == StartupMode::Encrypted,
            "database_busy":self.opening.try_lock().is_err()}))
    }

    async fn open(&self, password: &str) -> Response {
        if self.active.get().is_some() {
            return AppError::Conflict("Workspace is already open; refresh and try again".into())
                .into_response();
        }
        if let Err(seconds) = self.limiter.check().await {
            return AppError::RateLimited(format!(
                "Too many failed attempts. Try again in {seconds} seconds."
            ))
            .into_response();
        }
        let (db, encryption, vault) = match self.storage.unlock(password).await {
            Ok(opened) => opened,
            Err(error) => {
                if error
                    .downcast_ref::<vault::VaultError>()
                    .is_some_and(|error| matches!(error, vault::VaultError::InvalidPassword))
                {
                    self.limiter.record_failure().await;
                    return AppError::Unauthorized("Invalid master password".into())
                        .into_response();
                }
                // Do not send SQL, row values or parser diagnostics to the renderer.
                tracing::error!("Encrypted workspace could not be opened: {error}");
                return AppError::BadRequest("Could not open the encrypted workspace. Existing data was preserved. Check the master password and workspace files, then retry.".into()).into_response();
            }
        };
        self.limiter.record_success().await;
        let known_hosts = ssh::known_hosts::KnownHostsStore::new();
        let sessions = ssh::SessionManager::with_known_hosts(known_hosts.clone());
        Arc::new(sessions.clone()).start_monitor();
        let state = AppState {
            database_encryption: Some(encryption),
            security: security::AppSecurity::default(),
            db,
            vault,
            api_token: self.token.clone(),
            sessions,
            sftp: ssh::SftpManager::with_known_hosts(known_hosts),
            quick_connect_tickets: auth::QuickConnectTicketStore::new(),
            vault_unlock_limiter: self.limiter.clone(),
        };
        state.security.unlock_after_verification().await;
        let monitor = security::start_monitor(state.clone()).abort_handle();
        if self
            .active
            .set(ActiveWorkspace {
                #[cfg(test)]
                db: state.db.clone(),
                router: crate::application::router(state),
                monitor: monitor.clone(),
            })
            .is_err()
        {
            monitor.abort();
            return AppError::Internal("Workspace activation was duplicated".into())
                .into_response();
        }
        Json(
            json!({"locked":false,"revision":1,"vault_unlocked":true,"vault_initialized":true,
            "database_mode":"open","database_encrypted":true,"database_busy":false}),
        )
        .into_response()
    }
}

impl Drop for Startup {
    fn drop(&mut self) {
        if let Some(active) = self.active.get() {
            active.monitor.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    const TOKEN: &str = "isolated-startup-token";
    const PASSWORD: &str = "isolated-startup-password";

    async fn close_workspace(app: Router, startup: Arc<Startup>) {
        let pool = startup.active.get().unwrap().db.clone();
        drop(app);
        drop(startup); // abort the security monitor before closing its pool

        // Queries return connections on background tasks. Own every connection
        // before closing the pool so those tasks cannot race its idle-queue drain.
        // Each explicit close awaits SQLite's worker shutdown and file release.
        let mut connections = Vec::new();
        for _ in 0..pool.options().get_max_connections() {
            connections.push(pool.acquire().await.unwrap());
        }
        for connection in connections {
            connection.close().await.unwrap();
        }
        pool.close().await;
        assert!(pool.is_closed());
    }

    async fn request(
        app: &Router,
        method: &str,
        path: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("X-API-Token", TOKEN)
                    .header("Content-Type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (
            status,
            if bytes.is_empty() {
                json!(null)
            } else {
                serde_json::from_slice(&bytes).unwrap()
            },
        )
    }

    #[tokio::test]
    async fn password_gate_rotation_reset_and_restart_preserve_the_workspace() {
        let dir =
            std::env::temp_dir().join(format!("netrix-startup-test-{}", uuid::Uuid::new_v4()));
        let storage = Storage::inspect(dir.clone()).await.unwrap();
        let (app, startup) = router_with_state(storage, TOKEN.into());
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/security/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            request(&app, "GET", "/health", json!(null)).await.0,
            StatusCode::OK
        );
        assert_eq!(
            request(&app, "GET", "/hosts", json!(null)).await.0,
            StatusCode::LOCKED
        );
        assert_eq!(
            request(
                &app,
                "POST",
                "/vault/reset",
                json!({"confirmation":"RESET VAULT"})
            )
            .await
            .0,
            StatusCode::LOCKED
        );
        assert!(
            !dir.join("database.db").exists(),
            "no database opens before password entry"
        );
        assert_eq!(
            request(
                &app,
                "POST",
                "/security/unlock",
                json!({"master_password":"short"})
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert!(!dir.join("database.db").exists());
        let (status, opened) = request(
            &app,
            "POST",
            "/security/unlock",
            json!({"master_password":PASSWORD}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{opened}");
        assert_eq!(opened["database_encrypted"], true);
        let (status, host) = request(&app, "POST", "/hosts", json!({"name":"preserved host","hostname":"203.0.113.19","username":"test","password":"test-only-device-secret"})).await;
        assert_eq!(status, StatusCode::CREATED, "{host}");
        let original_key_file =
            std::fs::read(dir.join(crate::database_encryption::KEY_FILE)).unwrap();
        let (status, _) = request(
            &app,
            "POST",
            "/vault/change-password",
            json!({"current_password":PASSWORD,"new_password":"я".repeat(513)}),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            std::fs::read(dir.join(crate::database_encryption::KEY_FILE)).unwrap(),
            original_key_file,
            "a password that startup cannot accept must not change any key wrapping"
        );
        let (status, rotated) = request(
            &app,
            "POST",
            "/vault/change-password",
            json!({"current_password":PASSWORD,"new_password":"new-workspace-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{rotated}");
        let (status, reset) = request(
            &app,
            "POST",
            "/vault/reset",
            json!({"confirmation":"RESET VAULT"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{reset}");
        assert_eq!(
            reset["initialized"], true,
            "reset preserves workspace password verifier"
        );
        close_workspace(app, startup).await;
        let storage = Storage::inspect(dir.clone()).await.unwrap();
        let (app, startup) = router_with_state(storage, TOKEN.into());
        assert_eq!(
            request(&app, "GET", "/hosts", json!(null)).await.0,
            StatusCode::LOCKED
        );
        assert_eq!(
            request(
                &app,
                "POST",
                "/security/unlock",
                json!({"master_password":PASSWORD})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
        let (status, opened) = request(
            &app,
            "POST",
            "/security/unlock",
            json!({"master_password":"new-workspace-password"}),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{opened}");
        let (status, hosts) = request(&app, "GET", "/hosts", json!(null)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(hosts[0]["name"], "preserved host");
        assert_eq!(hosts[0]["has_password"], false);
        close_workspace(app, startup).await;
        assert_eq!(dir.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(dir)
            .expect("closed workspace must release its Windows file handles");
    }
}
