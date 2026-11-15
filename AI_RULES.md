# AI Rules for Netrix

These are mandatory project-specific rules for AI-assisted development in Netrix.

## Architectural Rules

- Preserve the three-part application: Tauri shell, React frontend, Rust Axum sidecar.
- Backend APIs remain localhost-only and token-authenticated.
- Interactive terminal traffic stays on WebSockets; CRUD, vault, SFTP, logs, network tools, snippets, quick actions, and maps stay on HTTP.
- SQLite remains the local persistence layer unless a migration plan is explicitly requested.
- SFTP is an SSH-only optional capability and must remain separate from active terminal transports.

## Source Ownership

- `src-tauri/src/main.rs`: process lifecycle, random port selection, API token generation, sidecar launch, Tauri IPC.
- `backend-rs/src/main.rs`: Axum app assembly, CORS, auth middleware, body limits, logging, server startup.
- `backend-rs/src/auth.rs`: HTTP token middleware and shared `AppState`.
- `backend-rs/src/db.rs`: SQLite pool type and embedded migrations; `database_encryption.rs` owns keyed pools, verified conversion and key recovery, while `startup.rs` gates database access on the master password.
- `backend-rs/src/models.rs`: SQLx row structs and API DTOs.
- `backend-rs/src/routers/`: endpoint handlers by feature.
- `backend-rs/src/ssh/manager.rs`: SSH/Telnet/Serial session lifecycle, detach, reattach, history, cleanup.
- `backend-rs/src/ssh/sftp.rs` and `ssh/sftp/`: isolated SFTP v3 protocol, streaming operations and connection pool; `ssh/sftp_transfers.rs` owns bounded transfer jobs.
- `backend-rs/src/vault.rs`: Argon2id and AES-256-GCM vault logic.
- `frontend/src/api.ts`: backend port/token discovery and authenticated fetch.
- `frontend/src/state/store.ts`: global app, settings, tabs, vault, SFTP, map, and UI state.
- `frontend/src/components/TerminalCanvas.tsx`: terminal/xterm/WebSocket behavior.

## Backend Development Standards

- Use `AppResult<T>` and `AppError` in handlers.
- Return frontend-readable failures as `{"detail": "message"}` through `AppError`.
- Validate request data before persistence or network activity.
- Use `.bind(...)` for every SQL value from requests, database rows, or user-controlled state.
- Keep SQL migrations idempotent where practical because current migrations use `CREATE TABLE IF NOT EXISTS` and tolerate existing columns during upgrades.
- When adding a migration, add `backend-rs/migrations/NNN_name.sql` and update the `migrations` vector in `backend-rs/src/db.rs`.
- Never return `password`, `private_key`, `passphrase`, decrypted vault plaintext, or key material in host/list DTOs.
- Avoid request-path panics. Tests may use `unwrap`; production handlers should not.
- Do not log secrets, command bodies, private keys, passphrases, vault plaintext, or raw uploaded/downloaded file contents.

## Frontend Development Standards

- Use `authenticatedFetch` for normal backend HTTP calls.
- Use `getApiBase`, `getWsBase`, and `getApiToken` rather than hard-coded ports or duplicated token logic.
- Use WebSocket subprotocol auth for terminal sessions: `netrix.v1` and `netrix-token.<token>`.
- Do not put credentials in localStorage. Settings, layout, collapsed groups, and display preferences may be stored there.
- Keep shared state in Zustand. Component state should stay local to rendering or transient interaction.
- Maintain API field compatibility with Rust DTOs. Backend JSON uses snake_case; TypeScript may map to camelCase for local UI state only when already established.
- Dispose xterm instances and close sockets on tab removal.
- Treat `App.tsx`, `TerminalCanvas.tsx`, and `store.ts` as fragile coordination files. Prefer local helpers over broad refactors.

## API Standards

- New endpoints go under the nearest existing router domain.
- Use stable path nouns that match existing route style: `/hosts`, `/vault/status`, `/sftp/hosts/{host_id}/list`, `/network-map/maps`.
- Keep saved-host APIs free of plaintext credentials in responses. Use boolean flags such as `has_password` and `has_private_key`.
- Use 201 for successful creates, 204 for successful deletes where no body is useful, and `AppError` status mappings for failures.
- WebSocket control payloads consumed by TerminalCanvas should keep the `__JSON__` prefix.

## Database Standards

- Tables and columns use snake_case.
- `hosts.group` is quoted as `"group"` in SQL because it is a reserved word in some contexts.
- Keep foreign keys and cascade behavior explicit in migrations.
- Add indexes for new high-frequency lookup fields.
- Do not store JSON blobs for data that must be queried frequently. JSON strings are currently used for flexible metadata and variables.

## Security Standards

- Backend must bind to `127.0.0.1` only.
- CORS must remain restricted to localhost, `127.0.0.1`, and Tauri origins.
- API token comparison must remain constant-time.
- Host key verification must default to strict TOFU. `SSH_KNOWN_HOSTS_POLICY=insecure` is a development/debug escape hatch.
- Vault master password change must re-encrypt existing secrets in place.
- Vault reset must remain destructive and confirmation-protected with `RESET VAULT`.
- SFTP uploads must remain bounded and explicit. Write to an exclusive sibling temporary file, verify CLOSE, and commit by rename. Replacements require explicit confirmation and negotiated atomic-rename support; never fall back to in-place truncation or delete-then-rename.
- Network scans must remain bounded by target validation, max ports, timeout limits, concurrency limits, and rate limits.
- Any Tauri capability expansion must be reviewed against desktop attack surface.

## Testing Rules

- Backend changes touching routers, validation, migrations, vault, session management, SFTP, or network tools need backend tests when feasible.
- Frontend changes must pass `npm run typecheck --prefix frontend` and `npm run build --prefix frontend` unless the user only requested documentation.
- Tauri config, capability, IPC, or shell lifecycle changes should pass `npm run check:tauri`.
- Full validation is `npm run check`, including backend clippy with warnings denied.
- If tests cannot be run, state the reason and the exact command that should be run later.

## Documentation Rules

- Update `docs/API_STRUCTURE.md` for route or payload changes.
- Update `docs/DATABASE_STRUCTURE.md` for migrations or schema behavior.
- Update `docs/SECURITY_RULES.md` for auth, vault, token, CORS, CSP, Tauri permission, filesystem, SQL, or API exposure changes.
- Update `docs/FRONTEND_STRUCTURE.md` for state or component architecture changes.
- Update `docs/BACKEND_STRUCTURE.md` for router/module/session/vault/SFTP changes.
- Update `.github/skills/` when a repeatable workflow changes.
