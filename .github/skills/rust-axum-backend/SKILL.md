---
name: rust-axum-backend
description: 'Use when: changing Netrix backend-rs Rust Axum routers, AppState, SQLx handlers, errors, logging, network tools, or backend services.'
---

# Rust Axum Backend

## Purpose

Guide backend changes in `backend-rs/`, the Rust Axum sidecar that owns APIs, database access, vault, protocol sessions, SFTP, logs, and network tools.

## Rules

- Keep backend bound to `127.0.0.1` and token-authenticated.
- Add endpoints in the nearest `routers/*.rs` module.
- Return `AppResult<T>` and use `AppError` for client-facing failures.
- Use SQLx `.bind(...)`; never interpolate user input into SQL.
- Do not return plaintext credentials or vault secrets in DTOs.
- Use `tracing` and avoid logging sensitive payloads.

## Architecture Guidance

- Shared runtime state belongs in `auth::AppState` only when it is a true cross-router service.
- DTOs and row structs belong in `models.rs`.
- Domain logic should move out of handlers when it is reused or complex.
- Migration changes must update both `backend-rs/migrations/` and `db.rs`.

## Coding Standards

- Validate request data before network calls or database writes.
- Prefer explicit helper functions for validation.
- Map duplicate names or conflicts to `AppError::Conflict` when useful to the UI.
- Keep async I/O under Tokio and avoid blocking calls outside `spawn_blocking`.

## Anti-Patterns

- `unwrap` or `expect` in request handlers.
- Logging request bodies for vault, credentials, snippets, or uploads.
- Adding a migration file without registering it.
- Expanding CORS or disabling auth for convenience.

## Example

When adding a new host field: update the migration, `Host`, `HostCreate`, `HostOut`, validation in `routers/hosts.rs`, frontend `Host` interface, and host form payload. Then run `npm run check:backend` and `npm run test:backend`.