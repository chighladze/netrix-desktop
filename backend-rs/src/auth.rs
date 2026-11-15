/// API token authentication middleware.
///
/// The backend reads a token from stdin at startup (written by the Tauri shell).
/// Every HTTP request must carry `X-API-Token` header with a matching value.
/// WebSocket upgrade requests authenticate via a token-bearing subprotocol.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{MatchedPath, Request};
use axum::http::{header::SEC_WEBSOCKET_PROTOCOL, HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

const QUICK_CONNECT_TICKET_TTL: Duration = Duration::from_secs(60);
const VAULT_UNLOCK_MAX_FAILURES: u32 = 5;
const VAULT_UNLOCK_FAILURE_WINDOW: Duration = Duration::from_secs(5 * 60);
const VAULT_UNLOCK_LOCKOUT: Duration = Duration::from_secs(30);
const WEBSOCKET_TOKEN_PROTOCOL_PREFIX: &str = "netrix-token.";
const TERMINAL_WEBSOCKET_ROUTE: &str = "/ws/terminal/{host_id}";
const QUICK_CONNECT_WEBSOCKET_ROUTE: &str = "/ws/quick-connect";
const RESUME_WEBSOCKET_ROUTE: &str = "/ws/sessions/{session_id}";

#[derive(Clone)]
pub struct StoredQuickConnectTicket {
    pub host_info: serde_json::Value,
    pub sid: Option<i64>,
    expires_at: Instant,
}

#[derive(Clone, Default)]
pub struct QuickConnectTicketStore {
    inner: Arc<Mutex<HashMap<String, StoredQuickConnectTicket>>>,
}

impl QuickConnectTicketStore {
    pub async fn clear(&self) {
        self.inner.lock().await.clear();
    }
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn issue(&self, host_info: serde_json::Value, sid: Option<i64>) -> (String, u64) {
        let ticket = hex::encode(rand::random::<[u8; 32]>());
        let mut tickets = self.inner.lock().await;
        let now = Instant::now();
        tickets.retain(|_, stored| stored.expires_at > now);
        tickets.insert(
            ticket.clone(),
            StoredQuickConnectTicket {
                host_info,
                sid,
                expires_at: now + QUICK_CONNECT_TICKET_TTL,
            },
        );
        (ticket, QUICK_CONNECT_TICKET_TTL.as_secs())
    }

    pub async fn consume(&self, ticket: &str) -> Option<StoredQuickConnectTicket> {
        let mut tickets = self.inner.lock().await;
        let now = Instant::now();
        tickets.retain(|_, stored| stored.expires_at > now);
        tickets
            .remove(ticket)
            .filter(|stored| stored.expires_at > now)
    }
}

/// Exclude other HTTP operations while replacing a workspace. Upgrade callbacks
/// acquire their own short lease before reading host data and registering a session.
pub async fn workspace_middleware(
    axum::extract::State(st): axum::extract::State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if request.uri().path() == "/backups/restore" {
        return next.run(request).await;
    }
    let Ok(guard) = st.sessions.workspace_gate().try_read_owned() else {
        return crate::error::AppError::Conflict(
            "Workspace restore is in progress; refresh and try again".into(),
        )
        .into_response();
    };
    let response = next.run(request).await;
    drop(guard);
    response
}

#[derive(Clone, Default)]
pub struct VaultUnlockLimiter {
    inner: Arc<Mutex<VaultUnlockLimitState>>,
}

#[derive(Default)]
struct VaultUnlockLimitState {
    failed_attempts: u32,
    first_failure_at: Option<Instant>,
    locked_until: Option<Instant>,
}

impl VaultUnlockLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn check(&self) -> Result<(), u64> {
        let mut state = self.inner.lock().await;
        let now = Instant::now();
        state.clear_expired(now);

        if let Some(locked_until) = state.locked_until {
            return Err(retry_after_secs(now, locked_until));
        }

        Ok(())
    }

    pub async fn record_success(&self) {
        let mut state = self.inner.lock().await;
        *state = VaultUnlockLimitState::default();
    }

    pub async fn record_failure(&self) -> Option<u64> {
        let mut state = self.inner.lock().await;
        let now = Instant::now();
        state.clear_expired(now);

        if state.first_failure_at.is_none() {
            state.first_failure_at = Some(now);
        }

        state.failed_attempts += 1;
        if state.failed_attempts >= VAULT_UNLOCK_MAX_FAILURES {
            let locked_until = now + VAULT_UNLOCK_LOCKOUT;
            state.failed_attempts = 0;
            state.first_failure_at = None;
            state.locked_until = Some(locked_until);
            Some(retry_after_secs(now, locked_until))
        } else {
            None
        }
    }
}

impl VaultUnlockLimitState {
    fn clear_expired(&mut self, now: Instant) {
        if let Some(locked_until) = self.locked_until {
            if locked_until <= now {
                self.locked_until = None;
            }
        }

        if let Some(first_failure_at) = self.first_failure_at {
            if now.duration_since(first_failure_at) > VAULT_UNLOCK_FAILURE_WINDOW {
                self.failed_attempts = 0;
                self.first_failure_at = None;
            }
        }
    }
}

fn retry_after_secs(now: Instant, until: Instant) -> u64 {
    let remaining = until.saturating_duration_since(now);
    let rounded = remaining
        .as_secs()
        .saturating_add(u64::from(remaining.subsec_nanos() > 0));
    rounded.max(1)
}

/// Shared application state accessible from all handlers.
#[derive(Clone)]
pub struct AppState {
    pub database_encryption: Option<Arc<crate::database_encryption::DatabaseEncryption>>,
    pub security: crate::security::AppSecurity,
    pub db: crate::db::Db,
    pub vault: crate::vault::SharedVault,
    pub api_token: String,
    pub sessions: crate::ssh::SessionManager,
    pub sftp: crate::ssh::SftpManager,
    pub quick_connect_tickets: QuickConnectTicketStore,
    pub vault_unlock_limiter: VaultUnlockLimiter,
}

/// Axum middleware that enforces API-token authentication.
pub async fn auth_middleware(
    state: axum::extract::State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    // CORS preflight — always pass through.
    if request.method() == axum::http::Method::OPTIONS {
        return next.run(request).await;
    }

    let token = &state.api_token;
    if token.is_empty() {
        return forbidden_response();
    }

    let provided_token = if is_terminal_websocket_route(&request) {
        websocket_protocol_token(request.headers())
    } else {
        request
            .headers()
            .get("X-API-Token")
            .and_then(|value| value.to_str().ok())
    };

    if token_is_valid(token, provided_token) {
        // Existing operations may finish, but no new API work may bypass the lock.
        let lock_control = matches!(
            (request.method().as_str(), request.uri().path()),
            ("GET", "/security/status" | "/vault/status")
                | ("POST", "/security/lock" | "/security/unlock")
        );
        if state.security.is_locked() && !lock_control {
            return crate::error::AppError::Locked.into_response();
        }
        next.run(request).await
    } else {
        tracing::warn!("Unauthorized access attempt to {}", request.uri().path());
        forbidden_response()
    }
}

fn is_terminal_websocket_route(request: &Request) -> bool {
    // Route identity is trusted router state. Client-controlled Upgrade headers
    // must never switch an ordinary HTTP endpoint to WebSocket authentication.
    request
        .extensions()
        .get::<MatchedPath>()
        .map(MatchedPath::as_str)
        .is_some_and(|path| {
            matches!(
                path,
                TERMINAL_WEBSOCKET_ROUTE | QUICK_CONNECT_WEBSOCKET_ROUTE | RESUME_WEBSOCKET_ROUTE
            )
        })
}

fn websocket_protocol_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .find_map(|protocol| protocol.strip_prefix(WEBSOCKET_TOKEN_PROTOCOL_PREFIX))
}

fn token_is_valid(expected: &str, provided: Option<&str>) -> bool {
    if expected.is_empty() {
        return false;
    }

    provided
        .unwrap_or("")
        .as_bytes()
        .ct_eq(expected.as_bytes())
        .into()
}

fn forbidden_response() -> Response {
    (
        StatusCode::FORBIDDEN,
        axum::Json(json!({"detail": "Forbidden: Invalid API Token"})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[tokio::test]
    async fn quick_connect_tickets_are_one_time() {
        let store = QuickConnectTicketStore::new();
        let (ticket, ttl) = store
            .issue(serde_json::json!({"hostname": "example.test"}), Some(42))
            .await;

        assert_eq!(ttl, QUICK_CONNECT_TICKET_TTL.as_secs());
        let first = store.consume(&ticket).await;
        assert_eq!(first.as_ref().and_then(|stored| stored.sid), Some(42));
        assert!(store.consume(&ticket).await.is_none());
    }

    #[tokio::test]
    async fn vault_unlock_limiter_blocks_after_repeated_failures() {
        let limiter = VaultUnlockLimiter::new();

        for attempt in 1..=VAULT_UNLOCK_MAX_FAILURES {
            assert!(limiter.check().await.is_ok());
            let locked = limiter.record_failure().await;
            if attempt < VAULT_UNLOCK_MAX_FAILURES {
                assert!(locked.is_none());
            } else {
                assert!(locked.is_some());
            }
        }

        assert!(limiter.check().await.is_err());
        limiter.record_success().await;
        assert!(limiter.check().await.is_ok());
    }

    #[test]
    fn websocket_protocol_token_supports_multiple_header_values() {
        let mut headers = HeaderMap::new();
        headers.append(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("netrix.v1"),
        );
        headers.append(
            SEC_WEBSOCKET_PROTOCOL,
            HeaderValue::from_static("chat, netrix-token.secret"),
        );

        assert_eq!(websocket_protocol_token(&headers), Some("secret"));
    }

    #[test]
    fn token_validation_handles_missing_match_and_mismatch() {
        assert!(!token_is_valid("", None));
        assert!(token_is_valid("secret", Some("secret")));
        assert!(!token_is_valid("secret", Some("wrong")));
        assert!(!token_is_valid("secret", None));
    }
}
