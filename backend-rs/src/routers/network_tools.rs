/// Network tools — TCP scan & TLS inspection with rate limiting.
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::routing::post;
use axum::{Extension, Json, Router};
use futures::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, Semaphore};

use crate::auth::AppState;
use crate::error::{AppError, AppResult};

// ─── Rate Limiter ───────────────────────────────────────────────────

/// Simple token-bucket rate limiter shared across network-tool requests.
struct RateLimiter {
    tokens: f64,
    max_tokens: f64,
    refill_rate: f64, // tokens per second
    last_refill: Instant,
}

impl RateLimiter {
    fn new(max_tokens: f64, refill_rate: f64) -> Self {
        Self {
            tokens: max_tokens,
            max_tokens,
            refill_rate,
            last_refill: Instant::now(),
        }
    }

    fn try_acquire(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_rate).min(self.max_tokens);
        self.last_refill = now;

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

// Rate limits govern starts, not concurrent work. Both bounds are necessary.
struct ToolLimits {
    scans: Semaphore,
    inspections: Semaphore,
    probes: Semaphore,
    scan_rate: Mutex<RateLimiter>,
    tls_rate: Mutex<RateLimiter>,
}

impl ToolLimits {
    fn new() -> Self {
        Self {
            scans: Semaphore::new(4),
            inspections: Semaphore::new(8),
            probes: Semaphore::new(MAX_SCAN_CONCURRENCY),
            scan_rate: Mutex::new(RateLimiter::new(5.0, 0.5)),
            tls_rate: Mutex::new(RateLimiter::new(10.0, 1.0)),
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/network-tools/scan/tcp", post(tcp_scan))
        .route("/network-tools/tls/inspect", post(tls_inspect))
        .layer(Extension(Arc::new(ToolLimits::new())))
}

// ─── TCP Scan ───────────────────────────────────────────────────────

const MAX_SCAN_PORTS: usize = 1024;
const MAX_SCAN_CONCURRENCY: usize = 256;
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const SCAN_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
struct TcpScanRequest {
    target: String,
    #[serde(default = "default_ports")]
    ports: String,
    #[serde(default = "default_timeout_ms")]
    timeout_ms: u64,
    #[serde(default = "default_concurrency")]
    concurrency: usize,
}
fn default_ports() -> String {
    "22,80,443".into()
}
fn default_timeout_ms() -> u64 {
    450
}
fn default_concurrency() -> usize {
    128
}

#[derive(Debug, Serialize)]
struct OpenPort {
    port: u16,
    latency_ms: u64,
    service: Option<String>,
}

#[derive(Debug, Serialize)]
struct TcpScanResponse {
    target: String,
    resolved_ip: String,
    scanned_ports: usize,
    duration_ms: u64,
    open_ports: Vec<OpenPort>,
    note: String,
}

fn parse_ports(spec: &str) -> Result<Vec<u16>, AppError> {
    let mut ports = std::collections::BTreeSet::new();
    if spec.len() > 8192 {
        return Err(AppError::BadRequest(
            "Ports specification is too long".into(),
        ));
    }
    let cleaned = spec.trim();
    if cleaned.is_empty() {
        return Err(AppError::BadRequest("Ports list is empty".into()));
    }
    for token in cleaned.split(',').map(str::trim) {
        if token.is_empty() {
            continue;
        }
        if let Some((first, last)) = token.split_once('-') {
            let start: u16 = first
                .trim()
                .parse()
                .map_err(|_| AppError::BadRequest(format!("Invalid range: {token}")))?;
            let end: u16 = last
                .trim()
                .parse()
                .map_err(|_| AppError::BadRequest(format!("Invalid range: {token}")))?;
            if start < 1 || start > end {
                return Err(AppError::BadRequest(format!(
                    "Invalid range bounds: {token}"
                )));
            }
            for p in start..=end {
                ports.insert(p);
                if ports.len() > MAX_SCAN_PORTS {
                    return Err(AppError::BadRequest(format!(
                        "Too many ports requested. Max allowed: {MAX_SCAN_PORTS}"
                    )));
                }
            }
        } else {
            let p: u16 = token
                .parse()
                .map_err(|_| AppError::BadRequest(format!("Invalid port token: {token}")))?;
            if p < 1 {
                return Err(AppError::BadRequest(format!("Port out of range: {token}")));
            }
            ports.insert(p);
        }
        if ports.len() > MAX_SCAN_PORTS {
            return Err(AppError::BadRequest(format!(
                "Too many ports requested. Max allowed: {MAX_SCAN_PORTS}"
            )));
        }
    }
    if ports.is_empty() {
        return Err(AppError::BadRequest("No ports parsed".into()));
    }
    Ok(ports.into_iter().collect())
}

fn unbracketed_target(target: &str) -> &str {
    let trimmed = target.trim();
    trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed)
}

async fn resolve_ip(target: &str) -> Result<IpAddr, AppError> {
    let target = unbracketed_target(target);
    if let Ok(ip) = target.parse::<IpAddr>() {
        return Ok(ip);
    }

    tokio::time::timeout(DNS_TIMEOUT, tokio::net::lookup_host((target, 0)))
        .await
        .map_err(|_| AppError::BadRequest("DNS resolution timed out".into()))?
        .map_err(|_| AppError::BadRequest("Failed to resolve target host".into()))?
        .next()
        .map(|address| address.ip())
        .ok_or_else(|| AppError::BadRequest("Failed to resolve target host".into()))
}

fn service_name(port: u16) -> Option<String> {
    match port {
        22 => Some("ssh".into()),
        23 => Some("telnet".into()),
        25 => Some("smtp".into()),
        53 => Some("dns".into()),
        80 => Some("http".into()),
        110 => Some("pop3".into()),
        143 => Some("imap".into()),
        443 => Some("https".into()),
        993 => Some("imaps".into()),
        995 => Some("pop3s".into()),
        3306 => Some("mysql".into()),
        3389 => Some("rdp".into()),
        5432 => Some("postgresql".into()),
        6379 => Some("redis".into()),
        8080 => Some("http-alt".into()),
        _ => None,
    }
}

/// Validate that a scan/inspect target is not empty and is reasonable.
fn validate_target(target: &str) -> Result<(), AppError> {
    let t = target.trim();
    if t.is_empty() {
        return Err(AppError::BadRequest("Target cannot be empty".into()));
    }
    if t.len() > 253 {
        return Err(AppError::BadRequest("Target hostname too long".into()));
    }
    if unbracketed_target(t).parse::<IpAddr>().is_ok() {
        return Ok(());
    }
    // This is a host field, not a URL, socket address or shell command.
    let dns = t.strip_suffix('.').unwrap_or(t);
    if dns.split('.').any(|label| {
        label.is_empty()
            || label.len() > 63
            || !label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            || label.starts_with('-')
            || label.ends_with('-')
    }) {
        return Err(AppError::BadRequest(
            "Target contains invalid characters".into(),
        ));
    }
    Ok(())
}

/// Validate timeout bounds.
fn validate_timeout(ms: u64) -> Result<(), AppError> {
    if ms > 30_000 {
        return Err(AppError::BadRequest(
            "Timeout cannot exceed 30 seconds".into(),
        ));
    }
    if ms < 50 {
        return Err(AppError::BadRequest("Timeout must be at least 50ms".into()));
    }
    Ok(())
}

fn validate_concurrency(concurrency: usize) -> Result<usize, AppError> {
    if concurrency == 0 {
        return Err(AppError::BadRequest(
            "Concurrency must be at least 1".into(),
        ));
    }
    if concurrency > MAX_SCAN_CONCURRENCY {
        return Err(AppError::BadRequest(format!(
            "Concurrency cannot exceed {MAX_SCAN_CONCURRENCY}"
        )));
    }
    Ok(concurrency)
}

async fn tcp_scan(
    Extension(limits): Extension<Arc<ToolLimits>>,
    Json(body): Json<TcpScanRequest>,
) -> AppResult<Json<TcpScanResponse>> {
    validate_target(&body.target)?;
    validate_timeout(body.timeout_ms)?;
    let concurrency = validate_concurrency(body.concurrency)?;

    let ports = parse_ports(&body.ports)?;
    let _active = limits.scans.try_acquire().map_err(|_| {
        AppError::RateLimited("Four TCP scans are already running. Wait before retrying.".into())
    })?;
    if !limits.scan_rate.lock().await.try_acquire() {
        return Err(AppError::RateLimited(
            "Rate limit exceeded for TCP scan. Please wait before retrying.".into(),
        ));
    }
    let started = Instant::now();
    let deadline = tokio::time::Instant::now() + SCAN_DEADLINE;
    let resolved_ip = resolve_ip(&body.target).await?;
    let timeout = Duration::from_millis(body.timeout_ms);
    let probes = stream::iter(ports.iter().copied())
        .map(|p| {
            let limits = limits.clone();
            async move {
                let _permit = limits.probes.acquire().await.ok()?;
                let start = Instant::now();
                let addr = SocketAddr::new(resolved_ip, p);
                match tokio::time::timeout(timeout, TcpStream::connect(addr)).await {
                    Ok(Ok(stream)) => {
                        let _ = stream.into_std(); // drop
                        let latency = start.elapsed().as_millis() as u64;
                        Some(OpenPort {
                            port: p,
                            latency_ms: latency,
                            service: service_name(p),
                        })
                    }
                    _ => None,
                }
            }
        })
        .buffer_unordered(concurrency)
        .filter_map(|value| async { value })
        .collect::<Vec<_>>();
    // Futures remain owned by this request; dropping it/deadline drops every probe.
    let mut open_ports = tokio::time::timeout_at(deadline, probes).await
        .map_err(|_| AppError::BadRequest("TCP scan exceeded the 60-second total limit. Try fewer ports or a shorter per-port timeout.".into()))?;
    open_ports.sort_by_key(|p| p.port);

    Ok(Json(TcpScanResponse {
        target: body.target,
        resolved_ip: resolved_ip.to_string(),
        scanned_ports: ports.len(),
        duration_ms: started.elapsed().as_millis() as u64,
        open_ports,
        note: "Use only on hosts you are authorized to assess.".into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    fn scan_body(target: &str, ports: &str) -> TcpScanRequest {
        TcpScanRequest {
            target: target.into(),
            ports: ports.into(),
            timeout_ms: 50,
            concurrency: 2,
        }
    }

    #[test]
    fn port_specs_are_bounded_deduplicated_and_do_not_join_digits() {
        assert_eq!(
            parse_ports("22, 80, 79 - 81,22").unwrap(),
            vec![22, 79, 80, 81]
        );
        assert_eq!(parse_ports("1-1024").unwrap().len(), 1024);
        for input in ["", ",", "0", "65536", "22,2 3", "5-1", "1-65535", "1-2-3"] {
            assert!(parse_ports(input).is_err(), "{input}");
        }
        assert!(parse_ports(&"22,".repeat(3000)).is_err());
    }

    #[test]
    fn targets_are_hostnames_or_ip_literals_not_urls_or_socket_addresses() {
        for input in [
            "localhost",
            "router.local.",
            "srv_internal",
            "127.0.0.1",
            "[::1]",
            "::1",
        ] {
            assert!(validate_target(input).is_ok(), "{input}");
        }
        for input in [
            "",
            "http://localhost",
            "localhost:22",
            "[hostname]",
            "a b",
            "a\0b",
            "a;b",
            "a..b",
            "-host",
        ] {
            assert!(validate_target(input).is_err(), "{input}");
        }
    }

    #[tokio::test]
    async fn invalid_input_does_not_consume_rate_or_active_capacity() {
        let limits = Arc::new(ToolLimits::new());
        for _ in 0..10 {
            assert!(
                tcp_scan(Extension(limits.clone()), Json(scan_body("", "22")))
                    .await
                    .is_err()
            );
        }
        assert_eq!(limits.scan_rate.lock().await.tokens, 5.0);
        assert_eq!(limits.scans.available_permits(), 4);
        let _blocked = limits.scans.acquire_many(4).await.unwrap();
        assert!(matches!(
            tcp_scan(
                Extension(limits.clone()),
                Json(scan_body("127.0.0.1", "22"))
            )
            .await,
            Err(AppError::RateLimited(_))
        ));
        assert_eq!(limits.scan_rate.lock().await.tokens, 5.0);
    }

    #[tokio::test]
    async fn loopback_scan_reports_an_actual_open_port_and_refused_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let open = listener.local_addr().unwrap().port();
        let closed_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed = closed_listener.local_addr().unwrap().port();
        drop(closed_listener);
        let limits = Arc::new(ToolLimits::new());
        let result = tcp_scan(
            Extension(limits.clone()),
            Json(scan_body("127.0.0.1", &format!("{closed},{open},{open}"))),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(result.scanned_ports, 2);
        assert_eq!(result.resolved_ip, "127.0.0.1");
        assert_eq!(
            result.open_ports.iter().map(|p| p.port).collect::<Vec<_>>(),
            vec![open]
        );
        assert_eq!(limits.scans.available_permits(), 4);
        assert_eq!(limits.probes.available_permits(), 256);
    }

    #[tokio::test]
    async fn dropping_a_scan_cancels_queued_probes_instead_of_dialing_later() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let body = scan_body(
            "127.0.0.1",
            &listener.local_addr().unwrap().port().to_string(),
        );
        let limits = Arc::new(ToolLimits::new());
        let blocked = limits.probes.acquire_many(256).await.unwrap();
        let worker_limits = limits.clone();
        let worker =
            tokio::spawn(async move { tcp_scan(Extension(worker_limits), Json(body)).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while limits.scans.available_permits() == 4 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
        drop(blocked);
        assert_eq!(limits.probes.available_permits(), 256);
        assert_eq!(limits.scans.available_permits(), 4);
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn stalled_tls_handshake_times_out_and_closes_the_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let _ = socket.read_to_end(&mut bytes).await;
            assert!(!bytes.is_empty());
        });
        let limits = Arc::new(ToolLimits::new());
        let result = tls_inspect(
            Extension(limits.clone()),
            Json(TlsInspectRequest {
                target: "127.0.0.1".into(),
                port,
                server_name: Some("localhost".into()),
                timeout_ms: 200,
            }),
        )
        .await;
        assert!(
            matches!(result, Err(AppError::BadRequest(message)) if message.contains("timed out"))
        );
        assert_eq!(limits.inspections.available_permits(), 8);
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
    }

    #[test]
    fn scan_concurrency_must_be_positive_and_bounded() {
        assert!(validate_concurrency(0).is_err());
        assert_eq!(validate_concurrency(1).unwrap(), 1);
        assert_eq!(
            validate_concurrency(MAX_SCAN_CONCURRENCY).unwrap(),
            MAX_SCAN_CONCURRENCY
        );
        assert!(validate_concurrency(MAX_SCAN_CONCURRENCY + 1).is_err());
    }

    #[test]
    fn ipv6_targets_are_unbracketed_and_form_socket_addresses_safely() {
        assert_eq!(unbracketed_target("[2001:db8::1]"), "2001:db8::1");
        let ip: IpAddr = "2001:db8::1".parse().unwrap();
        assert_eq!(SocketAddr::new(ip, 443).to_string(), "[2001:db8::1]:443");
    }
}

// ─── TLS Inspection ─────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct TlsInspectRequest {
    target: String,
    #[serde(default = "default_tls_port")]
    port: u16,
    server_name: Option<String>,
    #[serde(default = "default_tls_timeout")]
    timeout_ms: u64,
}
fn default_tls_port() -> u16 {
    443
}
fn default_tls_timeout() -> u64 {
    2000
}

#[derive(Debug, Serialize)]
struct TlsInspectResponse {
    target: String,
    port: u16,
    resolved_ip: String,
    server_name: String,
    tls_version: String,
    cipher: String,
    subject: String,
    issuer: String,
    not_before: String,
    not_after: String,
    days_remaining: i64,
    san: Vec<String>,
}

async fn tls_inspect(
    Extension(limits): Extension<Arc<ToolLimits>>,
    Json(body): Json<TlsInspectRequest>,
) -> AppResult<Json<TlsInspectResponse>> {
    validate_target(&body.target)?;
    validate_timeout(body.timeout_ms)?;

    if body.port == 0 {
        return Err(AppError::BadRequest(
            "Port must be between 1 and 65535".into(),
        ));
    }

    let _active = limits.inspections.try_acquire().map_err(|_| {
        AppError::RateLimited(
            "Eight TLS inspections are already running. Wait before retrying.".into(),
        )
    })?;
    if !limits.tls_rate.lock().await.try_acquire() {
        return Err(AppError::RateLimited(
            "Rate limit exceeded for TLS inspection. Please wait before retrying.".into(),
        ));
    }
    tokio::time::timeout(Duration::from_millis(body.timeout_ms), inspect_tls(body))
        .await
        .map_err(|_| {
            AppError::BadRequest(
                "TLS inspection timed out (including DNS, connection and handshake)".into(),
            )
        })?
}

async fn inspect_tls(body: TlsInspectRequest) -> AppResult<Json<TlsInspectResponse>> {
    let target = unbracketed_target(&body.target).to_string();
    let port = body.port;
    let sni = unbracketed_target(body.server_name.as_deref().unwrap_or(&target)).to_string();
    let timeout = Duration::from_millis(body.timeout_ms);

    // Build a rustls connector.
    let mut root_store = rustls::RootCertStore::empty();
    root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();
    let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));

    let server_name: rustls_pki_types::ServerName<'_> = sni
        .as_str()
        .try_into()
        .map_err(|e| AppError::BadRequest(format!("Invalid server name: {e}")))?;

    let resolved_ip = resolve_ip(&target).await?;
    let addr = SocketAddr::new(resolved_ip, port);
    let tcp = tokio::time::timeout(timeout, TcpStream::connect(addr))
        .await
        .map_err(|_| AppError::BadRequest("Connection timed out".into()))?
        .map_err(|e| AppError::BadRequest(format!("Network error: {e}")))?;

    let tls = tokio::time::timeout(timeout, connector.connect(server_name.to_owned(), tcp))
        .await
        .map_err(|_| AppError::BadRequest("TLS handshake timed out".into()))?
        .map_err(|e| AppError::BadRequest(format!("TLS inspection failed: {e}")))?;

    let (_, conn) = tls.get_ref();
    let certs = conn
        .peer_certificates()
        .ok_or_else(|| AppError::BadRequest("No peer certificates".into()))?;
    if certs.is_empty() {
        return Err(AppError::BadRequest("No certificates in chain".into()));
    }

    let tls_version = match conn.protocol_version() {
        Some(rustls::ProtocolVersion::TLSv1_2) => "TLSv1.2",
        Some(rustls::ProtocolVersion::TLSv1_3) => "TLSv1.3",
        _ => "unknown",
    };
    let cipher = conn
        .negotiated_cipher_suite()
        .map(|c| format!("{:?}", c.suite()))
        .unwrap_or_else(|| "unknown".into());

    // Parse the leaf certificate.
    let leaf = &certs[0];
    let (_, cert) = x509_parser::parse_x509_certificate(leaf.as_ref())
        .map_err(|e| AppError::BadRequest(format!("Certificate parse error: {e}")))?;

    let subject = cert.subject().to_string();
    let issuer = cert.issuer().to_string();
    let not_before = cert
        .validity()
        .not_before
        .to_rfc2822()
        .unwrap_or_else(|_| cert.validity().not_before.to_string());
    let not_after = cert
        .validity()
        .not_after
        .to_rfc2822()
        .unwrap_or_else(|_| cert.validity().not_after.to_string());
    let now = chrono::Utc::now().timestamp();
    let expires_at = cert.validity().not_after.timestamp();
    let days_remaining = (expires_at - now) / 86400;

    // Extract SANs.
    let mut san = Vec::new();
    if let Ok(Some(ext)) = cert.subject_alternative_name() {
        for name in &ext.value.general_names {
            if let x509_parser::extensions::GeneralName::DNSName(dns) = name {
                san.push(dns.to_string());
            } else if let x509_parser::extensions::GeneralName::IPAddress(bytes) = name {
                match bytes.len() {
                    4 => san.push(
                        std::net::Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]).to_string(),
                    ),
                    16 => {
                        if let Ok(octets) = <[u8; 16]>::try_from(*bytes) {
                            san.push(std::net::Ipv6Addr::from(octets).to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    Ok(Json(TlsInspectResponse {
        target: body.target,
        port,
        resolved_ip: resolved_ip.to_string(),
        server_name: sni,
        tls_version: tls_version.into(),
        cipher,
        subject,
        issuer,
        not_before,
        not_after,
        days_remaining,
        san,
    }))
}
