# Database Schema

Netrix uses local SQLite with versioned SQL migrations in
`backend-rs/migrations`.

## Migration Model

- `001_initial_schema.sql`: baseline tables and indexes.
- `002_add_group_index.sql`: adds `hosts.group_index` and related index.
- `_migrations` table tracks applied versions.

## Core Tables

### `hosts`

Connection profiles (SSH/Telnet/Serial), visual terminal preferences, optional
credential reference (`credential_id`), optional jump host (`jump_host_id`),
and legacy credential columns retained only as read-only migration input. On a
successful vault unlock, legacy values are encrypted into `vault_items`, linked
through `credential_id`, and cleared atomically. Runtime SSH/SFTP/snippet paths
never read those columns as credential fallbacks.

### `vault_items`

Encrypted secret blobs (`ciphertext`) plus metadata. Includes internal vault
check records used during unlock validation.

### `snippets`

Reusable command templates with optional JSON variables and optional default
host reference.

### `audit_logs`

Event log records (`event_type`, `details`, timestamp).

### `quick_actions`

User-defined command shortcuts for terminal sessions.

### `highlight_rules`

Keyword highlighting rules used by the frontend terminal renderer.

### `recent_connections`

Tracks recent host usage ordered by `connected_at`.

### `network_maps`, `map_nodes`, `map_edges`

Stores visual network map sheets, host-linked nodes, and edge metadata.

## Indexes

The schema includes indexes for frequently queried fields such as host names,
grouping columns, recent connection host lookups, and map graph references.

## Notes

- SQLite WAL mode is enabled at runtime.
- Foreign keys are enabled by connection options.
- New schema changes should be added as numbered migrations in
  `backend-rs/migrations` and registered in `db.rs`.
