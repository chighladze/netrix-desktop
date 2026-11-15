-- Add group_index column for custom host ordering within groups.
ALTER TABLE hosts ADD COLUMN group_index INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_hosts_group_index ON hosts("group", group_index);
