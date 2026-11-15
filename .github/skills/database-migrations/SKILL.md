---
name: database-migrations
description: 'Use when: changing Netrix SQLite schema, SQLx row models, migrations, database indexes, host capabilities, vault items, maps, or persistence behavior.'
---

# Database Migrations

## Purpose

Guide safe SQLite schema changes for Netrix.

## Rules

- Add migrations under `backend-rs/migrations/` with the next numeric prefix.
- Register every migration in `backend-rs/src/db.rs`.
- Update SQLx row structs and API DTOs in `models.rs`.
- Use explicit indexes for new high-frequency lookups.
- Do not add plaintext credential columns.

## Architecture Guidance

- Portable backups currently identify schema version 8 (with schema 5/6/7 import compatibility) and explicitly enumerate tables/columns. Adding a migration must include a reviewed backup format migration or an explicit compatibility rejection; update the snapshot schema version and roundtrip/rollback tests together.

- Runtime database path comes from `config.rs`.
- Production storage opens only through `startup.rs` and `database_encryption.rs` after explicit master-password entry. Do not reintroduce an unkeyed disk pool or a fallback empty database. The raw recovery set is `database.db` + `.database-key` + `.vault_salt`; preserve all three and WAL consistency. SQLCipher conversion is a storage-format upgrade, separate from schema migrations, and must verify typed rows/schema plus an independently reopened encrypted recovery copy before atomic replacement.
- SQLite uses WAL, foreign keys, and a 4-connection pool.
- `_migrations` tracks applied versions.
- Current schema includes hosts, vault items, snippets, logs, quick actions, highlighting, recent connections, network maps, map nodes, map edges, and host capabilities.

- host_revision_counter is internal monotonic state, excluded from portable snapshots; preserve it during restore so stale editors cannot become valid when archived IDs return.

## Coding Standards

- Keep migrations idempotent where reasonable.
- Prefer simple SQL that works with SQLite.
- Quote `"group"` when touching the hosts group column.
- Add tests when a schema change affects API behavior.

## Anti-Patterns

- Editing an old migration after it has shipped.
- Adding a SQL file without registering it in Rust.
- Storing query-heavy domain data as opaque JSON.
- Forgetting frontend type updates for changed API payloads.

## Example

To add a host capability field, create `004_...sql`, register it in `db.rs`, update `HostCapabilityRow`/`HostCapabilityOut`, adjust router queries, and run backend check/tests.
