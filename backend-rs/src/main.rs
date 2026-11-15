/// Netrix Backend — Rust entry point.
///
/// Starts the Axum backend:
/// - Reads API token from stdin
/// - Initialises database, vault, session manager
/// - Mounts all routers on an Axum HTTP server
/// - Monitors the parent Tauri process and exits when it dies
use std::io::BufRead;

use netrix_backend::{config, database_encryption, startup};
use tower::Layer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

mod startup_diagnostics;
use startup_diagnostics::{report, Stage};

fn is_allowed_cors_origin(origin: &axum::http::HeaderValue) -> bool {
    let Ok(origin) = origin.to_str() else {
        return false;
    };

    if matches!(origin, "tauri://localhost" | "asset://localhost") {
        return true;
    }

    let Some((scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    if !matches!(scheme, "http" | "https") {
        return false;
    }

    let authority = authority.split('/').next().unwrap_or(authority);
    if authority.is_empty() || authority.contains('@') {
        return false;
    }

    let (host, port) = authority
        .split_once(':')
        .map_or((authority, None), |(host, port)| (host, Some(port)));

    if let Some(port) = port {
        if port.is_empty() || port.parse::<u16>().is_err() {
            return false;
        }
    }

    matches!(host, "localhost" | "127.0.0.1" | "tauri.localhost")
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Read-only release evidence from the exact linked native library. This
    // command intentionally runs before SETTINGS, logging or profile creation.
    if std::env::args().nth(1).as_deref() == Some("--storage-build-info") {
        use sha2::Digest;
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await?;
        let (sqlite_version, sqlite_source_id): (String, String) =
            sqlx::query_as("SELECT sqlite_version(), sqlite_source_id()")
                .fetch_one(&pool)
                .await?;
        let (cipher_version,): (String,) = sqlx::query_as("PRAGMA cipher_version")
            .fetch_one(&pool)
            .await?;
        let binary_sha256 = hex::encode(sha2::Sha256::digest(std::fs::read(
            std::env::current_exe()?,
        )?));
        println!(
            "{}",
            serde_json::json!({"binary_sha256": binary_sha256, "sqlite_version": sqlite_version,
            "sqlite_source_id": sqlite_source_id, "cipher_version": cipher_version})
        );
        pool.close().await;
        return Ok(());
    }
    config::SETTINGS
        .initialize()
        .map_err(|error| report(Stage::DataDirectory, error))?;
    // ── Logging ─────────────────────────────────────────────────────
    let _log_file = config::SETTINGS.app_data_dir.join("backend.log");
    let file_appender =
        tracing_appender::rolling::never(config::SETTINGS.app_data_dir.clone(), "backend.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(non_blocking)
        .with_ansi(false)
        .init();

    info!("Initialising Netrix Backend (Rust)…");

    if config::SETTINGS
        .ssh_known_hosts_policy
        .eq_ignore_ascii_case("insecure")
    {
        warn!("SSH Security: host key verification is DISABLED (ssh_known_hosts_policy=insecure).");
    }

    // ── Parse CLI args ──────────────────────────────────────────────
    let args: Vec<String> = std::env::args().collect();
    let port: u16 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(8000);

    let parent_pid: Option<u32> = args.get(2).and_then(|s| s.parse().ok());

    // ── Read API token from stdin ───────────────────────────────────
    let api_token = {
        let stdin = std::io::stdin();
        let mut line = String::new();
        match stdin.lock().read_line(&mut line) {
            Ok(_) => line.trim().to_string(),
            Err(e) => {
                error!("Failed to read API token from stdin: {e}");
                String::new()
            }
        }
    };

    let api_token = if api_token.is_empty() {
        let token = hex::encode(rand::random::<[u8; 32]>());
        warn!("API Security: No token provided by parent. Generated ephemeral token for this run.");
        token
    } else {
        api_token
    };

    // No SQLite pool or workspace routes exist until the master password opens storage.
    let storage = database_encryption::Storage::inspect(config::SETTINGS.app_data_dir.clone())
        .await
        .map_err(|error| report(Stage::Workspace, error))?;
    let app = startup::router(storage, api_token).layer(
        CorsLayer::new()
            .allow_origin(AllowOrigin::predicate(|origin, _| {
                let allowed = is_allowed_cors_origin(origin);
                if !allowed {
                    warn!(
                        "Rejected CORS origin: {}",
                        origin.to_str().unwrap_or("<non-utf8-origin>")
                    );
                }
                allowed
            }))
            .allow_methods([
                axum::http::Method::GET,
                axum::http::Method::POST,
                axum::http::Method::PUT,
                axum::http::Method::PATCH,
                axum::http::Method::DELETE,
                axum::http::Method::OPTIONS,
            ])
            .allow_headers([
                axum::http::header::CONTENT_TYPE,
                axum::http::header::AUTHORIZATION,
                axum::http::header::ACCEPT,
                axum::http::header::ORIGIN,
                axum::http::header::HeaderName::from_static("x-api-token"),
            ])
            .expose_headers([
                axum::http::header::CONTENT_LENGTH,
                axum::http::header::CONTENT_DISPOSITION,
                axum::http::header::HeaderName::from_static("x-netrix-sftp-path"),
                axum::http::header::HeaderName::from_static("x-netrix-transfer-id"),
                axum::http::header::HeaderName::from_static("x-netrix-truncated"),
            ])
            .allow_credentials(true),
    );

    // Normalize trailing slashes BEFORE routing (must wrap outside the Router).
    let app = tower_http::normalize_path::NormalizePathLayer::trim_trailing_slash().layer(app);

    // ── Parent Process Monitor ──────────────────────────────────────
    spawn_parent_monitor(parent_pid);

    // ── Serve ───────────────────────────────────────────────────────
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    info!("Starting Netrix Backend on {addr}");
    info!("API Security: Token authentication ENABLED.");

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| report(Stage::Listener, error))?;
    // NormalizePath wraps the Router; Shared turns Service into MakeService for axum::serve.
    axum::serve(listener, tower::make::Shared::new(app))
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Shutdown complete.");
    Ok(())
}

/// Wait for Ctrl-C as a shutdown signal.
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
    info!("Received shutdown signal.");
}

/// Monitor the parent Tauri process and exit when it dies.
fn spawn_parent_monitor(pid: Option<u32>) {
    let pid = match pid {
        Some(p) if p > 1 => p,
        _ => return,
    };

    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
            const SYNCHRONIZE: u32 = 0x00100000;
            use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject};

            unsafe {
                let handle = OpenProcess(SYNCHRONIZE, 0, pid);
                if handle.is_null() {
                    info!("Cannot open parent process {pid}. Exiting.");
                    std::process::exit(0);
                }
                loop {
                    let result = WaitForSingleObject(handle, 2000);
                    if result == WAIT_OBJECT_0 {
                        info!("Tauri process {pid} exited. Shutting down backend…");
                        std::process::exit(0);
                    }
                }
            }
        }

        #[cfg(not(windows))]
        {
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                // On non-Windows, try /proc/PID or open() to check.
                let proc_path = format!("/proc/{pid}");
                if !std::path::Path::new(&proc_path).exists() {
                    info!("Tauri process {pid} exited. Shutting down backend…");
                    std::process::exit(0);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn cors_origin_requires_exact_localhost_host() {
        assert!(is_allowed_cors_origin(&HeaderValue::from_static(
            "http://localhost:3000"
        )));
        assert!(is_allowed_cors_origin(&HeaderValue::from_static(
            "https://127.0.0.1"
        )));
        assert!(is_allowed_cors_origin(&HeaderValue::from_static(
            "tauri://localhost"
        )));

        assert!(!is_allowed_cors_origin(&HeaderValue::from_static(
            "http://localhost.evil.test"
        )));
        assert!(!is_allowed_cors_origin(&HeaderValue::from_static(
            "https://127.0.0.1.evil.test"
        )));
        assert!(!is_allowed_cors_origin(&HeaderValue::from_static(
            "https://example.com"
        )));
    }
}
