# API Structure

## Desktop process lifecycle

`get_backend_status` returns `starting`, `ready` or `failed` with an optional
`message`. Failures may include `diagnostic: {code, message, recovery, details}`
and `log_path` for the local `tauri_main.log`. Diagnostics derive from allowlisted
startup reasons or numeric exit codes. `get_backend_port` returns `0` until
authenticated readiness. During the 15-second workspace lock retry, the phase
remains `starting`. Continued contention produces `workspace_busy`.

Only `main` can invoke `quit_app`. The command requests exit while the shell
waits for the sidecar. Connections still dispatching requests during shutdown
can receive 503. See [startup and shutdown](architecture.md#shutdown-and-restart).

## Problem-report desktop IPC

`get_problem_report_diagnostics` returns `{ app_version, operating_system,
architecture, backend_status, reason, exit_code, signal, os_error }`. Numeric
codes and the reason may be null; unavailable state is explicit. This shell-only
snapshot does not call backend HTTP or access the database, vault, logs or paths.
`open_problem_report({ url })` validates and opens only the public Netrix GitHub
bug form in the system browser; it does not submit an issue. Both commands are
available from the existing trusted main, detached-terminal and map windows.
See `SECURITY_RULES.md` for field, URL and permission restrictions.

## Encrypted workspace startup

Before the first master-password entry, authenticated `GET /health`,
`GET /security/status` and `POST /security/unlock` are the only available routes.
Other routes return 423 (invalid API tokens still return 403). There is no open
database pool yet. Unlock is bounded to 8 KiB of JSON (including escapes) and
1024 UTF-8 password bytes; password changes enforce the same byte limit.
Wrong passwords return 401 with the shared unlock rate limiter. Concurrent
opening attempts return 409. Client cancellation does not interrupt conversion.

Security snapshots additionally expose `database_mode` (`setup`, `upgrade`,
`encrypted`, `open`), `database_encrypted` and `database_busy` when opening.
These contain no key, database path or workspace records. `setup` requires a new
password of at least 10 characters; `upgrade` uses the existing vault password.
The frontend confirms new passwords and remains closed during migration.

After unlock all existing routes are mounted with their original authentication,
workspace gate and body limits. `/vault/change-password` coordinates the encrypted
database key envelope and vault rotation. `/vault/reset` on encrypted storage
keeps the password verifier and returns `initialized: true`; it clears saved
secrets/credential links and cannot bypass or reset the workspace password.

All backend APIs are served by the Rust Axum sidecar on `127.0.0.1:<dynamic_port>`. The frontend discovers the port through Tauri IPC and sends the per-session token with each request.

## Authentication

- HTTP: `X-API-Token` is required on every non-preflight endpoint. If the parent does not supply a token, the backend generates a non-empty ephemeral token rather than starting unauthenticated.
- WebSocket: only the matched terminal routes accept token transport through `Sec-WebSocket-Protocol` as `netrix-token.<token>`, alongside `netrix.v1`. Client-controlled `Upgrade` headers do not change authentication mode for ordinary HTTP routes.
- CORS allows only exact localhost hosts: `localhost`, `127.0.0.1`, `tauri.localhost`, plus exact `tauri://localhost` and `asset://localhost` origins.

## Response Conventions

- Errors from `AppError` return JSON: `{"detail": "message"}`.
- Creates normally return 201 plus the created object.
- Deletes return 204 or a small JSON status depending on the existing router.
- Rate limits return 429 plus the normal `{"detail": "message"}` error shape.
- Saved host DTOs expose credential presence with booleans, not plaintext values.

## Routes

### Connection management

- `GET|POST /credentials`: list public metadata or create a managed vault item. Creation accepts `name`, optional `username`, and either `password`, `private_key` plus optional `passphrase`, or `generate: "ed25519"|"rsa"`. Generated private keys stay in the vault; only public keys appear in metadata.
- `PUT|DELETE /credentials/{id}`: replace a credential or delete an unused item. Replacement updates all linked hosts' non-empty supplied username in the same transaction. Linked items cannot be deleted.
- `POST /credentials/{id}/hosts/{host_id}`: assign to an SSH host without transferring plaintext to the renderer.
- `GET /known-hosts`: trusted addresses, public keys and SHA256 fingerprints. `DELETE /known-hosts` requires `{host,port,expected_key,confirmation:"FORGET HOST KEY"}` and refuses a stale expected key. Both return 409 when the trust file failed to load; an unreadable or malformed file must be restored before restarting Netrix, never silently replaced with an empty store.
- `POST /ssh-config/preview`: `{content}` or `{system:true}` returns concrete aliases, warnings and a revision. `POST /ssh-config/import` accepts selected `aliases` and the same source; system imports require the preview revision. Existing names are skipped. Includes and Match blocks are not executed; aliases requiring ProxyJump/ProxyCommand are unsupported. Private-key paths are descriptive and are not read automatically.
- `GET|POST /tunnels`, `DELETE /tunnels/{id}`, `POST /tunnels/{id}/start|stop`: saved local TCP or dynamic SOCKS5 CONNECT rules. Rules have `name`, `host_id`, `kind: "local"|"dynamic"`, `bind_port` (0 selects a free port), and local rules require `destination_host`/`destination_port`. List adds `active` and `actual_port`. Binding is always `127.0.0.1`; startup is explicit.
- `GET /local-files?path=...`: read-only directory browsing, defaulting to the user's home, with at most 10,000 entries. `GET /local-files/content?path=...` streams a regular file up to 128 MiB for explicit SFTP upload. All these routes require the API token.

### Portable encrypted backups

`POST /backups/export` accepts a separate `password` (at least 12 characters) and bounded frontend `preferences`, returning `{version:1,salt,ciphertext}` with base64 fields. Files contain AES-256-GCM ciphertext; Argon2id parameters are fixed at 64 MiB / 3 iterations / 4 lanes. The logical snapshot identifies database schema 8 (schema 5/6/7 archives are upgraded on restore) and includes hosts/vault, snippets/actions/highlighting, maps/edges/nodes, recent/audit records, capabilities and saved tunnel rules. Plaintext snapshots are capped at 16 MiB; request bodies at 24 MiB.

`POST /backups/restore` accepts `{password,archive,confirmation:"RESTORE BACKUP"}`. The destination vault must already be unlocked. Restore decrypts and validates the archive, excludes concurrent HTTP operations/session registration, refuses active or connecting terminals/tunnels, and replaces workspace records in one transaction with deferred foreign-key checking. Failure rolls back all database changes. Secrets and a fresh check record are encrypted with the destination vault key; its master password/salt stay authoritative. Quick-connect tickets are invalidated. Trust files, OS keychain entries, terminal output and local/remote file contents are not imported. Rules do not auto-start. Future schema changes must explicitly migrate this format or reject incompatible backups.

### Readiness

- `GET /health`: authenticated sidecar-readiness probe. It requires the normal
  `X-API-Token` header and returns `{"status":"ok"}` after the Axum router is
  accepting authenticated requests. Tauri uses this response—not a bare TCP
  connection—to move `get_backend_status` from `starting` to `ready`.

### Hosts

Host create/read/update DTOs also include nullable `terminal_background` and `terminal_foreground` color overrides. Writes accept exactly `#RRGGBB`; PATCH omission preserves a value and explicit null restores the selected theme's color. These values also survive encrypted backup/restore; schema 5/6 imports initialize them to null. The nullable `terminal_appearance` object stores font family, normal/bold weight (100–900 in steps of 100), line height (1–2), letter spacing (-1–5 px), cursor style/blink, bold ANSI behavior and a validated color map (16 ANSI colors, cursor and selectionBackground). Colors use #RRGGBB; selection is rendered at 40% opacity. PATCH replaces the appearance object, omission preserves it, and null resets it. Schema 5/6/7 backups initialize this object to null. They are appearance metadata, not session credentials.

Appearance font-family names must be nonblank, contain no Unicode control characters and fit within 128 UTF-16 code units, matching the frontend input's maxlength. Unknown appearance properties and invalid value types are rejected during JSON decoding; out-of-range values are rejected before persistence.

- `GET /hosts`: list saved hosts.
- `POST /hosts`: create host. Supports `ssh`, `telnet`, `serial`, and `local`.
- `GET /hosts/{host_id}`: fetch host.
- `PATCH /hosts/{host_id}`: update supplied fields with a required revision; stale edits return 409.
- `PUT /hosts/{host_id}`: compatible updates preserving omitted fields; accepts an optional revision and explicit credential changes.
- `DELETE /hosts/{host_id}`: delete host and remove orphaned vault credential items; referenced jump profiles or snippets return 409.
- `POST /host-groups/move`: rename or reparent a complete folder subtree. Accepts `{source, destination, hosts: [{id, revision}]}` with canonical paths and the complete source host snapshot. Returns updated public host DTOs. Conflicting membership, revisions or an existing destination return 409; invalid/self-nested paths return 400. All descendant paths are checked before a single SQLite transaction commits. Empty folders are frontend preferences and send an empty host list, while still checking backend destination collisions.

### Terminal Sessions

- `GET /ws/terminal/{host_id}`: create a new terminal for a saved host. Without `sid`, always allocates a fresh session; it never searches for a detached connection by address/user. Legacy `?sid=...` is strictly resume-only for that exact session, before profile/credential loading.
- `GET /ws/sessions/{session_id}`: authenticated, exact resume-only reattachment. Requires an existing live transport; never loads credentials, looks up a saved host, or creates a replacement. Optional `?after={byte_offset}` supplies the exact checkpoint for window handoff; without it, replays retained history. A cursor outside retained history is rejected. This works after Vault lock or removal/editing of the saved profile. Missing/ended sessions send an `error` control with `code: "session_unavailable"` and close; clients must not silently create a replacement or choose another session.
- `POST /sessions/quick-connect-tickets`: create a short-lived one-time ticket for ephemeral quick-connect parameters, including optional credentials. The request uses normal `X-API-Token` HTTP auth and the response returns only `ticket` plus `expires_in_secs`.
- `DELETE /sessions/{session_id}`: authenticated, idempotent terminal termination used by every tab/window close, including when its WebSocket is unavailable. Responds with `{ok: true, terminated: boolean}` after cleanup; an already absent ID succeeds with `terminated: false`. Losing the HTTP response does not cancel cleanup; concurrent requests wait for the same transport to close.
- `GET /ws/quick-connect?ticket=...`: WebSocket for ephemeral sessions using the one-time ticket. Credentials are rejected when sent directly as WebSocket query parameters. A ticket without `sid` creates a fresh session; a legacy ticket with `sid` resumes only that existing live session. New clients use `/ws/sessions/{session_id}` for reattachment without issuing another credential ticket.

Terminal input/output uses binary WebSocket frames. Backend controls are text payloads prefixed with `__JSON__` and include `connect`, `replay_start`, `output_gap`, `error`, `disconnect`, and heartbeat `pong` events. New terminal IDs are positive integers within JavaScript's safe integer range and are reserved atomically in the session registry; clients treat them as opaque identities. `replay_start` includes the absolute `offset` of its first replay byte. When `after` is supplied, the resume-only route also sends `replay_end` with the offset immediately after replay, before forwarding live output. Frontend controls are JSON text (`ready`, `resize`, `heartbeat`, `detach`, `terminate`); heartbeat accepts optional `sent_at`, echoed in the prefixed `pong` response. Frontend and sidecar must be updated together. See [window handoff](TERMINAL_WINDOW_HANDOFF.md) for the renderer transaction.

The local Tauri handoff offer may include `placement: { beforeTabId: string | null,
windowLabel?: string, pane?: { groupId: string, index: number } }` to choose a tab
neighbor or an exact vacant pane (zero-based index). It is not sent to the backend.
Pane offers are revalidated on receipt, reserve the vacant cell until commit and
never replace an occupied session. Handoff failure events distinguish
`cancelled: true` so ordinary cancellation stays quiet. The read-only native
`terminal_dock_target(x, y, excludeSource)` resolves only a Netrix terminal window
label at the physical cursor point; `terminal-dock-probe`/`terminal-dock-result`
are addressed to that window, and include the source's session count.

`wait_terminal_drag_release(gestureId)` returns `{ released: boolean,
point: { x: number, y: number } }` at native mouse release/Escape, or `null` after
cancellation/on unsupported platforms. Coordinates are physical pixels.
`cancel_terminal_drag(gestureId)` cancels only the calling window's matching
observer. Both are terminal-only and accept UUID gesture IDs.

`open_terminal_window(handoffId, targetLabel, originTabId, title, dropPoint?, workspace?)` is a fixed-purpose
Tauri command for individual pane extraction. Rust supplies the source window
label and monitor placement; optional integer physical `dropPoint: { x, y }`
preserves release position through screen preparation, falling back to the native
cursor if that monitor is no longer present. Only `detached-terminal-<canonical UUID>`
targets and a fixed local standalone-terminal route are allowed. It accepts no
host descriptors, credentials, arbitrary URLs or permissions. The session/screen
still travels through the existing in-memory handoff offer after window creation.
The optional boolean `workspace` adds only the fixed `workspace=true` query flag
for moving a split tab from a floating workspace; no arbitrary route is accepted.

### Vault

- `POST /vault/unlock`: unlock or bootstrap vault with `master_password`; first-time bootstrap requires at least 10 characters, and repeated invalid passwords are temporarily rate-limited. The response reports `migrated_legacy_hosts` and `preserved_existing_credential_links` when compatibility cleanup runs.
- `POST /vault/lock`: drop in-memory key.
- `POST /vault/reset`: destructive reset requiring confirmation `RESET VAULT`.
- `POST /vault/change-password`: re-encrypt vault items with a new master password.
- `GET /vault/status`: returns unlock/init state plus `secret_items` and `linked_hosts`.
- `GET /vault/items`: list metadata only.
- `POST /vault/items`: create encrypted secret when vault is unlocked.
- `GET /vault/items/{item_id}` is removed (404), even with the correct API token and an unlocked vault. Decryption is internal to credential consumers; no plaintext-secret response remains.

### Application security

All routes require the same per-session API token. Application lock and vault-only lock are distinct.

- `GET /security/status`: `{locked, revision, vault_unlocked, vault_initialized}`. All windows read this authoritative snapshot; a monotonically increasing revision rejects stale unlock responses.
- `POST /security/lock`: lock every workspace window, clear quick-connect tickets and drop the vault key. Requires an initialized vault; otherwise returns 400.
- `POST /security/unlock`: `{master_password}`; verifies the existing password using the shared vault rate limiter before clearing application lock. Cannot initialize/reset a vault. Returns the status snapshot.
- `POST /security/activity`: record trusted user interaction from any window. Output and status polling do not reset inactivity.
- `POST /security/policy`: `{app_timeout_seconds: number|null, vault_timeout_seconds: number|null}`. Main applies validated preferences; null disables the respective timer, application timeout is 60–3600 seconds, vault timeout is 300–14400 seconds. Does not unlock or reset activity.

While application-locked, authenticated requests return 423 except status reads (`/security/status`, `/vault/status`) and explicit application lock/unlock. `/vault/unlock`, reset, settings, file operations and new WebSocket attachments cannot bypass the lock. Existing WebSockets discard binary input and resize/terminate controls while retaining transport/output. Already accepted requests, transfers and tunnels may finish/continue; lock is not a cancellation or rollback API.

### SFTP

- GET /sftp/hosts/{host_id}/capability and POST .../probe: cached state and explicit support probe.
- GET .../list?path=...: bounded remote directory listing.
- POST .../transfers: create an upload/download job with path, optional bytes_total, and explicit OVERWRITE confirmation for replacement.
- POST .../upload?path=...&transfer_id=...: raw streamed bytes to an exclusive temporary file, checked close and final rename.
- GET .../download?path=...&transfer_id=...: streaming download with x-netrix-transfer-id. truncate=true selects bounded preview instead.
- GET /sftp/transfers and GET /sftp/transfers/{id}: bounded real job history/progress, with nullable `warning` metadata for successful bounded copies of files which grew during download. Clients must distinguish warnings from `error` and still require `status: completed`.
- POST /sftp/transfers/{id}/cancel: stop a job; 409 once committing.
- POST .../operations: mkdir, no-overwrite rename, confirmed delete of a file or empty directory, and chmod with 000-777 permissions.
- POST .../disconnect: cancel this host's jobs and pending setup, invalidate its leases and clear only its idle SFTP transports. Already executing non-transfer operations may settle under their deadlines; their connections cannot return to the pool. Other profiles are unaffected.

All paths above with ... are under /sftp/hosts/{host_id}. A transfer ID is single-use and bound to host, path and direction. Implicit upload jobs do not authorize replacement. HTTP 200/body EOF alone does not establish download success: check the job. See [SFTP implementation](SFTP_IMPLEMENTATION.md) for payloads, states, limits, cancellation and atomicity.

### Network Tools

- `POST /network-tools/scan/tcp`: real TCP connects to one resolved IPv4/IPv6/DNS target. Request: `target`, `ports` (default `22,80,443`, max 8192 bytes / 1024 distinct ports), `timeout_ms` (50–30000, default 450), `concurrency` (1–256, default 128). Four active scans and 256 active probes across scans; five start tokens, refill 0.5/second. DNS wait max five seconds; total scan max 60 seconds, including permit waits. Invalid/excessive input or deadline errors use `detail`; busy/rate limits return 429. Probe futures end with their request; HTTP disconnect alone is not a guaranteed cancel API.
- `POST /network-tools/tls/inspect`: certificate inspection with public CA/name verification. Request: `target`, `port` (1–65535, default 443), optional `server_name`, `timeout_ms` (50–30000, default 2000). Timeout covers DNS/connect/handshake together. Eight active inspections; ten start tokens, refill one/second. Response adds `resolved_ip` and `server_name` to existing target/port/TLS/cipher/issuer/subject/validity metadata; `san` includes DNS and IP entries. Untrusted/expired/mismatched certificates remain errors. See [Toolbox implementation](TOOLBOX_IMPLEMENTATION.md).

### Network Map

- `GET /network-map/maps`, `POST /network-map/maps`.
- `GET|PUT|DELETE /network-map/maps/{map_id}`.
- `POST /network-map/maps/{map_id}/duplicate`.
- `POST /network-map/maps/{map_id}/auto-populate`.
- `POST /network-map/maps/{map_id}/ping`.
- `GET /network-map`: legacy default map endpoint.
- `POST /network-map/auto-populate`: legacy default auto-populate.
- `POST /network-map/nodes`.
- `PUT|DELETE /network-map/nodes/{node_id}`.
- `PATCH /network-map/nodes/{node_id}/position`.
- `POST /network-map/edges`.
- `PUT|DELETE /network-map/edges/{edge_id}`.

Map mutations validate names, colors, finite/bounded coordinates and geometry, and JSON metadata. An edge and both endpoint nodes must belong to the same map; cross-map moves of connected nodes are rejected. Duplicate/delete graph operations are transactional.

### Snippets, Quick Actions, Highlighting, Recent Connections, Logs

- `GET|POST /snippets`, `GET|PUT|PATCH|DELETE /snippets/{snippet_id}`, `POST /snippets/{snippet_id}/run`.
- `GET|POST /quick-actions`, `PUT|DELETE /quick-actions/{action_id}`.
- `GET|POST /highlight-rules`, `PUT|DELETE /highlight-rules/{rule_id}`.
- `GET|DELETE /recent-connections`, `POST|DELETE /recent-connections/{id}`.
- `GET /logs`.

Snippet execution accepts at most 32 unique hosts, supports saved SSH/Telnet hosts only, caps the rendered command at 64 KiB and captured output at 1 MiB per host, and marks truncated output.

Snippet PUT/PATCH preserves omitted fields. Explicit `variables: null` resets defaults to `{}`; `host_id: null` removes the host association. Updates merge and validate in one SQLite write transaction. Titles require 1–255 bytes without control characters, commands 1–65536 bytes without NUL, variables a JSON object at most 64 KiB, and host references must exist. Invalid input returns 400 without changing the row. The frontend sends only edited title/template fields through PATCH. Snippets do not yet have revision conflict detection for edits to the same field.

Saved-host terminal, SFTP, snippet and tunnel connections use one internal credential loader. Locked or unmigrated credentials stop new connections before network I/O; malformed, missing or undecryptable linked items produce an actionable conflict (HTTP 409, WebSocket error control, or per-host snippet error). Error text never includes credential payloads or JSON parser details. SFTP probe retains its `auth_failed` capability response for locked credentials. A profile with `jump_host_id` is rejected before direct connection (HTTP 400 or transport/per-host error); jump traversal is not implemented. Existing live terminal transports may still reattach without successful credential loading or opening a new socket.

## API Risks

- Quick-connect tickets are in-memory, short-lived, and one-time use. Keep credentials out of WebSocket URLs and logs.
- `GET /vault/items/{item_id}` returns plaintext by design when unlocked; keep it backend-token protected and avoid exposing it casually in UI.
- Snippet execution runs rendered commands on selected hosts; treat it as privileged remote command execution.
- Network tool APIs can contact arbitrary targets from the user's machine; maintain bounds, rate limits, and warnings.

## Terminal transport and command execution

Every `connect` control includes `{session_id, connection}`. `connection` contains only `hostname`, `port`, `username`, `connection_type`, `serial_port`, `serial_speed`, `local_command`, `local_args`, and `local_cwd`, taken from the actual session's transport snapshot. Reattachment reports that same snapshot even if the saved profile changed. A new session reports the newly loaded profile. The frontend validates and applies this descriptor to the individual tab before sending `ready` or allowing terminal input; missing/invalid descriptors fail the connection. No credentials or arbitrary `host_info` properties are serialized.

Terminal input and output use binary WebSocket frames containing the original bytes. Text input frames are strictly typed controls (ready, resize, heartbeat, detach, terminate); terminal programs must never send their text through that control path. After receiving `connect`, clients send `{type: "ready", session_id: <exact ID>}`. Fresh connections require this acknowledgement within 10 seconds before replay; cancellation or failure before acknowledgement terminates the new transport. Resume routes accept it without requiring it. Backend controls retain the __JSON__ prefix. replay_start precedes each history replay; clients replace their previous screen/buffer rather than appending duplicate output. output_gap explicitly reports an overrun. Frames/messages are limited to 1 MiB. Deploy the frontend and sidecar together.

SSH snippet execution uses an isolated exec channel without a PTY or interactive shell. Results retain host/output/error and add stdout, stderr, exit_status, timed_out and truncated. The output budget is 1 MiB across both streams. Authentication/connection and command execution have separate deadlines. A missing exit status, nonzero status, rejection, truncation or timeout is an error. Telnet execution remains best-effort interactive execution; its exit_status is null, and transport end, write failures, lost output and deadlines are handled explicitly.

### Host update contract

Saved-host responses include a numeric revision and always return username as a string (empty for legacy NULL). Password/key presence is read from public vault metadata in the same joined query; listing never unlocks/decrypts the vault. Older metadata is repaired on successful unlock.

PATCH /hosts/{host_id} requires revision and accepts only changed fields. Omitted fields are preserved; null explicitly clears nullable group/jump/serial/local/appearance fields. A stale revision returns 409 with instructions to reopen the editor. Legacy PUT remains compatible, preserving omitted fields; clients should use versioned PATCH for concurrency protection. Credential replacement/clearing keeps its existing explicit semantics. Host updates execute in an immediate SQLite transaction.

Group paths are trimmed per segment, repeated/outer slashes removed, and empty paths stored as NULL. Paths allow Unicode and are bounded to 100 characters / 16 levels; dot segments and control characters are rejected. Font sizes are 6-72. Jump references are validated for existence, SSH protocol and cycles; this validates saved metadata and does not add SSH jump transport support.

Deleting a host referenced by other jump profiles or snippets returns 409 with dependency counts. Reassign/remove those references first. Successful deletion still cleans orphaned credentials, cancels file jobs and stops its tunnels. Backup restore assigns fresh host revisions so pre-restore editors cannot overwrite restored records.

Host revisions remain fresh across deletion and restoration of the same SQLite ID. Portable imports reject revisions outside the exact JavaScript integer range, reserving room for inserted records.

Tunnel stop and rule/host deletion cancel both connecting and active jobs. A start request cancelled during SSH setup returns an error and cannot publish a late listener; deleting the saved rule/host makes subsequent starts return 404. Pending jobs count toward the 16-tunnel limit and block backup restore.
