/// Data models — database row types and API schemas.
///
/// Uses sqlx row mapping for database rows and serde `Serialize`/`Deserialize`
/// for JSON I/O.
use serde::{Deserialize, Serialize};

macro_rules! from_sqlite_row {
    ($type:ident { $($field:ident),+ $(,)? }) => {
        impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for $type {
            fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
                use sqlx::Row;

                Ok(Self {
                    $($field: row.try_get(stringify!($field))?,)+
                })
            }
        }
    };
}

/// Local renderer preferences, never commands sent to a remote shell.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TerminalAppearance {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_weight_bold: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_height: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_blink: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bold_bright: Option<bool>,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub colors: std::collections::BTreeMap<String, String>,
}

impl TerminalAppearance {
    pub fn validate(&self) -> Result<(), crate::error::AppError> {
        let allowed_colors = [
            "black",
            "red",
            "green",
            "yellow",
            "blue",
            "magenta",
            "cyan",
            "white",
            "brightBlack",
            "brightRed",
            "brightGreen",
            "brightYellow",
            "brightBlue",
            "brightMagenta",
            "brightCyan",
            "brightWhite",
            "cursor",
            "selectionBackground",
        ];
        let invalid = self.font_family.as_ref().is_some_and(|s| {
            s.trim().is_empty() || s.encode_utf16().count() > 128 || s.chars().any(char::is_control)
        }) || [self.font_weight, self.font_weight_bold]
            .into_iter()
            .flatten()
            .any(|v| !(100..=900).contains(&v) || v % 100 != 0)
            || self
                .line_height
                .is_some_and(|v| !v.is_finite() || !(1.0..=2.0).contains(&v))
            || self
                .letter_spacing
                .is_some_and(|v| !v.is_finite() || !(-1.0..=5.0).contains(&v))
            || self
                .cursor_style
                .as_deref()
                .is_some_and(|v| !["block", "bar", "underline"].contains(&v))
            || self.colors.iter().any(|(key, color)| {
                !allowed_colors.contains(&key.as_str())
                    || color.len() != 7
                    || !color.starts_with('#')
                    || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            });
        if invalid {
            return Err(crate::error::AppError::BadRequest(
                "Invalid terminal appearance: check fonts, spacing, cursor and #RRGGBB colors"
                    .into(),
            ));
        }
        Ok(())
    }

    pub fn to_json(&self) -> Result<String, crate::error::AppError> {
        serde_json::to_string(self)
            .map_err(|error| crate::error::AppError::Internal(error.to_string()))
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Database Row Types (sqlx::FromRow)
// ═══════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize)]
pub struct Host {
    pub id: i64,
    pub revision: i64,
    pub name: String,
    pub hostname: String,
    pub port: i64,
    pub username: Option<String>,
    pub connection_type: String,
    pub serial_port: Option<String>,
    pub serial_speed: Option<i64>,
    pub group: Option<String>,
    pub credential_id: Option<i64>,
    pub jump_host_id: Option<i64>,
    pub terminal_theme: Option<String>,
    pub terminal_font_size: Option<i64>,
    pub terminal_background: Option<String>,
    pub terminal_foreground: Option<String>,
    pub terminal_appearance: Option<String>,
    /// Legacy database migration input only. Never use for authentication or
    /// write new values through application request paths.
    pub password: Option<String>,
    /// Legacy database migration input only. Never use for authentication or
    /// write new values through application request paths.
    pub private_key: Option<String>,
    pub local_command: Option<String>,
    pub local_args: Option<String>,
    pub local_cwd: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct VaultItemRow {
    pub id: i64,
    pub name: String,
    pub ciphertext: Vec<u8>,
    pub item_metadata: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SnippetRow {
    pub id: i64,
    pub title: String,
    pub template: String,
    pub variables: Option<String>,
    pub host_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditLogRow {
    pub id: i64,
    pub timestamp: Option<String>,
    pub event_type: String,
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QuickActionRow {
    pub id: String,
    pub label: String,
    pub command: String,
    pub color: String,
    pub category: String,
    pub description: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HighlightRuleRow {
    pub id: String,
    pub keyword: String,
    pub color: String,
    pub highlight_type: String,
    pub is_active: bool,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RecentConnectionRow {
    pub id: i64,
    pub host_id: i64,
    pub connected_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkMapRow {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MapNodeRow {
    pub id: String,
    pub map_id: Option<String>,
    pub host_id: Option<i64>,
    pub label: Option<String>,
    pub icon: String,
    pub x: i64,
    pub y: i64,
    pub color: String,
    pub width: i64,
    pub height: i64,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MapEdgeRow {
    pub id: String,
    pub map_id: Option<String>,
    pub source_node_id: String,
    pub target_node_id: String,
    pub label: Option<String>,
    pub color: String,
    pub stroke_width: i64,
    pub style: String,
    pub waypoints: Option<String>,
    pub ports_count: i64,
    pub connection_type: String,
    pub connection_properties: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HostCapabilityRow {
    pub host_id: i64,
    pub capability: String,
    pub status: String,
    pub reason: Option<String>,
    pub checked_at: Option<String>,
    pub expires_at: Option<String>,
}

from_sqlite_row!(Host {
    id,
    revision,
    name,
    hostname,
    port,
    username,
    connection_type,
    serial_port,
    serial_speed,
    group,
    credential_id,
    jump_host_id,
    terminal_theme,
    terminal_font_size,
    terminal_background,
    terminal_foreground,
    terminal_appearance,
    password,
    private_key,
    local_command,
    local_args,
    local_cwd,
});

from_sqlite_row!(VaultItemRow {
    id,
    name,
    ciphertext,
    item_metadata,
    created_at,
});

from_sqlite_row!(SnippetRow {
    id,
    title,
    template,
    variables,
    host_id,
});

from_sqlite_row!(AuditLogRow {
    id,
    timestamp,
    event_type,
    details,
});

from_sqlite_row!(QuickActionRow {
    id,
    label,
    command,
    color,
    category,
    description,
    created_at,
});

from_sqlite_row!(HighlightRuleRow {
    id,
    keyword,
    color,
    highlight_type,
    is_active,
    created_at,
});

from_sqlite_row!(RecentConnectionRow {
    id,
    host_id,
    connected_at,
});

from_sqlite_row!(NetworkMapRow {
    id,
    name,
    description,
    created_at,
    updated_at,
});

from_sqlite_row!(MapNodeRow {
    id,
    map_id,
    host_id,
    label,
    icon,
    x,
    y,
    color,
    width,
    height,
    created_at,
});

from_sqlite_row!(MapEdgeRow {
    id,
    map_id,
    source_node_id,
    target_node_id,
    label,
    color,
    stroke_width,
    style,
    waypoints,
    ports_count,
    connection_type,
    connection_properties,
    created_at,
});

from_sqlite_row!(HostCapabilityRow {
    host_id,
    capability,
    status,
    reason,
    checked_at,
    expires_at,
});

// ═══════════════════════════════════════════════════════════════════
//  API Request / Response Schemas
// ═══════════════════════════════════════════════════════════════════

// ─── Host ──

#[derive(Debug, Deserialize)]
pub struct HostCreate {
    pub name: String,
    pub hostname: String,
    #[serde(default = "default_port")]
    pub port: i64,
    pub username: Option<String>,
    #[serde(default = "default_ssh")]
    pub connection_type: String,
    pub serial_port: Option<String>,
    pub serial_speed: Option<i64>,
    pub group: Option<String>,
    pub jump_host_id: Option<i64>,
    pub terminal_theme: Option<String>,
    pub terminal_font_size: Option<i64>,
    pub terminal_background: Option<String>,
    pub terminal_foreground: Option<String>,
    pub terminal_appearance: Option<TerminalAppearance>,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub clear_credentials: Option<bool>,
    /// Local-shell only: executable path or PATH-resolved name.
    pub local_command: Option<String>,
    /// Local-shell only: argv (no shell interpretation). Stored as JSON.
    pub local_args: Option<Vec<String>>,
    /// Local-shell only: working directory.
    pub local_cwd: Option<String>,
}

fn default_port() -> i64 {
    22
}
fn default_ssh() -> String {
    "ssh".into()
}

/// Missing fields are preserved; explicit null clears nullable fields.
#[derive(Debug, Default)]
pub enum PatchField<T> {
    #[default]
    Missing,
    Set(Option<T>),
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for PatchField<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Option::<T>::deserialize(deserializer).map(Self::Set)
    }
}
impl<T> PatchField<T> {
    pub fn merge(self, previous: Option<T>) -> Option<T> {
        match self {
            Self::Missing => previous,
            Self::Set(value) => value,
        }
    }
}
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct HostUpdate {
    pub revision: Option<i64>,
    pub name: Option<String>,
    pub hostname: Option<String>,
    pub port: Option<i64>,
    pub username: PatchField<String>,
    pub connection_type: Option<String>,
    pub serial_port: PatchField<String>,
    pub serial_speed: PatchField<i64>,
    pub group: PatchField<String>,
    pub jump_host_id: PatchField<i64>,
    pub terminal_theme: PatchField<String>,
    pub terminal_font_size: PatchField<i64>,
    pub terminal_background: PatchField<String>,
    pub terminal_foreground: PatchField<String>,
    pub terminal_appearance: PatchField<TerminalAppearance>,
    pub local_command: PatchField<String>,
    pub local_args: PatchField<Vec<String>>,
    pub local_cwd: PatchField<String>,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub clear_credentials: Option<bool>,
}
impl HostUpdate {
    pub fn merge(self, host: &Host) -> HostCreate {
        HostCreate {
            name: self.name.unwrap_or_else(|| host.name.clone()),
            hostname: self.hostname.unwrap_or_else(|| host.hostname.clone()),
            port: self.port.unwrap_or(host.port),
            username: self.username.merge(host.username.clone()),
            connection_type: self
                .connection_type
                .unwrap_or_else(|| host.connection_type.clone()),
            serial_port: self.serial_port.merge(host.serial_port.clone()),
            serial_speed: self.serial_speed.merge(host.serial_speed),
            group: self.group.merge(host.group.clone()),
            jump_host_id: self.jump_host_id.merge(host.jump_host_id),
            terminal_theme: self.terminal_theme.merge(host.terminal_theme.clone()),
            terminal_font_size: self.terminal_font_size.merge(host.terminal_font_size),
            terminal_background: self
                .terminal_background
                .merge(host.terminal_background.clone()),
            terminal_foreground: self
                .terminal_foreground
                .merge(host.terminal_foreground.clone()),
            terminal_appearance: self.terminal_appearance.merge(
                host.terminal_appearance
                    .as_deref()
                    .and_then(|value| serde_json::from_str(value).ok()),
            ),
            local_command: self.local_command.merge(host.local_command.clone()),
            local_args: self.local_args.merge(
                host.local_args
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok()),
            ),
            local_cwd: self.local_cwd.merge(host.local_cwd.clone()),
            password: self.password,
            private_key: self.private_key,
            passphrase: self.passphrase,
            clear_credentials: self.clear_credentials,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct HostOut {
    pub id: i64,
    pub revision: i64,
    pub name: String,
    pub hostname: String,
    pub port: i64,
    pub username: String,
    pub connection_type: String,
    pub serial_port: Option<String>,
    pub serial_speed: Option<i64>,
    pub group: Option<String>,
    pub credential_id: Option<i64>,
    pub jump_host_id: Option<i64>,
    pub terminal_theme: Option<String>,
    pub terminal_font_size: Option<i64>,
    pub terminal_background: Option<String>,
    pub terminal_foreground: Option<String>,
    pub terminal_appearance: Option<TerminalAppearance>,
    pub has_password: bool,
    pub has_private_key: bool,
    pub local_command: Option<String>,
    pub local_args: Option<Vec<String>>,
    pub local_cwd: Option<String>,
}

impl HostOut {
    pub fn from_row(h: &Host) -> Self {
        Self {
            id: h.id,
            revision: h.revision,
            name: h.name.clone(),
            hostname: h.hostname.clone(),
            port: h.port,
            username: h.username.clone().unwrap_or_default(),
            connection_type: h.connection_type.clone(),
            serial_port: h.serial_port.clone(),
            serial_speed: h.serial_speed,
            group: h.group.clone(),
            credential_id: h.credential_id,
            jump_host_id: h.jump_host_id,
            terminal_theme: h.terminal_theme.clone(),
            terminal_font_size: h.terminal_font_size,
            terminal_background: h.terminal_background.clone(),
            terminal_foreground: h.terminal_foreground.clone(),
            terminal_appearance: h
                .terminal_appearance
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok()),
            has_password: h.password.as_ref().is_some_and(|s| !s.is_empty()),
            has_private_key: h.private_key.as_ref().is_some_and(|s| !s.is_empty()),
            local_command: h.local_command.clone(),
            local_args: h
                .local_args
                .as_deref()
                .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok()),
            local_cwd: h.local_cwd.clone(),
        }
    }
}

// ─── Vault ──

#[derive(Debug, Serialize)]
pub struct VaultItemOut {
    pub id: i64,
    pub name: String,
    pub item_metadata: serde_json::Value,
    pub created_at: Option<String>,
}

impl VaultItemOut {
    pub fn from_row(r: &VaultItemRow) -> Self {
        let meta = r
            .item_metadata
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Object(Default::default()));
        Self {
            id: r.id,
            name: r.name.clone(),
            item_metadata: meta,
            created_at: r.created_at.clone(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct UnlockRequest {
    pub master_password: String,
}

#[derive(Debug, Deserialize)]
pub struct VaultResetRequest {
    pub confirmation: String,
}

#[derive(Debug, Deserialize)]
pub struct VaultChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Deserialize)]
pub struct SecretCreateRequest {
    pub name: String,
    pub plaintext: String,
    pub metadata: Option<serde_json::Value>,
}

// ─── Snippet ──

#[derive(Debug, Deserialize)]
pub struct SnippetCreate {
    pub title: String,
    pub template: String,
    pub variables: Option<serde_json::Value>,
    pub host_id: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct SnippetUpdate {
    pub title: Option<String>,
    pub template: Option<String>,
    pub variables: PatchField<serde_json::Value>,
    pub host_id: PatchField<i64>,
}

#[derive(Debug, Serialize)]
pub struct SnippetOut {
    pub id: i64,
    pub title: String,
    pub template: String,
    pub variables: serde_json::Value,
    pub host_id: Option<i64>,
}

impl SnippetOut {
    pub fn from_row(r: &SnippetRow) -> Self {
        let vars = r
            .variables
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Object(Default::default()));
        Self {
            id: r.id,
            title: r.title.clone(),
            template: r.template.clone(),
            variables: vars,
            host_id: r.host_id,
        }
    }
}

// ─── Audit Log ──

#[derive(Debug, Serialize)]
pub struct AuditLogOut {
    pub id: i64,
    pub timestamp: Option<String>,
    pub event_type: String,
    pub details: serde_json::Value,
}

impl AuditLogOut {
    pub fn from_row(r: &AuditLogRow) -> Self {
        let d = r
            .details
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Object(Default::default()));
        Self {
            id: r.id,
            timestamp: r.timestamp.clone(),
            event_type: r.event_type.clone(),
            details: d,
        }
    }
}

// ─── Quick Action ──

#[derive(Debug, Deserialize)]
pub struct QuickActionCreate {
    pub id: String,
    pub label: String,
    pub command: String,
    #[serde(default = "default_gray")]
    pub color: String,
    #[serde(default = "default_general")]
    pub category: String,
    pub description: Option<String>,
}

fn default_gray() -> String {
    "gray".into()
}
fn default_general() -> String {
    "General".into()
}

#[derive(Debug, Deserialize)]
pub struct QuickActionUpdate {
    pub label: Option<String>,
    pub command: Option<String>,
    pub color: Option<String>,
    pub category: Option<String>,
    pub description: Option<String>,
}

// ─── Highlight Rule ──

#[derive(Debug, Deserialize)]
pub struct HighlightRuleCreate {
    pub id: String,
    pub keyword: String,
    pub color: String,
    #[serde(default = "default_background")]
    pub highlight_type: String,
    #[serde(default = "default_true")]
    pub is_active: bool,
}

fn default_background() -> String {
    "background".into()
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct HighlightRuleUpdate {
    pub keyword: Option<String>,
    pub color: Option<String>,
    pub highlight_type: Option<String>,
    pub is_active: Option<bool>,
}

// ─── Network Map ──

#[derive(Debug, Deserialize)]
pub struct MapSheetCreate {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MapSheetUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MapSheetOut {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub node_count: i64,
    pub edge_count: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MapNodeCreate {
    pub map_id: Option<String>,
    pub host_id: Option<i64>,
    pub label: Option<String>,
    #[serde(default = "default_icon")]
    pub icon: String,
    #[serde(default)]
    pub x: i64,
    #[serde(default)]
    pub y: i64,
    #[serde(default = "default_node_color")]
    pub color: String,
    #[serde(default = "default_width")]
    pub width: i64,
    #[serde(default = "default_height")]
    pub height: i64,
}

fn default_icon() -> String {
    "server".into()
}
fn default_node_color() -> String {
    "#3b82f6".into()
}
fn default_width() -> i64 {
    120
}
fn default_height() -> i64 {
    60
}

#[derive(Debug, Deserialize)]
pub struct MapNodeUpdate {
    pub map_id: Option<String>,
    pub host_id: Option<i64>,
    pub label: Option<String>,
    pub icon: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub color: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct MapNodeOut {
    pub id: String,
    pub map_id: Option<String>,
    pub host_id: Option<i64>,
    pub label: Option<String>,
    pub icon: String,
    pub x: i64,
    pub y: i64,
    pub color: String,
    pub width: i64,
    pub height: i64,
    pub host_name: Option<String>,
    pub host_hostname: Option<String>,
    pub host_connection_type: Option<String>,
    pub host_group: Option<String>,
    pub host_port: Option<i64>,
    pub host_username: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MapEdgeCreate {
    pub map_id: Option<String>,
    pub source_node_id: String,
    pub target_node_id: String,
    pub label: Option<String>,
    #[serde(default = "default_edge_color")]
    pub color: String,
    #[serde(default = "default_stroke")]
    pub stroke_width: i64,
    #[serde(default = "default_solid")]
    pub style: String,
    pub waypoints: Option<String>,
    #[serde(default = "default_one")]
    pub ports_count: i64,
    #[serde(default = "default_ethernet")]
    pub connection_type: String,
    pub connection_properties: Option<String>,
}

fn default_edge_color() -> String {
    "#4b5563".into()
}
fn default_stroke() -> i64 {
    2
}
fn default_solid() -> String {
    "solid".into()
}
fn default_one() -> i64 {
    1
}
fn default_ethernet() -> String {
    "ethernet".into()
}

#[derive(Debug, Deserialize)]
pub struct MapEdgeUpdate {
    pub label: Option<String>,
    pub color: Option<String>,
    pub stroke_width: Option<i64>,
    pub style: Option<String>,
    pub waypoints: Option<String>,
    pub ports_count: Option<i64>,
    pub connection_type: Option<String>,
    pub connection_properties: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MapEdgeOut {
    pub id: String,
    pub map_id: Option<String>,
    pub source_node_id: String,
    pub target_node_id: String,
    pub label: Option<String>,
    pub color: String,
    pub stroke_width: i64,
    pub style: String,
    pub waypoints: Option<String>,
    pub ports_count: i64,
    pub connection_type: String,
    pub connection_properties: Option<String>,
}

impl MapEdgeOut {
    pub fn from_row(e: &MapEdgeRow) -> Self {
        Self {
            id: e.id.clone(),
            map_id: e.map_id.clone(),
            source_node_id: e.source_node_id.clone(),
            target_node_id: e.target_node_id.clone(),
            label: e.label.clone(),
            color: e.color.clone(),
            stroke_width: e.stroke_width,
            style: e.style.clone(),
            waypoints: e.waypoints.clone(),
            ports_count: e.ports_count,
            connection_type: e.connection_type.clone(),
            connection_properties: e.connection_properties.clone(),
        }
    }
}

// ─── Host Capabilities / SFTP ──

#[derive(Debug, Clone, Serialize)]
pub struct HostCapabilityOut {
    pub host_id: i64,
    pub capability: String,
    pub status: String,
    pub reason: Option<String>,
    pub checked_at: Option<String>,
    pub expires_at: Option<String>,
    pub can_probe: bool,
}

impl HostCapabilityOut {
    pub fn unknown(host_id: i64, capability: &str, can_probe: bool) -> Self {
        Self {
            host_id,
            capability: capability.into(),
            status: "unknown".into(),
            reason: None,
            checked_at: None,
            expires_at: None,
            can_probe,
        }
    }

    pub fn unsupported(host_id: i64, capability: &str, reason: impl Into<String>) -> Self {
        Self {
            host_id,
            capability: capability.into(),
            status: "unsupported".into(),
            reason: Some(reason.into()),
            checked_at: None,
            expires_at: None,
            can_probe: false,
        }
    }

    pub fn from_row(row: HostCapabilityRow, can_probe: bool) -> Self {
        Self {
            host_id: row.host_id,
            capability: row.capability,
            status: row.status,
            reason: row.reason,
            checked_at: row.checked_at,
            expires_at: row.expires_at,
            can_probe,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SftpListOut {
    pub host_id: i64,
    pub path: String,
    pub entries: Vec<SftpEntryOut>,
}

#[derive(Debug, Serialize)]
pub struct SftpEntryOut {
    pub name: String,
    pub path: String,
    pub entry_type: String,
    pub size: Option<i64>,
    pub modified_at: Option<String>,
    pub permissions: Option<String>,
}
