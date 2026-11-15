-- 004: Local shell support.
--
-- The existing `connection_type` column already accepts arbitrary TEXT,
-- so the 'local' kind needs no constraint change. This migration only
-- adds optional columns that describe how to spawn the local shell.
--
-- local_command : absolute path or bare executable name (e.g. "powershell.exe", "/bin/bash").
--                 When NULL or empty, the backend picks a platform default.
-- local_args    : JSON array of string arguments passed to the shell (no shell interpretation).
-- local_cwd     : working directory for the spawned process.

ALTER TABLE hosts ADD COLUMN local_command TEXT;
ALTER TABLE hosts ADD COLUMN local_args    TEXT;
ALTER TABLE hosts ADD COLUMN local_cwd     TEXT;
