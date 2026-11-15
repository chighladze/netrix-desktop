# Project Context

Netrix is a local-first desktop terminal client for network professionals. It manages SSH, Telnet, Serial, SFTP file operations, saved hosts, encrypted credentials, terminal tabs, snippets, quick actions, highlighting, recent connections, network maps, and network diagnostics.

## Technology Stack

- Desktop shell: Tauri 2.1 in `src-tauri/`.
- Frontend: React 18, TypeScript strict mode, Vite 6, Tailwind CSS, Zustand, xterm.js, Headless UI, dnd-kit, React Icons, Tauri APIs.
- Backend sidecar: Rust 2021, Axum 0.8, Tokio, SQLx SQLite, russh 0.65.1 with the documented RSA dependency compatibility patch, tokio-serial, rustls/x509-parser, AES-GCM, Argon2id, tracing.
- Database: local SQLCipher 4.20.0 encrypted SQLite with WAL mode and embedded schema migrations; SQLx 0.8 uses the pinned native compatibility adapter under `backend-rs/vendor/libsqlite3-sys`.
- CI: GitHub Actions runs backend formatting/check/clippy/tests, frontend unit tests/typecheck/build, Windows Tauri checks, Windows-target dependency audits, and a Windows desktop startup smoke test.
- Dependency updates: Dependabot covers backend Cargo, Tauri Cargo, frontend npm, and GitHub Actions.

## Runtime Responsibilities

- Tauri shell starts the backend sidecar, generates the API token, exposes IPC commands, owns plugin permissions, and packages the app.
- Frontend renders the desktop UI, keeps global app state in Zustand, mounts xterm for the selected terminal workspace, and keeps terminal transports alive through renderer-independent session controllers. After its first visit, the Terminal view retains its renderers while other modules are shown; restored tabs remain dormant until that visit.
- Backend owns persistence, credential encryption, protocol transports, terminal session lifecycle, SFTP, network tools, and API validation.

## Critical Business Flows

- Workspace startup: `startup.rs` initially allows only authenticated health/status/password entry. An explicit master password opens SQLCipher through `database_encryption.rs`; existing plaintext databases are verified and backed up in encrypted form before atomic replacement. Only then are application routes and frontend workspace content activated. Remembered Windows credentials cannot bypass startup. Recovery requires the matching `database.db`, `.database-key`, `.vault_salt` and master password.
- Connections: managed keys/identities reuse vault items and host credential links; OpenSSH config is previewed before import; Known Hosts exposes verified fingerprints and confirmation-protected removal; saved loopback local/SOCKS5 forwarding rules run over isolated SSH clients.
- Portable backup: an independent archive password protects a logical schema-6 snapshot; restore also accepts schema 5. Restore requires an unlocked destination vault and typed replacement confirmation, waits for in-flight HTTP operations, refuses active/connecting terminals/tunnels, commits all records atomically, and re-encrypts imported secrets with the destination key.
- Split terminals: TerminalWorkspace mounts one, two or four sessions with stable pane identity and active-pane shortcut routing; hidden transport controllers remain alive.
- Local files: an authenticated read-only filesystem panel can provide a selected file to the existing explicit SFTP upload flow.

- Saved host connection: frontend opens `/ws/terminal/{host_id}`, backend loads host data, optionally decrypts vault credentials, connects SSH/Telnet/Serial, then streams terminal bytes.
- Quick connect: frontend creates a short-lived `/sessions/quick-connect-tickets` payload over authenticated HTTP, then opens `/ws/quick-connect?ticket=...`. Credentials are never sent in the WebSocket URL.
- Vault unlock: frontend posts a master password, backend applies an in-memory invalid-attempt limiter, derives an Argon2id key, validates or bootstraps the check item, and stores the key in process memory until lock/reset/exit.
- SFTP Files: frontend selects an SSH host, backend opens a separate SSH/SFTP connection, probes/list/download/upload, and caches capability state in `host_capabilities`.
- Network tools: frontend Utility Hub calls bounded backend TCP scan or TLS inspection endpoints.
- Network maps: frontend manages map sheets, nodes, edges, auto-population, detach/reattach, and ping actions through `/network-map` APIs.

## Hidden Dependencies

- Tauri dev requires the debug backend binary at `backend-rs/target/debug/netrix_backend.exe` on Windows. Build it with `cargo build --manifest-path backend-rs/Cargo.toml` before `npm run tauri dev`.
- Production packaging runs the frontend build and `scripts/build-sidecar.mjs` from `src-tauri/tauri.conf.json`. Windows MSVC release sidecars use static CRT and `backend-rs/target/<triple>/release`, then `scripts/prepare-sidecar.mjs release` stages them. The NSIS runtime hook probes WebView2 before copying app files; details and validation are in `docs/WINDOWS_RELEASES.md`.
- Packaged runtime app data lives under Tauri's identifier-based `%APPDATA%/com.netrix.app` directory. On first upgraded launch, Tauri moves non-conflicting entries from the legacy `%APPDATA%/Netrix` directory without overwriting existing destination files. `NETRIX_DEV` still selects a `data` directory next to a directly launched backend executable.
- The backend token is not passed on the command line. Tauri writes it to sidecar stdin.
- Frontend dev server is fixed to port 3000 with `strictPort: true`.

## Reusable Patterns

- Backend routers return `AppResult<T>` and rely on `AppError` for status and `detail` JSON.
- API DTOs live in `backend-rs/src/models.rs`; row structs derive `sqlx::FromRow`.
- Frontend JSON calls should use `fetchJsonOrThrow<T>`; use `authenticatedFetch` directly only when response bytes or headers are part of the contract.
- WebSocket terminal control messages from backend use the `__JSON__` prefix.
- SQLite migrations are numbered SQL files embedded with `include_str!`.
- Tauri commands are exposed through `invoke` and kept minimal.

## Fragile Modules

- `frontend/src/App.tsx`: detached windows, map reattach, startup loading, vault prompts, and routing between views.
- `frontend/src/terminal/TerminalSessionController.ts`: WebSocket auth, heartbeat, connection/session lifecycle, reconnect, secret-bearing quick-connect state, and replay.
- `frontend/src/components/TerminalCanvas.tsx`: active xterm renderer lifecycle, visual progress, resize, search, clipboard, and vault prompts.
- `frontend/src/state/store.ts`: large Zustand store with settings, terminal tabs, SFTP, vault, map, groups, toasts, and persistence.
- `backend-rs/src/ssh/manager.rs`: cross-protocol session state machine, detach/reattach, circuit breaker, host key verification, cleanup monitor.
- `backend-rs/src/ssh/sftp.rs`: custom SFTP v3 packet implementation.
- `backend-rs/src/db.rs`: manual migration registry.
- `backend-rs/src/database_encryption.rs` / `startup.rs`: storage publication, wrapped-key recovery and the pre-database password gate; never fall back to an empty or unencrypted database on failure.

## Current Technical Debt

- Quick-connect credentials have moved to in-memory one-time tickets; keep regression coverage so they do not return to URLs.
- Frontend has focused API/store unit tests and a Windows desktop startup smoke test, but broad workflow coverage remains limited.
- Backend tests cover authenticated readiness, CRUD, vault, loopback terminal transports, SFTP protocol failures/limits and transfer jobs. An opt-in AsyncSSH smoke script verifies real SSH/SFTP interoperability; native desktop and device matrices still require manual QA.
- API documentation is markdown only; no generated OpenAPI schema exists.
- Input validation quality varies by router. Hosts and network tools are stronger than snippets, quick actions, highlighting, and parts of network maps.
- Tauri CSP still allows inline styles but no longer allows `unsafe-eval`.
- Tauri webviews have no shell permissions. Sidecar launch remains Rust-owned, and app commands/core permissions are scoped separately to main, detached-terminal, and detached-map window labels.
- Sensitive mutation endpoints beyond vault unlock do not all have dedicated rate limits.
- SFTP transfer jobs are implemented with acknowledged/read progress, explicit cancellation and bounded history. Safe upload, streaming and file mutations are detailed in `SFTP_IMPLEMENTATION.md`.
- Jump host fields exist in the schema, but traversal is not implemented. New saved-host terminal, SFTP, snippet and tunnel connections requiring a jump host are explicitly blocked before direct network access.
