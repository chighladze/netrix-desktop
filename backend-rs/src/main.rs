use std::future::IntoFuture;
/// Netrix Backend — Rust entry point.
///
/// Starts the Axum backend:
/// - Reads API token from stdin
/// - Initialises database, vault, session manager
/// - Mounts all routers on an Axum HTTP server
/// - Uses the private parent pipe for app shutdown and parent-death detection
use std::io::BufRead;
use std::time::Duration;

use netrix_backend::{config, database_encryption, startup};
use tokio_util::sync::CancellationToken;
use tower::Layer;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info, warn};
use tracing_subscriber::EnvFilter;

mod parent_channel;
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

fn main() -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    // A blocking workspace migration/KDF cannot be aborted by Tokio. Normal
    // shutdown awaits it; the deadline must also bound runtime teardown.
    runtime.shutdown_timeout(Duration::from_millis(250));
    result
}

async fn run() -> anyhow::Result<()> {
    let mode = std::env::args().nth(1);
    // Read-only release evidence from the exact linked native library. This
    // command intentionally runs before SETTINGS, logging or profile creation.
    if mode.as_deref() == Some("--storage-build-info") {
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

    let managed = mode.as_deref() == Some("--managed");
    let stop = CancellationToken::new();
    let (port, api_token) = if managed {
        let Some(token) = parent_channel::receive_token(stop.clone()).await? else {
            return Ok(());
        };
        (0, token)
    } else {
        let port = mode.and_then(|port| port.parse().ok()).unwrap_or(8000);
        let mut token = String::new();
        std::io::stdin().lock().read_line(&mut token)?;
        let token = token.trim().to_owned();
        let token = if token.is_empty() {
            hex::encode(rand::random::<[u8; 32]>())
        } else {
            token
        };
        (port, token)
    };
    if stop.is_cancelled() {
        return Ok(());
    }

    let signal_stop = stop.clone();
    tokio::spawn(async move {
        match tokio::signal::ctrl_c().await {
            Ok(()) => signal_stop.cancel(),
            Err(error) => warn!(%error, "Could not register Ctrl+C handler"),
        }
    });
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

    // No SQLite pool or workspace routes exist until the master password opens storage.
    let directory = config::SETTINGS.app_data_dir.clone();
    let storage = if managed {
        database_encryption::Storage::inspect_on_startup(directory, &stop).await
    } else {
        database_encryption::Storage::inspect(directory)
            .await
            .map(Some)
    };
    let Some(storage) = storage.map_err(|error| report(Stage::Workspace, error))? else {
        return Ok(());
    };
    if stop.is_cancelled() {
        return Ok(());
    }
    let (app, workspace) = startup::router(storage, api_token, stop.clone());
    let app = app.layer(
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

    // ── Serve ───────────────────────────────────────────────────────
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| report(Stage::Listener, error))?;
    let address = listener.local_addr()?;
    info!(%address, "Netrix backend listening with token authentication");
    if managed {
        use std::io::Write;
        let mut stdout = std::io::stdout().lock();
        writeln!(stdout, "NETRIX_LISTENING:{}", address.port())?;
        stdout.flush()?;
    }
    // NormalizePath wraps the Router; Shared turns Service into MakeService for axum::serve.
    let mut server = tokio::spawn(
        axum::serve(listener, tower::make::Shared::new(app))
            .with_graceful_shutdown(stop.clone().cancelled_owned())
            .into_future(),
    );
    tokio::select! {
        biased;
        _ = stop.cancelled() => {},
        result = &mut server => return result?.map_err(Into::into),
    }

    info!("Shutdown requested");
    let drained = tokio::time::timeout(parent_channel::SHUTDOWN_TIMEOUT, async {
        // First signal workers that may otherwise keep an HTTP response open.
        // Wait for the listener to finish before joining tasks created by requests.
        let (result, ()) = tokio::join!(&mut server, workspace.stop_operations());
        workspace.close().await;
        result?
    })
    .await;
    match drained {
        Ok(result) => result?,
        Err(_) => {
            server.abort();
            error!("Shutdown timed out; some operations did not finish");
            anyhow::bail!("Backend shutdown timed out");
        }
    }

    info!("Shutdown complete.");
    Ok(())
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
