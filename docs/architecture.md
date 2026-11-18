# Architecture

Netrix is a local desktop app split into three cooperating parts: Tauri shell, React frontend, and Rust backend sidecar.

## Component Diagram

```mermaid
flowchart LR
  Tauri[Tauri shell\nsrc-tauri] -->|starts with token on stdin, closes pipe to stop| Backend[Axum backend\nbackend-rs]
  Backend -->|bound port on private stdout| Tauri
  Frontend[React frontend\nfrontend] -->|invoke get_backend_port/get_api_token| Tauri
  Frontend -->|HTTP X-API-Token| Backend
  Frontend -->|WebSocket subprotocol token| Backend
  Backend -->|master password required| SQLite[(SQLCipher encrypted SQLite)]
  Backend --> Vault[Vault crypto]
  Backend --> SSH[SSH/Telnet/Serial/SFTP]
```

## Runtime Components

Netrix runs as a local desktop application with three components:

1. Tauri shell (`src-tauri`) written in Rust.
2. React frontend (`frontend`) written in TypeScript.
3. Rust backend sidecar (`backend-rs`) written with Axum and Tokio.

The separate Rust process lets the shell observe a backend exit independently of the WebView and supervise the executable. It adds a process protocol, process cleanup, version matching and installer payload verification. Module boundaries and independent tests are also possible within one process. Performance and security depend on the implementation of those boundaries.

The Tauri shell starts the matching sidecar with `--managed` and writes a new, newline-terminated API token to its private stdin. The backend binds to `127.0.0.1:0` and writes `NETRIX_LISTENING:<port>` on private stdout. The frontend gets the verified port and token through Tauri IPC and connects to the backend over HTTP and WebSocket.

## Tauri Shell

`src-tauri/src/backend_process.rs` owns the child and its pipes on a worker thread. In development it launches `backend-rs/target/debug/netrix_backend.exe`. On Windows the NSIS bundle installs `netrix_backend.exe` next to the application, where the release shell resolves it by absolute path. The shell publishes `ready` only after an authenticated `GET /health` returns HTTP 200. It reports process exits through `get_backend_status` in both modes.

Tauri resolves `%APPDATA%/com.netrix.app`, migrates non-conflicting entries from the legacy `%APPDATA%/Netrix` directory, and passes the resolved path to the backend through `NETRIX_DATA_DIR`. Production shell logs use the same identifier-based directory.

## Shutdown and restart

1. The main window completes its existing close confirmation. Tauri defers the first exit request and sends one stop signal by dropping the private stdin writer. Closing a detached terminal or map only closes that window.
2. On EOF the backend stops listening and rejects new dispatches. It closes terminal WebSockets and their transports, stops tunnel listeners and cancels queued and running transfers. SFTP jobs already committing a rename retain their bounded acknowledgement window. The backend allows in-progress workspace opening and accepted HTTP requests to finish within the same deadline.
3. After HTTP drains, the backend waits for monitors, terminal cleanup and SFTP workers, clears the vault key and closes the SQLite pool. Process exit releases the workspace lock. A locked startup has no workspace pool to close.
4. The backend budgets 12 seconds for cooperative cleanup. The shell polls the owned process handle off the UI thread and attempts termination if the child is still alive after 15 seconds. It gives the OS a short window to confirm exit before letting Tauri close. Repeated exit requests share this sequence.

On Windows the shell attaches the child to an unnamed `KILL_ON_JOB_CLOSE` Job Object before delivering the token. A shell crash closes its Job handle and Windows kills the child and its job descendants. If Job setup fails, the shell logs the OS error and the private pipe still closes on parent exit. The backend watches it before opening the profile and has a separate 14-second watchdog from EOF. A forced stop can interrupt transactions and remote acknowledgement. SQLite recovery handles unfinished local transactions on the next open. Release of the OS lock does not require deleting its file.

A managed sidecar that encounters a held workspace lock retries on the same open
`.database-lock` handle every 100 ms for up to 15 seconds. A relaunch can wait
through the previous sidecar's 14-second EOF watchdog. The backend reads the
database and key envelope after obtaining the lock. Parent EOF cancels the wait.
Continued contention reaches `workspace_busy` with the original OS error.
Other storage errors are reported immediately. The 20-second shell readiness
budget and 25-second renderer polling limit leave time for inspection and
authenticated health after the lock is acquired.

## Frontend

The frontend is a Vite React app. The primary state container is `frontend/src/state/store.ts`. It stores hosts, tabs, renderer/socket mirrors used by the UI, settings, SFTP state, vault state, network-map state, groups, toasts, and recent connections.

The UI is composed from feature components in `frontend/src/components/`. `terminal/TerminalSessionController.ts` owns terminal transport, heartbeat, reconnect, session metadata, and bounded replay while `TerminalCanvas.tsx` owns the active xterm renderer. SFTP browsing is in `SftpBrowser.tsx`, settings in `Settings.tsx`, utilities in `UtilitiesHub.tsx`, and network topology is split between `NetworkMap.tsx` and pure helpers under `features/network-map/`.

## Backend Services

The backend is an Axum server bound to `127.0.0.1`. `backend-rs/src/main.rs` configures CORS, process lifecycle and the authenticated startup gate. `startup.rs` exposes only health, security status and password entry until the master password opens the encrypted database. It then creates vault/session/SFTP state and publishes the protected routes assembled in `application.rs`. The frontend keeps workspace content unmounted before this first unlock.

Major backend domains:

- `routers/health.rs`: authenticated readiness response used by the Tauri shell.
- `routers/hosts.rs`: host CRUD and credential attachment.
- `routers/sessions.rs`: terminal WebSocket endpoints.
- `routers/vault.rs`: vault unlock, lock, reset, password rotation, status, and item access.
- `routers/sftp.rs`: SFTP capability, probe, list, streaming transfer jobs, safe upload, cancellation and file mutations.
- `routers/network_tools.rs`: TCP scan and TLS inspection.
- `routers/network_map.rs`: map sheets, nodes, edges, duplicate, auto-populate, ping.
- `routers/snippets.rs`: command snippets and remote snippet execution.
- `routers/quick_actions.rs`: command shortcut CRUD.
- `routers/highlighting.rs`: terminal highlight rule CRUD.
- `routers/recent_connections.rs`: recent host usage.
- `routers/logs.rs`: audit log listing.
- `ssh/manager.rs`: SSH/Telnet/Serial sessions, detach, reattach, resize, cleanup, circuit breaker.
- `ssh/sftp.rs`: standalone SFTP v3 client.
- `ssh/telnet.rs`: minimal Telnet negotiation over TCP.
- `vault.rs`: Argon2id key derivation and AES-256-GCM encryption.
- `db.rs`: SQLite pool type and embedded schema migrations.
- `database_encryption.rs`: SQLCipher pool, wrapped database key, verified plaintext conversion and password-rotation recovery.
- `startup.rs` / `application.rs`: password gate and protected router composition.

## Protocol Support

Implemented connection protocols:

- SSH
- Telnet
- Serial

Protocol validation is enforced in host CRUD and quick-connect paths. Optional capabilities are tracked separately from connection protocols. SFTP is modeled as an SSH-only capability with cached states such as `unknown`, `supported`, `unsupported`, `auth_failed`, and `error`.

## Data Flow

### HTTP

HTTP handles CRUD and bounded file/network operations: hosts, snippets, vault actions, network map, logs, quick actions, highlighting, recent connections, SFTP capability/list/download/upload, and network tools.

### WebSocket

WebSocket handles interactive terminal traffic:

- `/ws/terminal/{host_id}` for saved hosts.
- `/ws/quick-connect?ticket=...` for one-off ephemeral sessions. The ticket is created first through authenticated HTTP at `/sessions/quick-connect-tickets`.

Each WebSocket session receives structured control messages (`progress`, `connect`, `error`, `disconnect`) and raw terminal payload. `TerminalSessionController` consumes `__JSON__` control messages, keeps the transport alive without a mounted renderer, and replays at most 2 MiB when the active renderer attaches.

## Session Lifecycle

1. Frontend creates a one-time quick-connect ticket when using ephemeral credentials, then opens a WebSocket with terminal size, terminal type, timeout, keepalive, and token subprotocol.
2. Backend resolves host configuration and credentials, using the vault when `credential_id` is present.
3. Session manager connects the protocol transport: SSH, Telnet, or Serial.
4. Backend streams terminal output through broadcast channels.
5. On detach, a live transport is preserved and can be reattached.
6. On close or terminate, session manager performs protocol-specific cleanup.

## SFTP Files Lifecycle

1. Frontend opens the Files workflow for an SSH host.
2. Backend reads unexpired cached `host_capabilities` state.
3. For a probe or operation, `SftpManager` leases an isolated SFTP connection from a bounded pool, with a deadline covering authentication and subsystem negotiation.
4. Directory listing initializes SFTP v3, resolves the requested path, opens the directory, reads entries, maps file metadata, and closes the handle.
5. File preview/download initializes SFTP v3, resolves the requested path, opens the file read-only, reads bounded chunks, closes the handle, and returns bytes through authenticated HTTP.
6. Upload streams to an exclusive sibling temporary file, checks FSTAT/fsync/CLOSE and commits by rename. Replacing a regular file requires explicit confirmation and atomic-rename support.
7. Capability status is stored in SQLite.
8. Existing terminal sessions are not reused or closed by SFTP operations.
9. Terminal SSH and SFTP SSH connections share the same in-process known-hosts store and on-disk `known_hosts` file.

SFTP jobs provide real progress and cancellation; Files also supports mkdir, rename, file/empty-directory delete and chmod. Folder recursion, synchronization and restart-resume are not implemented. See [SFTP implementation](SFTP_IMPLEMENTATION.md) for limits, cleanup and lifecycle details.

## Persistence

The SQLCipher-encrypted SQLite database lives in the app data directory. All tables and WAL payloads are encrypted; SQLite temporary storage stays in memory. A random database key is wrapped by the master password in `.database-key`, so an explicit password is required at every app start. The existing vault retains its own inner encryption.

- Schema is managed through versioned SQL migrations in `backend-rs/migrations`.
- Runtime migration state is tracked in `_migrations`.
- WAL mode is enabled for better concurrent behavior.
- Existing plaintext databases are exported, fully compared with the source and backed up in encrypted form before atomic replacement. Preserve `database.db`, `.database-key` and `.vault_salt` together for recovery; see [database storage](DATABASE_STRUCTURE.md).

## Security Boundaries

- Backend listens on `127.0.0.1` only.
- API token auth is required for HTTP and WebSocket endpoints.
- HTTP uses `X-API-Token`; WebSocket uses token-bearing subprotocol transport.
- Quick-connect credentials stay in authenticated HTTP request bodies and in-memory tickets, not WebSocket URLs.
- Vault keys are never persisted in plaintext and are zeroized on lock/drop.
- Restart protection covers SQLite metadata as well as credentials. A running application lock leaves the database pool and keys in RAM; closing Netrix releases them. Old plaintext backups, UI preferences, diagnostic logs, exports and known-host files are outside SQLite encryption.
- Vault unlock atomically migrates legacy plaintext host credentials into encrypted vault items before publishing the in-memory key; runtime transports never fall back to the legacy columns.
- SQLite `secure_delete`, a post-migration `VACUUM`, and a truncating WAL checkpoint remove legacy plaintext remnants visible at the SQLite file layer on a best-effort basis.
- Vault unlock has an in-memory failed-attempt limiter before expensive key verification.
- Host key verification behavior is configurable via `SSH_KNOWN_HOSTS_POLICY` and defaults to strict TOFU. Terminal and SFTP connections share host-key trust state.
- Tauri CSP blocks `unsafe-eval`, production builds omit the devtools feature, and no shell commands are exposed to webviews.
- App-command ACL and label-specific capabilities keep window creation/keychain access in `main`, clipboard access in `main` and `detached-*`, and a smaller event/window surface in `map-*`. `tab-preview-*` windows receive no IPC capability.

## Packaging and Deployment

- Development: `npm run tauri dev` plus debug backend sidecar.
- Production: frontend build plus release backend sidecar bundled into one NSIS installer by Tauri.
- Backend sidecar is managed by Tauri process lifecycle and terminated when the parent exits.

## Strong Parts

- Clear runtime separation between shell, UI, and backend sidecar.
- Localhost binding, per-session token auth, and restricted CORS are built in.
- Saved credentials are separated from host DTOs through vault-backed `credential_id` plus `has_password`/`has_private_key` flags.
- SQLite migrations are versioned and embedded in the backend binary.
- SSH host key verification uses TOFU by default with mismatch rejection, shared between Terminal and SFTP paths.
- SFTP operations are isolated from interactive terminal sessions.
- Quick-connect tickets and vault unlock rate limiting cover two high-risk credential paths.
- Backend uses parameterized SQLx queries throughout normal request paths.

## Weak Parts and Risks

- Large frontend coordination files increase regression risk.
- Frontend has focused API, readiness, store, terminal-controller, and network-map unit tests plus a Windows desktop startup smoke test; broad component interaction coverage is still limited.
- Migration registration is explicit; a unit test guards against registry/directory drift.
- Some routers have limited validation compared with host/network-tool handlers.
- Sensitive mutation endpoints beyond vault unlock do not all have dedicated rate limits.
- CSP still allows inline styles, and Tauri desktop permissions should stay under review before a hardened release.
- SFTP implementation is custom protocol code and needs careful bounds/interop testing.
- Session manager handles multiple protocols, retries, circuit breaking, detach, and cleanup in one large module.

## Refactor Priorities

1. Split frontend store domains into smaller slices or helper modules without changing behavior.
2. Extend focused session and network-map coverage to SFTP manager behavior and broader component interactions.
3. Add broader upgrade tests for future schema migrations and historical database snapshots.
4. Tighten router validation for snippets, quick actions, highlighting, map node/edge dimensions, and recent connection limits.
5. Continue tightening Tauri CSP and permissions before wider platform release.

## Scaling Strategy

- Keep the app local-first and sidecar-based.
- Add feature domains as separate routers plus focused frontend components.
- Keep protocol-specific transport code behind `SessionManager` and `SftpManager` boundaries.
- Add API contract tests before large frontend refactors.
- Add background job abstractions only when SFTP transfer queues or long-running network tasks require them.
