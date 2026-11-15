# Security Rules and Review

Startup diagnostics cross the existing `get_backend_status` IPC only as fixed
allowlisted reason codes/messages, numeric OS/exit codes, recovery text and the
local log path. The shell parses bounded `NETRIX_STARTUP_FAILURE:` records from
its own sidecar; unknown fields/codes and arbitrary stderr are excluded from the
frontend/copy action. The session API token is redacted from captured stderr and
process-stream errors before local logging. No new Tauri permissions, telemetry,
automatic dependency installation, workspace reset or credential fields are
introduced. A confirmed process failure keeps the existing security boundary
closed, including already-mounted sessions.
A confirmed failed sidecar is latched for the renderer lifetime: late unlock or
status responses cannot reopen protected content or erase its failure diagnosis.

Windows setup uses a fixed `--check-webview2` shell mode that exits before Tauri
initialization, profile migration, logging, credential access or sidecar startup.
It only calls the Microsoft loader and reports availability. The NSIS hook extracts
the shipped shell and Microsoft offline installer into `$PLUGINSDIR`, uses fixed
quoted commands, never deletes runtime registry entries, and aborts when the
post-repair probe fails. It does not add webview permissions or read Netrix data.
The backend release build statically links the MSVC CRT; the release gate rejects
external redistributable DLL imports in both shipped executables. Static runtime
security updates require rebuilding and publishing a new immutable app version.

Saved-host runtime preparation is shared by terminals, SFTP, snippets and tunnels (`ssh/saved_host.rs`). A linked credential that is locked, missing, malformed or undecryptable must stop new connection attempts; never fall back to empty authentication or legacy plaintext. Only the absence of a credential link and legacy secrets permits credential-free authentication. Raw decrypted buffers and typed credential temporaries are zeroized on drop. Error responses must not contain parser details or credential values. Profiles requiring jump traversal are rejected before any direct network connection. A live terminal can reattach after Vault lock through a resume-only path that never opens a socket; existing sessions/transfers/tunnels are not terminated by these checks.

SFTP connection reuse includes the saved profile ID. Disconnect invalidates that profile's lifetime so older in-flight leases cannot repopulate its pool; other profiles keep their transports. New setup is cancelled on invalidation. Already sent file mutations can settle and are never automatically retried or described as rolled back merely because the user changed views.

## Connection management security

The connection workspace uses existing HTTP token auth; Tauri permissions and localhost/CORS boundaries are unchanged. Managed credentials never expose private keys/passwords in their DTOs. Creation/import validates keys, generation runs in a bounded blocking pool, secrets use the existing vault, and shared replacement/deletion is serialized with vault rotation. Host deletion preserves explicitly managed keys.

Portable backup files use a fresh per-archive salt and password-derived AES-256-GCM key; no plaintext database or installation master password is exported. Restore requires an unlocked destination vault and `RESTORE BACKUP`, excludes concurrent operations, checks inactivity twice, validates schema/hosts/foreign keys, and rolls back the entire transaction on failure. It retains the destination master password and re-encrypts imported secret records. Native remembered-unlock secrets and server trust are not transferred. Raw SQLite file copies still require their matching installation salt; this differs from the portable logical archive. The implementation clears owned sensitive byte/key buffers but does not promise removal of every temporary library/JSON memory copy.

Known Hosts removal requires both `FORGET HOST KEY` and the current public key, is durably persisted with rollback on error, and allows a fresh TOFU decision on the next connection. SSH config import never executes commands or reads referenced identity files, warns about Include/Match, and rejects aliases requiring unsupported proxy routing. System config imports require the preview revision.

Local Files adds authenticated read-only filesystem access to the trusted desktop client: users explicitly browse a path or select a file, ordinary files are capped at 128 MiB, and no local write/delete API is added. SFTP upload remains an explicit write with visible overwrite semantics. Local TCP and SOCKS5 listeners bind to 127.0.0.1, use the same host-key checks as terminals, and cap concurrent tunnels/clients. Other local processes can use a running SOCKS listener; stop it when no longer needed. Saved rules are inert until explicitly started.

Netrix handles credentials, private keys, terminal output, remote command execution, SFTP file access, clipboard data, and local desktop permissions. Treat security changes as high impact.

## Current Protections

Folder rename/move uses the existing token-authenticated and application-lock-protected HTTP boundary. `/host-groups/move` requires a complete revision snapshot, rejects destination collisions and self-nesting, validates every descendant against the existing path limits, and uses SQL binds inside one write transaction. It modifies only folder metadata and returns public host DTOs; it neither loads decrypted credentials nor changes live connection parameters. No Tauri permissions are added.

- Backend binds to `127.0.0.1` only.
- Tauri generates a per-session API token and passes it to the backend through stdin.
- HTTP requests require `X-API-Token`.
- WebSockets validate `netrix-token.<token>` in `Sec-WebSocket-Protocol`.
- Token comparisons use constant-time comparison.
- CORS is restricted to exact localhost, 127.0.0.1, tauri.localhost, and Tauri origins.
- Tauri CSP disallows `unsafe-eval`; `unsafe-inline` remains for current inline style usage.
- Backend sidecar spawning is Rust-owned. Webviews receive no shell open/execute/spawn/stdin permissions.
- Tauri app commands and core/plugin permissions are split by window label. Only `main` has generic webview creation and keychain access. Detached terminals receive clipboard access and the fixed-purpose terminal opener documented below; detached maps receive neither capability.
- Only the trusted `main` window receives the `quit_app` command used by the title-bar close flow. Detached terminal and map windows retain per-window close behavior and cannot terminate the full application.
- Detached terminals alone receive `close_terminal_window`. It takes the calling `WebviewWindow` from Tauri, verifies its detached label and destroys only that window; no target label argument or generic `allow-destroy` permission is exposed. This completes an acknowledged handoff/native-close transaction without granting authority over the main window. Main adds read-only `inner-position`/`is-minimized` access for measured dock targets; detached terminals add read-only cursor-position access. No shell, credential-store, filesystem or network permissions are expanded.
- Main and detached terminal windows receive `wait_terminal_drag_release(gestureId)` and `cancel_terminal_drag(gestureId)`, both restricted again to the native calling window and a UUID gesture. On Windows the observer reads only the fixed left mouse button/Escape states for at most 120 seconds and returns release/cancel status with one physical cursor point at release. Only one observer per source window is active; replacement, cancellation and a bounded list of ended gestures prevent late IPC from reviving old observers. Cancellation cannot stop another window's observer or a newer gesture. These commands accept no key codes or target windows, generate no OS input and record no input history. Maps/preview windows receive neither permission. This provides a fallback when capture changes or the native move loop consumes pointerup. Touch, synthetic gestures and unsupported platforms retain their DOM event path. Existing cursor geometry access is unchanged.
- Pane docking adds read-only `terminal_dock_target` to main/detached-terminal capabilities, and read-only `inner-position`/`is-minimized` to detached terminals. Windows checks visible top-level geometry in z-order, skipping only the source when requested and app-owned drag previews; a foreign window occludes the destination. It returns only a main/detached-terminal label, never foreign window metadata, text or handles. Maps/preview webviews receive no new IPC permissions. Non-Windows falls back to app-owned visible-window geometry. Detached connection pickers do not read or save remembered Vault passwords; manual unlock uses existing authenticated HTTP. These geometry permissions grant no window creation, keychain, filesystem, network or input-generation access.
- Individual pane extraction grants `open_terminal_window` to main/detached-terminal capabilities. Rust derives the source label from the calling webview, validates UUID handoff/target identifiers, and creates only a hidden standalone terminal at an encoded, fixed app route. The caller cannot supply a URL, capabilities, credentials or a label for an existing window. Placement uses an optional integer physical release point or the native cursor, bounded to a current monitor work area; an obsolete monitor falls back to the native cursor. Titles are bounded public metadata. Maps/preview windows cannot use it; generic create-webview, shell, keychain and filesystem permissions remain unavailable to detached terminals. Source release still requires the existing ready/commit acknowledgement.
- Main alone adds read-only `monitor-from-point` to place floating terminals and non-focusable drag cards within the cursor monitor's work area at its own DPI. No new filesystem, input generation or remote access is granted. Drag card URLs contain only public name/protocol/status metadata. Terminal output is excluded, obsolete metadata preview caches are removed, and return placement contains only window/group/pane IDs or an optional tab neighbor ID. Floating native transparency is visual and does not grant capabilities to preview windows.
- `tab-preview-*` windows do not match an IPC capability and cannot retrieve the backend token.
- The terminal release worker reads its existing cursor sample through `GetPhysicalCursorPos` so DPI virtualization cannot change the sample's units. No command, capability or additional input observation is added. Final dock retries repeat native occlusion and destination checks and cannot commit a cached hover placement. The monitor-layout smoke helper temporarily changes only its own thread's DPI context and restores it; it reads bounds and changes no OS display settings.
- Floating workspace group tabs use the existing `open_terminal_window` capability with an optional boolean `workspace` flag. It selects only the existing fixed workspace app route after the same caller/UUID validation; generic creation permissions and arbitrary URLs remain unavailable. Standalone tabs created by Single use the ordinary per-session handoff and local IDs. Window Return is a sequence of existing bounded transactions; a failed entry cannot release unreturned source sessions.
- Quick-connect credentials are exchanged through short-lived, one-time HTTP-created tickets rather than WebSocket query strings.
- Saved credentials are encrypted in `vault_items` with Argon2id + AES-256-GCM.
- Legacy `hosts.password` / `hosts.private_key` values are never runtime authentication fallbacks. A successful vault unlock migrates them into encrypted `vault_items` and clears the plaintext columns in one transaction; failed or locked unlocks leave the legacy data unchanged.
- SQLite connections enable `secure_delete`; after a legacy migration the backend rebuilds the database with `VACUUM` and truncates the WAL on a best-effort basis.
- Repeated invalid vault unlock attempts are temporarily rate-limited in backend memory.
- First-time Vault bootstrap requires a master password of at least 10 characters; the frontend also requires confirmation to reduce unrecoverable typo risk.
- API host responses expose credential presence flags rather than plaintext secrets.
- SSH host key verification defaults to strict TOFU and rejects mismatches. Terminal and SFTP share the same in-process known-hosts store.
- Only a missing `known_hosts` file initializes an empty trust store. Read errors, invalid UTF-8, malformed records and conflicting duplicate addresses block key acceptance, listing and removal until the file is repaired and the store reloaded by restarting Netrix. Parsing is atomic; no partial trust set may be persisted over a damaged file. SFTP cache lookup propagates load errors as well.
- Concurrent first-seen host keys are rechecked under a write lock; known-host updates use fsync plus atomic replace and reject trust when persistence fails.
- SFTP operations use separate SSH connections and do not touch interactive terminal sessions.
- TCP scan and TLS inspect endpoints handle IPv4/IPv6 through parsed socket addresses, validate targets/timeouts/bounds, and use simple rate limiters.
- Toolbox additionally limits active work to four scans, eight TLS inspections and 256 TCP probes across scans. DNS wait is capped at five seconds, scans at 60 seconds, and TLS timeout covers DNS/connect/handshake together. Probe futures stay request-owned rather than spawning detached tasks. TLS CA/name verification stays enabled; port/service/risk labels are hints rather than proof of actual service/vulnerability. See [Toolbox implementation](TOOLBOX_IMPLEMENTATION.md) for HTTP disconnect and OS resolver limitations.
- DevTool transforms execute from a dedicated local Utilities input with transient component state and bounded work. Terminal keystrokes, including `devtool ...`, go to the connected host; the former line collector/Enter interception is removed to avoid retaining password input. Use the dedicated runner for local processing. JSON/SQL formatting must preserve quoted data and numeric spelling or reject unsupported input.
- Network-map APIs enforce same-map graph endpoints and bounded geometry/metadata; duplicate/delete operations are transactional.
- Snippet runs are limited by host count, supported transport, rendered command size, and captured output size.

## Secrets Handling

- The unused plaintext `GET /vault/items/{item_id}` endpoint is removed. Internal saved-host/managed-credential/backup consumers retain vault access; HTTP list/create responses contain metadata only.

- Vault key material is kept in backend memory only while unlocked and is zeroed on lock/drop.
- Vault salt and generated app secret are stored under the app data directory. The salt is not secret; the app secret appears legacy/unused by current token auth.
- Optional remembered Vault password uses Windows Credential Manager through fixed-purpose Tauri commands backed by `keyring` with `windows-native`. The former keychain plugin had no desktop invoke implementation and was removed. Only `main` grants `allow-read-vault-password`, `allow-save-vault-password` and `allow-remove-vault-password`; commands cannot select arbitrary entries. Passwords travel transiently over trusted IPC and authenticated unlock HTTP, never public backend DTOs or persisted frontend state. Other platforms fail explicitly until a native backend is implemented.
- The `every_start` Vault policy overrides remembered credentials and disallows saved-password unlock actions. Unknown initialization status cannot auto-unlock; a reset Vault cannot be initialized by an old remembered password. Failed save/remove operations display errors and do not pretend the credential store changed. Native operations serialize on the blocking pool; incoming save strings use `Zeroizing`.
- Do not store credentials in localStorage, logs, query strings, or API responses.
- Host form key-file selection reads only the user-selected file into transient component state (maximum 1 MiB); it does not upload or persist it on selection. Save uses the existing encrypted vault path; Connect only uses the existing one-time connection path. Only the selected network authentication method is submitted, protocol changes clear entered secrets, and obsolete file reads cannot populate another form context.
- Treat the legacy host credential columns as read-only migration input. New create/update paths must write credentials only to the unlocked vault.
- SQLite cleanup removes remnants visible through normal database/WAL files, but cannot guarantee erasure of copies retained below SQLite by filesystems, snapshots, or SSD wear leveling.
- Detached terminal windows must receive sanitized host payloads only; Quick Connect secrets stay in the backend ticket/session handoff path and must not be serialized into window URLs.
- Do not persist terminal command history or actual terminal output rows in localStorage.
- Native DOM paste (including Ctrl+V/Shift+Insert) and Tauri clipboard actions share the same size and multiline-confirmation gate. The renderer intercepts paste before xterm can send data, then uses xterm's public paste API to retain newline normalization and bracketed-paste handling. Pending reads/confirmations are invalidated by session, renderer, focus/view, closure, handoff or broadcast-recipient changes; confirmation cannot redirect text to a replacement connection.
- Never collect terminal keystrokes, pasted input or rendered prompt lines for command history: SSH/Telnet/Serial/local terminal input does not reliably identify password entry. Recent commands may contain only saved Quick Actions explicitly submitted by Netrix, kept in memory; merely inserting an action does not record subsequent edits or Enter. Legacy v1/v2 localStorage history is removed without reading or importing it. This policy applies to main and detached terminals and their CSV history export; it does not control remote shell history or redact secrets deliberately embedded in saved actions.
- Window handoff screen snapshots travel only through trusted in-memory Tauri events and controller state, with an 8 MiB bound. URLs contain transaction/window/tab IDs only. The authenticated resume-only route accepts an exact byte cursor and cannot create a connection or retrieve credentials. Rollback closes only the speculative attachment. See [Terminal window handoff](TERMINAL_WINDOW_HANDOFF.md).
- Ordinary terminal reattachment is also exact-ID and resume-only; address/port/username must never select a detached session. Missing IDs cannot create a transport, including legacy saved-host/quick-connect `sid` requests. New terminal IDs are positive JavaScript-safe random integers reserved atomically with collision checks; they are identities, not authentication tokens. Existing WebSocket authentication and workspace gates still apply. Reattachment does not reload credentials or require another Quick Connect ticket; an ended session stops automatic retries and requires explicit user action to start a new connection.
- A successful connection must report the actual session's allowlisted, credential-free destination descriptor. Update only that tab before acknowledging readiness or enabling input. Editing a saved profile must not relabel existing live transports; starting a replacement session must replace its stale connection fields.
- Split-group moves carry at most four individually sanitized session/screen offers (the 8 MiB screen bound applies per member) in one in-memory transaction. Group membership/layout/focus carry no credentials. All members retain their original source attachment until group commit. Extracting one member uses one sanitized offer; the remaining group and transports stay local. Pane docking's geometry permissions and fixed-purpose window opener are documented above.
- Terminal tear-out preview snapshots may persist only synthetic rows plus theme/font/status metadata, never xterm buffer contents.

## Application lock (2026-11-08)

The workspace gate keeps typed passwords and reveal state in local component state only. Reveal is cleared on window blur, document hiding, lock/mode transitions and submission. Submission clears both password fields immediately, rejects duplicate in-flight requests, and waits for a verified locked backend state before sending an unlock. No remembered-password or recovery bypass is added; backend verification and rate limits remain authoritative.

`AppState.security` is one process-wide authority shared by every window. A backend monitor checks inactivity each second; only real pointer/keyboard/wheel/touch interaction reported by any window refreshes its clock. Incoming terminal output, HTTP polling and changing policy do not count. Main applies persisted timeout preferences. Application lock requires an initialized master-password verifier, locks the vault, clears quick-connect tickets, rejects new protected HTTP/WebSocket requests with 423, and discards input/resize/terminate frames on existing sockets. Input queued before a lock transition is discarded rather than replayed after unlock. Vault-only lock retains existing terminal input behavior.

`AppSecurityBoundary` wraps main, detached terminal/workspace and map content before any window-specific return. It starts closed until a valid status arrives, polls every second, refreshes on focus/events, ignores stale revisions, and hides content if verification fails or times out. Events are refresh hints, never an unlock authority. A full-window modal hides/inerts protected content and keeps session components mounted. A successful explicit master-password verification unlocks all windows. Saved-password actions and destructive vault reset are absent from the app-lock screen; `/vault/unlock` and `/vault/reset` cannot bypass it. The unlock limiter is shared across both unlock routes. No native capabilities were expanded. Legacy `tabPreview` renders public drag metadata only, has no backend/IPC capability, and does not mount protected workspace content.

New/missing security preferences default to application auto-lock after 15 minutes, vault auto-lock after 30 minutes, clipboard cleanup after 30 seconds, manual vault unlock on every start and no remembered master password. Explicit saved preferences remain authoritative. Set a master password before app auto-lock can authenticate a return. Clipboard cleanup uses the existing compare-before-clear policy.

Scope: the running application's UI lock protects new operations; existing output remains in process memory and already accepted operations, transfers and tunnels continue. A restart now also requires the master password before SQLCipher opens the database (see below). Telnet remains plaintext on the network. A compromised trusted renderer, administrator or memory dump of an open workspace is outside the screen-lock guarantee. First-seen raw SSH keys still use strict TOFU; changed keys are rejected. SSH certificates remain unsupported and are explicitly rejected after the russh upgrade rather than silently treating them as raw keys.

## Whole-database encryption (2026-11-08)

Production SQLite storage is SQLCipher 4.20.0 / SQLite 3.54.1 with AES-256-CBC
and per-page HMAC-SHA512 authentication, including WAL payloads. Temporary
SQLite storage is memory-only and statement logging is disabled. A random
database key is wrapped under the user's master password using Argon2id,
domain-separated HKDF-SHA256 and AES-256-GCM. Neither the raw key nor the
password is stored beside the database or passed in process arguments. The
database key is never exposed through HTTP/IPC.
Vault items keep their existing independent inner encryption.

The authenticated startup gate has no database pool or protected routes until
explicit password verification succeeds. Stored Windows passwords cannot bypass
it. New workspaces require a confirmed password of at least 10 characters; an
existing vault keeps its current password. Incorrect attempts are rate limited.
An application lock after startup still preserves database connections, keys and
session state in RAM; closing Netrix is required to release those runtime copies.

Legacy migration never rekeys plaintext in place: it exports to a new encrypted
file, verifies all rows/schema/relationships, fsyncs and reopens a separate
encrypted recovery set, then atomically replaces the original. Unknown/corrupt
key files, broken references, active legacy writers and failed copy/verification
stop conversion. Startup does not silently create an empty replacement. See
`DATABASE_STRUCTURE.md` for crash recovery and the coupled backup files.

Password rotation uses a durable two-wrap transition before committing vault
rotation. Startup accepts only the password matching the committed vault and
prunes the pending wrap. Historical backups retain their original passwords.
This changes key wrapping, not the random database key: a previously copied key
file and its matching old password can still decrypt later copies of that
database. Pruning the live key file cannot revoke an attacker's archived copy;
full key replacement after compromise is a separate operation. Never report a
failed finalization as a fully completed rotation.
Resetting saved credentials preserves the workspace password verifier.

The local `vendor/libsqlite3-sys` adapter retains SQLx 0.8's upstream Rust ABI
bindings and builds the pinned, checksummed `sqlcipher-src` 420.0.0 release with
the supported native LibTomCrypt provider. Its entropy entry point uses Rust
`getrandom` and fails closed on OS RNG failure, without LibTomCrypt's clock-jitter
fallback. It replaces the obsolete bundled
SQLCipher in libsqlite3-sys 0.30.1. No cryptographic C implementation is modified;
runtime tests reject an absent or unexpected cipher implementation.

This covers SQLite contents, not every file on the computer. UI preferences
(including group-display preferences), SSH known-hosts, diagnostic logs and
user exports are separate. Old plaintext backups and recoverable SSD/filesystem
remnants from before conversion are not securely erased by replacing the file.
An unlocked process must decrypt data in memory; local administrator/debugger
access and a compromised trusted renderer remain outside at-rest protection.

## Known Findings

### High Priority

- No open high-priority credential-in-URL finding is currently tracked. Keep the quick-connect ticket flow covered by regression tests.

### Medium Priority

- Tauri CSP still includes `style-src 'self' 'unsafe-inline'` for current inline styles. Removing it requires a UI/style audit.
- Tauri still allows inline styles for current UI compatibility. Window/plugin capability additions require per-label review and must not restore `core:default` or webview shell permissions.
- Endpoint rate limiting covers network tools and vault unlock. Snippets and other mutation endpoints do not yet have dedicated rate limits.
- Input validation is still weaker for quick actions and highlighting than for hosts, network tools, snippets, and network-map payloads.
- SFTP uploads use exclusive 0600 temporary files and checked CLOSE before rename. Replacement requires explicit confirmation and advertised atomic rename support; it never truncates or deletes the old file as a fallback. File mutation APIs require the token; delete requires exact-path confirmation and removes only files/symlinks or empty directories.

### Low Priority

- Audit log table exists, but audit writes are not comprehensive.
- Known-host entries store base64 public key bytes labeled as fingerprints. This is functional for comparison, but a hashed fingerprint display would be better for UX.
- Frontend production build drops console output, which is good for leakage but means user-visible errors must be surfaced in UI state.

## Accepted Dependency Audit Risks

Revalidated on 2026-11-08 after compatible lockfile updates and the russh upgrade.

- Backend now uses `russh 0.65.1`, `crypto-bigint 0.7.10`, `ctutils 0.4.8`, `rustls 0.23.46`, `rustls-webpki 0.103.16`, `webpki-roots 1.0.11`, `h2 0.4.20`, `tokio 1.54.1` and `event-listener 5.4.2`. The previously pinned crypto-bigint prerelease required upgrading russh. Latest source/changelog: https://github.com/Eugeny/russh/releases/tag/v0.65.1 . Earlier russh/cryptovec and anyhow advisories remain resolved.
- `RUSTSEC-2023-0071` was updated on 2026-11-08: RSA >=0.10.0 is patched. The active SSH path now uses `rsa 0.10.0` / `ssh-key 0.7.0-rc.12`. Since published russh 0.65.1 pins the old prereleases, `vendor/russh` carries only dependency-pin and key-type compatibility changes (see its `NETRIX.md`); no RSA algorithm is modified. The global advisory ignore is removed. Encrypted RSA/Ed25519 authentication and strict host-key regressions remain required.
- The same `RUSTSEC-2023-0071` also appears for `rsa 0.9.10` through `sqlx-mysql` in `Cargo.lock`. This is treated as an audit false positive for the active backend build: SQLx default features are disabled, Netrix uses SQLite only, and `cargo tree -i sqlx-mysql` / `cargo tree -i rsa@0.9.10` return no active dependency path.
- Backend retains unmaintained-package warnings for `serial` (portable-pty) and `pin-utils`; these are distinct from vulnerability findings.
- The Tauri lockfile now has zero vulnerability entries across targets and five informational warnings. `quick-xml` is 0.42.0; the former 0.39.x path is gone. `npm run audit:tauri` still checks the active Windows graph without advisory ignores. Linux support still requires platform-specific review/testing.
- `npm audit --prefix frontend` reports zero vulnerabilities, including development dependencies (`vite 6.4.5`, `vitest 4.1.12`). This is a dated audit result, not a guarantee against future advisories.

## SQL Safety

Normal request paths use SQLx binds. Keep this rule. The migration runner uses `raw_sql` only for trusted embedded migration files, and commits each script together with its migration marker in one transaction.

## Filesystem and Desktop Access

- Backend app data writes include database, log files, generated secrets, vault salt, and known_hosts.
- Encrypted-storage and SSH-trust publication share a same-volume atomic replacement helper. On Windows it resolves ordinary relative/UNC paths before adding the extended-length prefix, preserves already extended paths and Unicode, and rejects embedded NUL/device paths. `MoveFileExW` retains replace/write-through flags; failure never falls back to deleting the original. SQLite connections use the built-in `win32-longpath` VFS with normal locking/WAL semantics so long profile paths also support migration and recovery.
- Packaged Windows data uses `%APPDATA%/com.netrix.app`, matching the bundle identifier. Upgrade startup migrates legacy `%APPDATA%/Netrix` entries without overwriting conflicts. A conflict in SQLite/WAL, Vault identity, or known-host files stops the whole legacy data-set move so those coupled files are never split; the unchanged legacy tree is logged for manual recovery.
- Frontend SFTP download may use the browser File System Access API when available, otherwise browser download behavior. Batch destination access comes only from an explicit directory picker; handles are transient and existing-name replacement asks for confirmation. No backend local-write API or general filesystem capability is exposed. Sequential downloads retain the per-file 128 MiB bound and require backend completion before committing a local writable or offering a browser download. Active-file growth is accepted only as a bounded copy of the initial byte range and is reported in job warning metadata; this is not a remote consistency/snapshot guarantee.
- The main Tauri window can watch and answer a single WebView2 `FileReadWrite` permission request during the Files destination picker. The handler requires a user-initiated request from the packaged app origin or configured development origin. Approval comes from the in-app Files dialog, is keyed to the outstanding picker and is never saved in the WebView2 profile. Closing the dialog, leaving the view, navigating away or timing out denies the deferred request. These commands accept no file paths or bytes and grant no filesystem API to the frontend. Other requests and unsupported runtimes keep their platform handling.
- Clipboard permissions allow read/write text.
- Fixed-purpose main-window credential commands replace the former generic keychain plugin permission. The credential target is fixed to `master.com.netrix.app.vault`; isolated tests use UUID-scoped entries and never touch that target.

## API Exposure Rules

- Never bind the backend to `0.0.0.0`.
- Do not add unauthenticated endpoints.
- Do not widen CORS to arbitrary origins.
- Do not expose vault plaintext through HTTP responses; secret access stays inside authenticated backend connection and encrypted-backup flows.
- Do not log request bodies for vault, host credential, quick-connect, snippet, or SFTP upload endpoints.

## Hardening Roadmap

1. Add rate limits or delay controls to remaining sensitive mutation endpoints.
2. Tighten CSP further by removing inline style requirements if compatible with production runtime.
3. Maintain SFTP negative-path, commit/cancel and transfer-bound regressions, plus interoperability on OpenSSH and network appliances.
4. Periodically review the documented backend `rsa` advisory exception and remove it when the SSH dependency chain no longer requires it.

## Runtime hardening

- Terminal bytes and transport controls use distinct WebSocket frame types; JSON-looking terminal input, __JSON__ output and the former transport-ended sentinel remain ordinary bytes. Internal transport events are typed, not embedded in byte streams.
- Empty API tokens fail closed, even when AppState is constructed outside the normal startup path.
- Argon2 derivations run in spawn_blocking with two shared execution slots. Key containers and temporary password/key copies use Zeroizing; this does not promise that third-party cryptographic implementations or transport libraries have no internal copies.
- Installation identity files are validated and durably written before atomic publication without overwriting existing identity. Invalid/unreadable files and failed writes are startup errors. Missing .vault_salt beside an existing database is rejected; restore the original matching salt rather than generating another. Backups must preserve database.db, its WAL when active, and .vault_salt together.
- Test SSH/WebSocket/Telnet servers bind to loopback and use disposable credentials and app-data directories. They never contact saved user targets.
- Closing a terminal uses token-authenticated DELETE by its exact session ID, independently of WebSocket availability. A failed acknowledgement retains a retryable tab. Window handoff must use explicit session-preserving release. Fresh sessions without a client ID acknowledgement are cleaned up; interactive SSH cancellation force-closes its own TCP transport, with no changes to host-key verification or SFTP connections.

## SFTP transfer security

Temporary target credentials are zeroized; pooled transports are isolated from terminals and keyed by process-salted authentication/trust digests. Transfer registries retain bounded metadata only. Failed uploads discard their transport and perform bounded cleanup on a fresh connection. If the server cannot be reached, a partial temporary file can remain and its path is reported. Restore cannot replace workspace data under a running worker. Atomic replacement preserves ordinary mode bits, but does not preserve ownership/ACL/hard-link relationships or lock concurrent remote editors. See [SFTP implementation](SFTP_IMPLEMENTATION.md) for exact bounds and limitations.

Host credential flags are non-secret metadata derived from active password/private_key fields, excluding legacy recovery backups. Successful unlock repairs missing flags; archive restore recomputes them. Public host decoding whitelists fields. Revision checks prevent stale editors from overwriting profiles after another mutation or workspace restore; legacy PUT clients remain responsible for using revisions. Existing strict TOFU and localhost/token requirements apply unchanged.

Changing a saved host's protocol in the editor shows an authentication notice. Saving a different protocol replaces its credentials with newly entered values, or explicitly clears the old credential link if no replacement was entered; it never silently carries SSH credentials into Telnet or a local/serial profile. Returning to the original protocol before saving retains the saved link. Switching protocols clears transient password/key/passphrase state and invalidates asynchronous key reads. These rules use the existing revision-aware host PATCH API and do not alter shared credentials on other hosts.

Terminal appearance defaults use an explicit client allowlist (theme, font size, background, foreground and validated renderer options). Saving a host remembers this appearance only after the authenticated host write succeeds. Hostnames, usernames, passwords, private keys and shell commands are excluded from this local preference. Backend appearance metadata is a bounded typed object, with validated ANSI color keys and no command execution.

## Medium audit regression boundaries (2026-11-12)

- Terminal broadcast accepts explicit keyboard events, approved paste and Quick Actions. General xterm `onData` (including remote DSR/DA/color replies) is sent only to its source session. No ESC-byte filter is used. Quick Actions decode documented escapes once and add no implicit Enter.
- Connecting tunnels reserve a cancellable job before network IO. Stop, rule deletion and host deletion cancel pending authentication as well as active forwarding; saved-rule lookup and registration serialize with deletion.
- Desktop E2E builds use `com.netrix.e2e.<UUID>` and verify build hashes before any launch. The shell requires the matching identifier, skips legacy migration outside `com.netrix.app`, and derives the credential service from its trusted Tauri identifier. Production retains `com.netrix.app.vault`; renderer callers cannot select the service. WebView storage and app data/cache use separate test paths/namespaces. No Tauri capability was expanded.
- Direct `cargo test` uses temporary unit-test identities and integration fixtures initialize their unique process profile before global settings. Inherited production/development profile variables are replaced in tests.
- `npm run audit:backend` does not ignore advisory IDs. An inactive target dependency is reported separately. For RUSTSEC-2026-0459 only, the libsqlite3-sys 0.30.1 **ABI label** is reconciled against the effective local adapter path, LF-normalized adapter SHA-256 hashes, the locked/checksummed sqlcipher-src release and exact linked SQLite/SQLCipher versions/source ID. The runtime probe executes before profile initialization and emits the binary hash. Any changed evidence or other active vulnerability fails the gate. Review `scripts/backend-audit-policy.json` on upgrades; do not regenerate it to silence a failure.

Primary advisories: [RSA](https://rustsec.org/advisories/RUSTSEC-2023-0071.html), [SQLite WAL disclosure](https://rustsec.org/advisories/RUSTSEC-2026-0459.html). The reviewed source is SQLCipher 4.20.0 / SQLite 3.54.1, above the advisory's SQLite 3.54.0 fix boundary.
