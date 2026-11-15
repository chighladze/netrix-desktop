//! Import concrete OpenSSH aliases without executing Include/ProxyCommand.
use crate::{
    auth::AppState,
    error::{AppError, AppResult},
};
use axum::{extract::State, routing::post, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ssh-config/preview", post(preview))
        .route("/ssh-config/import", post(import))
}
#[derive(Deserialize)]
struct Request {
    #[serde(default)]
    content: String,
    #[serde(default)]
    system: bool,
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    revision: Option<String>,
}
#[derive(Serialize, Deserialize, Debug)]
struct Candidate {
    alias: String,
    hostname: String,
    port: u16,
    username: String,
    identity_files: Vec<String>,
    supported: bool,
}
#[derive(Default)]
struct Block {
    patterns: Vec<String>,
    values: Vec<(String, String)>,
}

fn words(line: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    for c in line.chars() {
        if escaped {
            word.push(c);
            escaped = false;
            continue;
        }
        if c == '\\' && quote != Some('\'') {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.push(c);
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '#' => break,
            ' ' | '\t' | '=' => {
                if !word.is_empty() {
                    result.push(std::mem::take(&mut word));
                }
            }
            _ => word.push(c),
        }
    }
    if quote.is_some() || escaped {
        return Err("Unterminated quote or escape".into());
    }
    if !word.is_empty() {
        result.push(word);
    }
    Ok(result)
}
fn glob(pattern: &str, text: &str) -> bool {
    let pattern = pattern.to_lowercase();
    let text = text.to_lowercase();
    let (p, t) = (pattern.as_bytes(), text.as_bytes());
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < t.len() {
        if i < p.len() && (p[i] == b'?' || p[i] == t[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(at) = star {
            retry += 1;
            j = retry;
            i = at + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}
fn matches(patterns: &[String], alias: &str) -> bool {
    patterns
        .iter()
        .any(|p| !p.starts_with('!') && glob(p, alias))
        && !patterns
            .iter()
            .any(|p| p.strip_prefix('!').is_some_and(|p| glob(p, alias)))
}
fn parse(content: &str) -> AppResult<(Vec<Candidate>, Vec<String>)> {
    if content.len() > 1024 * 1024 {
        return Err(AppError::BadRequest("SSH config exceeds 1 MiB".into()));
    }
    let mut blocks = vec![Block {
        patterns: vec!["*".into()],
        values: vec![],
    }];
    let mut warnings = Vec::new();
    let mut match_block = false;
    for (line_number, line) in content.lines().enumerate() {
        let tokens = words(line).map_err(|message| {
            AppError::BadRequest(format!("Line {}: {message}", line_number + 1))
        })?;
        if tokens.is_empty() {
            continue;
        }
        let key = tokens[0].to_ascii_lowercase();
        if key == "host" {
            match_block = false;
            blocks.push(Block {
                patterns: tokens[1..].to_vec(),
                values: vec![],
            });
        } else if key == "match" {
            match_block = true;
            warnings.push(format!("Line {}: Match block skipped", line_number + 1));
        } else if key == "include" {
            warnings.push(format!(
                "Line {}: Include is not expanded; import that file separately",
                line_number + 1
            ));
        } else if !match_block && tokens.len() > 1 {
            if let Some(block) = blocks.last_mut() {
                block.values.push((key, tokens[1..].join(" ")));
            }
        }
        if blocks.len() > 1000 || warnings.len() > 1000 {
            return Err(AppError::BadRequest("Too many SSH config sections".into()));
        }
    }
    let mut aliases: Vec<_> = blocks
        .iter()
        .flat_map(|b| b.patterns.iter())
        .filter(|p| !p.contains(['*', '?']) && !p.starts_with('!'))
        .cloned()
        .collect();
    aliases.sort();
    aliases.dedup();
    let mut hosts = Vec::new();
    for alias in aliases {
        let mut values = HashMap::new();
        let mut identity_files = Vec::new();
        for block in &blocks {
            if !matches(&block.patterns, &alias) {
                continue;
            }
            for (key, value) in &block.values {
                if key == "identityfile" {
                    identity_files.push(value.clone());
                } else {
                    values.entry(key.clone()).or_insert(value.clone());
                }
            }
        }
        let mut supported = true;
        for key in ["proxyjump", "proxycommand"] {
            if values.get(key).is_some_and(|v| v != "none") {
                supported = false;
                warnings.push(format!(
                    "{alias}: {key} requires a proxy and cannot be imported as a direct connection"
                ));
            }
        }
        let hostname = values
            .get("hostname")
            .cloned()
            .unwrap_or_else(|| alias.clone())
            .replace("%h", &alias);
        let port = match values.get("port") {
            Some(value) => value.parse::<u16>().ok().filter(|p| *p > 0),
            None => Some(22),
        };
        if port.is_none() {
            supported = false;
            warnings.push(format!("{alias}: invalid port"));
        }
        let username = values.get("user").cloned().unwrap_or_else(|| {
            std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_default()
        });
        if hostname.is_empty()
            || hostname.chars().any(char::is_whitespace)
            || hostname.len() > 253
            || hostname.contains(['\0', '\r', '\n', ';', '|', '&', '$', '`', '%'])
            || alias.len() > 255
            || username.len() > 255
        {
            supported = false;
            warnings.push(format!("{alias}: invalid hostname or username"));
        }
        hosts.push(Candidate {
            alias,
            hostname,
            port: port.unwrap_or(22),
            username,
            identity_files,
            supported,
        });
    }
    Ok((hosts, warnings))
}
async fn content(body: &Request) -> AppResult<String> {
    if !body.system {
        return Ok(body.content.clone());
    }
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .ok_or_else(|| AppError::BadRequest("Home directory unavailable".into()))?;
    let path = std::path::PathBuf::from(home).join(".ssh/config");
    let size = tokio::fs::metadata(&path)
        .await
        .map_err(|_| AppError::NotFound("~/.ssh/config not found".into()))?
        .len();
    if size > 1024 * 1024 {
        return Err(AppError::BadRequest("SSH config exceeds 1 MiB".into()));
    }
    tokio::fs::read_to_string(path)
        .await
        .map_err(|_| AppError::BadRequest("Cannot read SSH config as UTF-8".into()))
}
async fn preview(Json(body): Json<Request>) -> AppResult<Json<Value>> {
    let content = content(&body).await?;
    let (hosts, warnings) = parse(&content)?;
    Ok(Json(
        json!({"hosts":hosts,"warnings":warnings,"revision":revision(&content)}),
    ))
}
fn revision(content: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hash);
    format!("{:016x}", hash.finish())
}
async fn import(State(st): State<AppState>, Json(body): Json<Request>) -> AppResult<Json<Value>> {
    let content = content(&body).await?;
    if (body.system || body.revision.is_some())
        && body.revision.as_deref() != Some(revision(&content).as_str())
    {
        return Err(AppError::Conflict(
            "SSH config changed; preview the import again".into(),
        ));
    }
    let (hosts, warnings) = parse(&content)?;
    if body.aliases.is_empty() || body.aliases.len() > 1000 {
        return Err(AppError::BadRequest("Select 1–1000 SSH aliases".into()));
    }
    let mut tx = st.db.begin().await?;
    let mut imported = 0;
    let mut skipped = Vec::new();
    for alias in &body.aliases {
        let host = hosts
            .iter()
            .find(|h| &h.alias == alias && h.supported)
            .ok_or_else(|| AppError::BadRequest(format!("Unsupported alias: {alias}")))?;
        let result=sqlx::query("INSERT INTO hosts(name,hostname,port,username,connection_type,\"group\") VALUES(?,?,?,?,'ssh','SSH Config') ON CONFLICT(name) DO NOTHING")
            .bind(&host.alias).bind(&host.hostname).bind(i64::from(host.port)).bind(&host.username).execute(&mut *tx).await?;
        if result.rows_affected() > 0 {
            imported += 1;
        } else {
            skipped.push(alias.clone());
        }
    }
    tx.commit().await?;
    Ok(Json(
        json!({"imported":imported,"skipped":skipped,"warnings":warnings}),
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_value_defaults_quotes_negation_and_proxy_are_respected() {
        let (hosts,warnings)=parse("Host prod other\n HostName \"server.example\" # comment\n User alice\n IdentityFile \"~/.ssh/key with spaces\"\nHost * !other\n Port 2222\nHost other\n ProxyJump gateway\nHost *\n Port 22\n User fallback\n").unwrap();
        let prod = hosts.iter().find(|h| h.alias == "prod").unwrap();
        assert_eq!(prod.port, 2222);
        assert_eq!(prod.username, "alice");
        assert_eq!(prod.hostname, "server.example");
        assert_eq!(prod.identity_files, ["~/.ssh/key with spaces"]);
        let other = hosts.iter().find(|h| h.alias == "other").unwrap();
        assert_eq!(other.port, 22);
        assert!(!other.supported);
        assert_eq!(warnings.len(), 1);
    }
    #[test]
    fn malformed_quotes_and_large_configs_are_rejected() {
        assert!(parse("Host \"oops").is_err());
        assert!(parse(&"x".repeat(1024 * 1024 + 1)).is_err());
    }
}
