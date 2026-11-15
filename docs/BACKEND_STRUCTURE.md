# Backend Structure

Folder rename/reparent lives in `routers/hosts.rs` at `POST /host-groups/move`. A `BEGIN IMMEDIATE` transaction compares the full source membership and revisions, checks destination collisions and every resulting descendant path, then changes only the group field. Existing revision triggers advance each affected profile. Prefix matching happens on canonical path segments in Rust, so SQL wildcard characters in folder names remain literal. Public `HostOut` responses preserve credential secrecy; running sessions, SFTP connections and host IDs are unchanged. Empty folder definitions remain local frontend preferences; no new database table is introduced.

Window handoff resumes an existing transport through `/ws/sessions/{session_id}?after=...`, using the same subprotocol authentication as other matched terminal routes. `Session::subscribe_after` atomically captures byte-budgeted history and a live subscription, rejects evicted/future cursors, and never opens a new connection. See [Terminal window handoff](TERMINAL_WINDOW_HANDOFF.md).

Ordinary reattachment uses the same exact-ID route without `after`, replaying retained history. Saved-host and legacy quick-connect `sid` requests also take the resume-only path. Missing/ended IDs produce `session_unavailable`; no request with an explicit ID may create a replacement. New terminal requests use `SessionManager::create`, reserving a random positive 53-bit ID under the registry write lock and retrying collisions. Address/port/username lookup and the timestamp/host-based terminal ID generator are removed, so independent terminals for one host never borrow a detached transport. Internal snippet sessions retain their separate process-unique negative IDs.

Saved host runtime policy lives in `ssh/saved_host.rs`. Terminal, SFTP, snippets and tunnel routers share typed credential loading, zeroized temporary plaintext, safe errors for broken credential links and rejection of unsupported jump routes. Explicit session reattachment calls `SessionManager::resume_live` before profile/credential loading; new connections require successful credential preparation. Snippet create/update validates and persists in a write transaction; PUT/PATCH preserves omitted nullable metadata.

SFTP pool entries and leases are scoped to a saved profile and a cancellable lifetime. Disconnect/host deletion cancels that profile's pending setup and removes its idle transports; older leases are never reinserted after invalidation. Restore invalidates every lifetime. The lifetime registry holds weak references and is pruned; it stores neither credentials nor an unbounded host history.

The backend is a Rust 2021 Axum sidecar in `backend-rs/`. It is built as both a library for tests and a binary named `netrix_backend` for Tauri.

## Entry Points

- `src/main.rs`: runtime binary. Reads token from stdin, initializes logging, encrypted-storage startup gate, CORS and the localhost server. Database/session services are initialized only after master-password entry.
- `src/startup_diagnostics.rs`: binary-local startup failure classification. Fatal
  settings, workspace inspection and listener-binding errors emit one bounded
  `NETRIX_STARTUP_FAILURE:` JSON line with an allowlisted `code` and optional
  numeric `os_error`. The Tauri shell turns it into recovery guidance; original
  errors remain local and are not sent to the locked frontend.
- `src/lib.rs`: exposes modules for integration tests.

## Core Modules

- `auth.rs`: `AppState`, token middleware, quick-connect ticket store, and vault unlock limiter.
- `startup.rs`: authenticated password/setup/upgrade gate without a database pool; publishes `application.rs`'s protected routes only after encrypted storage opens. Filesystem publication completes even if the requesting client disconnects.
- `database_encryption.rs`: SQLCipher pool, password-wrapped random data key, exclusive plaintext conversion, complete row/schema verification, encrypted recovery sets, atomic publication and password-rotation recovery. A local native-build adapter pins SQLCipher 4.20.0 without changing SQLx's Rust ABI.
- `security.rs` and `routers/security.rs`: process-wide application lock, serialized password/lock transitions, cross-window inactivity clock and bounded policy/status API. Token middleware blocks new work while app-locked; existing terminal bridges discard input until verified unlock.
- `config.rs`: app data paths, database URL, generated install secrets, vault salt, Argon2 parameters, SSH known-host policy. Packaged Tauri launches provide the identifier-based path through `NETRIX_DATA_DIR`; direct `NETRIX_DEV` launches retain the executable-local `data` directory.
- `db.rs`: SQLite pool type, atomic embedded schema migrations, registry checks, and compatibility repair for historical partial ALTER migrations. Production pools come from the encryption layer.
- `error.rs`: `AppError`, `AppResult`, HTTP status mapping.
- `models.rs`: SQLx rows and API request/response structs.
- `vault.rs`: Argon2id, AES-256-GCM, vault unlock/lock/store/retrieve/change password.
- `ssh/known_hosts.rs`: TOFU known-host storage with an exclusive first-seen recheck and durable temp-file/atomic-replace persistence.
- `ssh/manager.rs`: SSH/Telnet/Serial session manager.
- `ssh/sftp.rs`: isolated SFTP v3 packet client; `ssh/sftp/connection.rs` owns bounded connection leases, reuse and deadlines; `ssh/sftp/operations.rs` owns streaming and safe mutations; `ssh/sftp_transfers.rs` owns bounded job state/cancellation.
- `ssh/telnet.rs`: minimal Telnet negotiation over TCP.

## Router Domains

- Health: authenticated readiness response consumed by the Tauri parent.
- Hosts: CRUD, validation, credential storage/cleanup.
- Sessions: WebSocket terminal, quick-connect, and explicit backend session termination.
- Vault: lock/unlock/status/reset/change password/items.
- SFTP: capability cache, probe, list, streaming download/upload, job history/cancellation, mkdir/rename/delete/chmod, and isolated transport disconnect.
- Network tools: TCP scan and TLS inspect. Router-local extension owns separate start quotas and active semaphores; request-owned probe futures, DNS/total deadlines and shared probe bounds prevent unbounded detached scan work. See [Toolbox implementation](TOOLBOX_IMPLEMENTATION.md).
- Network map: maps, nodes, edges, auto-populate, ping.
- Snippets: CRUD and remote execution.
- Quick actions: CRUD.
- Highlighting: CRUD.
- Recent connections: list/add/delete/clear.
- Logs: list audit logs.

## Backend Coding Patterns

- Handlers take `State<AppState>`, `Path`, `Query`, and `Json` extractors.
- Return type is usually `AppResult<Json<T>>` or `AppResult<impl IntoResponse>`.
- Database access uses SQLx query strings plus `.bind(...)`.
- Router modules expose `pub fn router() -> Router<AppState>`.
- Long-lived shared services are stored in `AppState`: database pool, vault lock, API token, session manager, SFTP manager, quick-connect ticket store, and vault unlock limiter.
- Host rows and their encrypted credential item are created, updated, cleared, and orphan-cleaned in one SQL transaction.
- Network-map duplicate/delete and multi-row graph mutations use SQL transactions and enforce same-map edge invariants.
- Snippet execution is bounded to 32 hosts, 64 KiB rendered commands, and 1 MiB output per host.

## Session Model

`SessionManager` stores sessions by numeric ID. A session has state, host info, a broadcast output channel, a replay history ring, an optional connection, a read task, and websocket client count.

Supported transports:

- SSH through patched russh 0.65.1 with PTY and shell; raw-key strict TOFU remains mandatory, unsupported host certificates are rejected.
- Telnet through a custom negotiation layer.
- Serial through tokio-serial.

Detached sessions are preserved for up to 10 minutes by the monitor. Connecting sessions are cleaned after 120 seconds. Detached-window close flows can explicitly terminate a session through the authenticated sessions API.

## Vault Model

The vault derives a 256-bit key with Argon2id from a master password and per-install salt. Secrets are encrypted as `nonce(12) || ciphertext || tag` with AES-256-GCM. Unlock bootstraps or validates a check item named `__netrix_vault_check__`; repeated invalid unlock attempts are temporarily rate-limited in memory. Unlock also atomically migrates legacy host plaintext, and vault database operations share an operation lock so password rotation cannot interleave with secret reads or writes.

## Backend Risks

- `SessionManager` is large and handles many concerns.
- SFTP is custom protocol code and needs careful regression tests around packet sizes, status handling, timeouts, and remote path behavior.
- Snippet execution is intentionally powerful and should stay token-authenticated and vault-aware.
- Network-tool endpoints can perform scans from the local machine and must remain bounded.

## Runtime ownership and bounds

`routers/credentials.rs`, `ssh_config.rs`, `backups.rs`, `local_files.rs` and `tunnels.rs` own the connection-management APIs. Managed credentials share existing vault crypto and host foreign keys; key generation runs in a two-slot blocking pool. RSA authentication negotiates SHA2 signatures when advertised, for terminal/exec/tunnels and SFTP.

`ssh/tunnels.rs` owns at most 16 active/connecting rules with at most 32 simultaneous client streams each. Each rule opens an isolated, host-key-verified SSH client; local listeners bind only to loopback, SOCKS supports unauthenticated CONNECT for IPv4/IPv6/DNS over that loopback listener, and forwarded channels use bounded setup deadlines. Stop aborts stream tasks, disconnects SSH and closes the listener. Rules survive restart but never auto-start. Removing a host stops its tunnels.

Workspace replacement uses a shared/exclusive gate. Ordinary HTTP operations and the short WebSocket host-load/session-registration phase hold shared leases; restore holds the exclusive lease and rechecks that terminal/tunnel registries are empty before its transaction. This prevents stale host data or credentials from starting a connection across a restore. Backups use portable per-archive encryption rather than copying a live SQLite/WAL or the installation salt.

SessionEvent separates Data(Bytes) from Ended(String); printed sentinel bytes have no control meaning. Replay uses shared Bytes with limits of 2 MiB and 2048 chunks; broadcast capacity is 128 chunks of at most 16 KiB. The PTY reader uses a bounded 32-chunk queue and blocking_send from its dedicated thread. Slow receivers get an explicit output_gap event. Detached expiry is measured from detachment, so continuous background output cannot retain abandoned sessions indefinitely.

The WebSocket attachment wrapper releases its client on every exit, including failed replay. Clients are counted during connection setup too, so cancelling one pending window preserves other clients. Input received during setup is buffered up to 64 KiB and sent once the connection is ready; heartbeats and cancellation remain responsive. Concurrent connects for one session are serialized, total connection setup is bounded, and stale handles cannot remove replacement sessions. Connections are registered before readers can report EOF. ssh/command.rs collects bounded exec stdout/stderr and exit status separately from interactive sessions.

The Telnet parser retains IAC/option/subnegotiation state across TCP reads. Subnegotiation has a 4096-byte bound; literal IAC bytes are escaped for terminal data, NAWS and terminal-type replies. TCP connection addressing supports IPv6.

Explicit session cleanup runs in an owned Tokio task and removes the registry entry only after transport shutdown, so a lost HTTP caller or concurrent DELETE cannot report early completion. Cleanup aborts/joins the reader and notifies attached clients. Terminal writes/resizes have a 10-second deadline; graceful cleanup has a 5-second deadline. Interactive SSH retains a shutdown guard for its exact TCP socket, including during authentication, so cancellation and close forcibly release the transport without depending on keepalive or remote replies. New WebSocket sessions require an exact-ID `ready` acknowledgement within 10 seconds; unknown/unacknowledged sessions are terminated instead of retained as detached. Input during this acknowledgement remains bounded to 64 KiB.

See [SFTP implementation](SFTP_IMPLEMENTATION.md) for atomic upload, cleanup, protocol bounds, connection reuse and workspace-restore leases.

Known-size SFTP downloads read only the original byte range. Growth reported by final FSTAT produces a completed transfer with a warning after successful CLOSE; truncation, early EOF and same-size metadata changes still fail. This supports active append-only logs without claiming remote snapshot isolation. Transfer warnings contain bounded metadata only.

Hosts use joined vault presence metadata (no per-host query/decryption), versioned partial updates and immediate write transactions. Vault-operation guards precede SQLite acquisition when changing credential ownership. Credential replacement bumps revisions on every linked host, including replacements without a username. Host dependency failures return actionable conflicts. Migrations 006/007/008 and schema-5/6/7/8 portable restore preserve this contract. Optional terminal background/foreground colors are validated as #RRGGBB values and remain independent of connection credentials.

Host `terminal_appearance` is a typed, bounded renderer-preference object stored as JSON text. Validation rejects unknown fields, invalid palette keys/colors and out-of-range typography. Portable restore parses and validates it before inserting any rows; malformed appearance rolls back the entire restore.
