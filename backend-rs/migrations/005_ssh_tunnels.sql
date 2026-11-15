CREATE TABLE IF NOT EXISTS ssh_tunnels (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    host_id INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('local','dynamic')),
    bind_port INTEGER NOT NULL CHECK(bind_port BETWEEN 0 AND 65535),
    destination_host TEXT,
    destination_port INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ssh_tunnels_host ON ssh_tunnels(host_id);
