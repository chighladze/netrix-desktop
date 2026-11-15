-- Initial schema (baseline).
-- This migration captures the original schema so that future changes can be tracked.
-- It uses CREATE TABLE IF NOT EXISTS so it is safe to run on existing databases.

CREATE TABLE IF NOT EXISTS hosts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL UNIQUE,
    hostname        TEXT    NOT NULL,
    port            INTEGER NOT NULL DEFAULT 22,
    username        TEXT,
    connection_type TEXT    NOT NULL DEFAULT 'ssh',
    serial_port     TEXT,
    serial_speed    INTEGER,
    "group"         TEXT,
    credential_id   INTEGER REFERENCES vault_items(id),
    jump_host_id    INTEGER REFERENCES hosts(id),
    terminal_theme  TEXT,
    terminal_font_size INTEGER,
    password        TEXT,
    private_key     TEXT
);

CREATE TABLE IF NOT EXISTS vault_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL,
    ciphertext      BLOB    NOT NULL,
    item_metadata   TEXT    DEFAULT '{}',
    created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snippets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    title           TEXT    NOT NULL,
    template        TEXT    NOT NULL,
    variables       TEXT    DEFAULT '{}',
    host_id         INTEGER REFERENCES hosts(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT    DEFAULT (datetime('now')),
    event_type      TEXT    NOT NULL,
    details         TEXT    DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS quick_actions (
    id              TEXT    PRIMARY KEY,
    label           TEXT    NOT NULL,
    command         TEXT    NOT NULL,
    color           TEXT    NOT NULL DEFAULT 'gray',
    category        TEXT    NOT NULL DEFAULT 'General',
    description     TEXT,
    created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS highlight_rules (
    id              TEXT    PRIMARY KEY,
    keyword         TEXT    NOT NULL,
    color           TEXT    NOT NULL,
    highlight_type  TEXT    NOT NULL DEFAULT 'background',
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recent_connections (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id         INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    connected_at    TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS network_maps (
    id              TEXT    PRIMARY KEY,
    name            TEXT    NOT NULL,
    description     TEXT,
    created_at      TEXT    DEFAULT (datetime('now')),
    updated_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS map_nodes (
    id              TEXT    PRIMARY KEY,
    map_id          TEXT    REFERENCES network_maps(id) ON DELETE CASCADE,
    host_id         INTEGER REFERENCES hosts(id) ON DELETE CASCADE,
    label           TEXT,
    icon            TEXT    NOT NULL DEFAULT 'server',
    x               INTEGER NOT NULL DEFAULT 0,
    y               INTEGER NOT NULL DEFAULT 0,
    color           TEXT    NOT NULL DEFAULT '#3b82f6',
    width           INTEGER NOT NULL DEFAULT 120,
    height          INTEGER NOT NULL DEFAULT 60,
    created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS map_edges (
    id              TEXT    PRIMARY KEY,
    map_id          TEXT    REFERENCES network_maps(id) ON DELETE CASCADE,
    source_node_id  TEXT    NOT NULL REFERENCES map_nodes(id) ON DELETE CASCADE,
    target_node_id  TEXT    NOT NULL REFERENCES map_nodes(id) ON DELETE CASCADE,
    label           TEXT,
    color           TEXT    NOT NULL DEFAULT '#4b5563',
    stroke_width    INTEGER NOT NULL DEFAULT 2,
    style           TEXT    NOT NULL DEFAULT 'solid',
    waypoints       TEXT,
    ports_count     INTEGER NOT NULL DEFAULT 1,
    connection_type TEXT    NOT NULL DEFAULT 'ethernet',
    connection_properties TEXT,
    created_at      TEXT    DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_hosts_name ON hosts(name);
CREATE INDEX IF NOT EXISTS idx_hosts_group ON hosts("group");
CREATE INDEX IF NOT EXISTS idx_vault_items_name ON vault_items(name);
CREATE INDEX IF NOT EXISTS idx_snippets_title ON snippets(title);
CREATE INDEX IF NOT EXISTS idx_recent_connections_host ON recent_connections(host_id);
CREATE INDEX IF NOT EXISTS idx_map_nodes_map ON map_nodes(map_id);
CREATE INDEX IF NOT EXISTS idx_map_edges_map ON map_edges(map_id);
CREATE INDEX IF NOT EXISTS idx_map_edges_source ON map_edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_map_edges_target ON map_edges(target_node_id);
