ALTER TABLE hosts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_hosts_credential_id ON hosts(credential_id);
CREATE INDEX IF NOT EXISTS idx_hosts_jump_host_id ON hosts(jump_host_id);
CREATE INDEX IF NOT EXISTS idx_snippets_host_id ON snippets(host_id);
CREATE INDEX IF NOT EXISTS idx_hosts_name_nocase ON hosts(name COLLATE NOCASE, id);

-- Internal clock survives deletes and workspace restores. It is deliberately
-- not portable user data, like _migrations. Reused SQLite IDs must never revive
-- an old editor's revision.
CREATE TABLE host_revision_counter (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL
);
INSERT INTO host_revision_counter(id,value) VALUES(1,0);

CREATE TRIGGER hosts_revision_after_insert
AFTER INSERT ON hosts
BEGIN
    UPDATE host_revision_counter SET value = MAX(value, NEW.revision) + 1 WHERE id = 1;
    UPDATE hosts SET revision = (SELECT value FROM host_revision_counter WHERE id = 1) WHERE id = NEW.id;
END;

-- Covers profile edits, credential binding, legacy migration and vault reset.
CREATE TRIGGER hosts_revision_after_update
AFTER UPDATE ON hosts
WHEN NEW.revision = OLD.revision
BEGIN
    UPDATE host_revision_counter SET value = MAX(value, OLD.revision) + 1 WHERE id = 1;
    UPDATE hosts SET revision = (SELECT value FROM host_revision_counter WHERE id = 1) WHERE id = NEW.id;
END;
