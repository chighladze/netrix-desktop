-- Host capability cache for optional features such as SFTP.

CREATE TABLE IF NOT EXISTS host_capabilities (
    host_id     INTEGER NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    capability  TEXT    NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'unknown',
    reason      TEXT,
    checked_at  TEXT,
    expires_at  TEXT,
    PRIMARY KEY (host_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_host_capabilities_status ON host_capabilities(capability, status);