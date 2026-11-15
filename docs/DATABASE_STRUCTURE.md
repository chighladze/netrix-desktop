# Database Structure

Netrix uses local SQLite through SQLx. The database path is computed in `backend-rs/src/config.rs` and packaged Windows builds use `%APPDATA%/com.netrix.app/database.db`, matching the Tauri bundle identifier. Upgraded launches migrate compatible data from legacy `%APPDATA%/Netrix`; when `NETRIX_DEV` is set, the backend uses a local `data` directory next to the executable.

## Runtime Settings

- WAL mode is enabled.
- Production storage uses SQLCipher 4.20.0 (SQLite 3.54.1); all database pages and WAL payloads are encrypted. SQLite temporary storage is memory-only.
- Synchronous mode is `Full`.
- Busy timeout is 5 seconds; conflicting legacy processes must close before conversion.
- Foreign keys are enabled.
- `secure_delete=ON` overwrites deleted SQLite cell content.
- Pool max connections is 4.

## Encrypted storage and existing installations

`startup.rs` exposes only authenticated health, security status and password entry
until `database_encryption.rs` opens the workspace. There is no production pool
before the master password is verified. First use confirms a new password; an
existing vault uses its current password. Remembered vault credentials do not
open the database automatically.

A random 256-bit SQLCipher key is wrapped by Argon2id (64 MiB, 3 passes, 4 lanes),
HKDF-SHA256 domain separation and AES-256-GCM. The versioned `.database-key` file
contains only salt and authenticated ciphertext. The existing `.vault_salt` and
inner vault encryption are retained. Lost/corrupt key files or an unexpectedly
missing encrypted database stop startup; they never trigger empty replacement.

Legacy conversion takes an exclusive SQLite lock, checkpoints WAL into DELETE
journal mode, validates the old password without changing source rows and exports
to a separate encrypted file. It checks SQLite/cipher integrity, foreign keys and
SHA-256 fingerprints of every typed row and schema object, including internal
tables, migration markers, triggers and sequence counters. `user_version` and
`application_id` are copied explicitly. A separately reopened and verified
`encryption-backup-<uuid>/` recovery set contains `database.db`, `.database-key`
and `.vault_salt`. Only then does a same-volume atomic replacement publish the
encrypted working database. There is no persistent plaintext recovery copy.
Interrupted pre-publication attempts leave the source authoritative and retry
from it; unpublished encrypted temporary files are never promoted blindly.
Inactive sidecars are removed only after verification; live WAL/journals stop
replacement. `.database-lock` excludes a second current Netrix process.

Keep all three recovery files together, and retain the password used when that
backup was made. Portable encrypted exports remain the preferred transfer format.
Do not open the new file with an older Netrix build or ordinary SQLite, delete
its key file, or copy a live database without handling its WAL.

Password changes stage both encrypted wraps of the same random database key,
commit vault rotation transactionally, then retain only the current wrap. After
a crash between these steps startup checks the vault verifier before accepting
either password and removes the uncommitted/obsolete wrap. Previously copied
key files remain usable with their historical passwords because the database
key itself is unchanged; password rotation does not revoke offline key copies.
Vault reset in an encrypted workspace deletes saved secrets but preserves its master-password
verifier, hosts, snippets and maps. It cannot recover a forgotten workspace
password. No application schema migration or portable archive version changed.

## Migration Model

Migrations live in `backend-rs/migrations/` and are embedded in `backend-rs/src/db.rs` with `include_str!`.

Current migrations:

- `001_initial_schema.sql`: hosts, vault items, snippets, audit logs, quick actions, highlight rules, recent connections, network maps, nodes, edges, and indexes.
- `002_add_group_index.sql`: `hosts.group_index` and group ordering index.
- `003_add_host_capabilities.sql`: optional feature capability cache, currently used for SFTP.
- `004_add_local_shell_fields.sql`: optional local shell command, argument, and working-directory fields.
- `005_ssh_tunnels.sql`: saved local TCP/SOCKS5 forwarding rules, a host foreign key with delete cascade, and a host lookup index. No active state or secrets are persisted in this table.
- `006_host_revisions.sql`: adds hosts.revision and an update trigger covering profile edits, credential binding/replacement, legacy migration and vault reset. Adds indexes for credential/jump references, snippet host dependencies and case-insensitive host ordering.

The `_migrations` table tracks applied migration versions.

`007_terminal_colors.sql` adds nullable `hosts.terminal_background` and `hosts.terminal_foreground`. Null inherits the selected terminal theme; non-null values use `#RRGGBB`. Existing profiles retain their theme and receive null overrides.
Each embedded SQL script and its `_migrations` marker execute in one transaction
through SQLx `raw_sql`; application code does not split scripts on semicolons.
A unit test compares every SQL file on disk with the embedded registry.

## Tables

- `hosts`: saved connection profiles, protocol, serial settings, grouping, optional `credential_id`, optional `jump_host_id`, terminal preferences, and legacy plaintext credential columns retained for compatibility.
- `vault_items`: encrypted secret blobs and metadata. Includes the internal vault check item.
- `snippets`: reusable command templates with JSON variables and optional default host.
- `audit_logs`: event log table. Reads exist; write coverage is not broad today.
- `quick_actions`: command shortcuts shown in terminal workflows.
- `highlight_rules`: keyword highlight definitions for terminal output.
- `recent_connections`: recent host activity with timestamps.
- `network_maps`: map sheets.
- `map_nodes`: map nodes, optionally linked to hosts.
- `map_edges`: map edges and connection metadata.
- `host_capabilities`: optional capability cache keyed by `(host_id, capability)`.
- `ssh_tunnels`: named SSH forwarding definitions; runtime connections and client sockets live only in memory.

Managed keys/identities reuse `vault_items`. Public metadata contains `managed:true`, type, optional username and public key; private keys/passphrases/passwords are encrypted in the existing ciphertext field. Hosts reuse `credential_id` to share one item. Automatic orphan cleanup preserves managed items; explicit deletion rejects linked credentials. Portable backups restore IDs and graph references transactionally, re-encrypting vault rows under the destination key and creating its own password-check row.

## Schema Standards

- Table and column names use snake_case.
- Quote `hosts."group"` in SQL.
- Use foreign keys for references and cascade deletes where the child should disappear with the parent.
- Add indexes for list filters, joins, and high-frequency lookups.
- Store secrets only in `vault_items.ciphertext`.
- Do not add plaintext credential columns.

## Migration Checklist

1. Add `backend-rs/migrations/NNN_descriptive_name.sql`.
2. Register the migration in the `migrations` vector in `backend-rs/src/db.rs`.
3. Keep the migration safe for existing databases where possible.
4. Add or update SQLx row structs and DTOs in `backend-rs/src/models.rs`.
5. Add tests for new schema behavior when it affects APIs.
6. Run `npm run check:backend` and `npm run test:backend`.

## Risks

- Migration registration remains explicit, but an automated test fails when the SQL directory and registry drift.
- Some JSON text columns are flexible but not ideal for query-heavy data.
- Legacy `hosts.password` and `hosts.private_key` remain in the schema only as upgrade input. Successful vault unlock encrypts and clears them atomically, then performs best-effort `VACUUM` plus a truncating WAL checkpoint to remove SQLite-level remnants.

Portable snapshots export schema 8. Restore supports schema 5 by adding revision and schema 5/6 by adding null terminal color overrides, and schema 5/6/7 by adding null terminal appearance, validates the complete column set, canonicalizes groups and recomputes credential-presence flags from the portable secret before re-encryption. Restored host revisions exceed both current and archive revisions. Unsupported schemas and invalid references roll back the entire restore.

Migration 006 also owns host_revision_counter, an internal monotonic clock excluded from portable snapshots. Insert/update triggers issue fresh revisions, including after explicit ID restoration and restore. Counter changes roll back with the owning transaction.

`008_terminal_appearance.sql` adds nullable `hosts.terminal_appearance` as validated JSON text. Its typed API object contains renderer-only font, spacing, cursor and palette overrides; it is not queried as domain data and contains no shell commands or secrets. Existing hosts inherit unchanged renderer defaults.
