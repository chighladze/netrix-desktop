# Testing

## Sidecar lifecycle

```powershell
cargo test --locked --manifest-path backend-rs/Cargo.toml --test sidecar_lifecycle_tests
cargo test --locked --manifest-path backend-rs/Cargo.toml --lib shutdown
npm run test:tauri
npm run test:run --prefix frontend -- AppSecurityBoundary appClose
npm run check
```

The backend tests cover EOF before profile initialization, release of the port
and workspace lock, persistence across restart and shutdown with an active
WebSocket/Telnet bridge. They check unauthenticated readiness, SFTP cancellation
with a pending commit and rejection of new work during shutdown. Real lock
contention covers successful wait, EOF cancellation and `workspace_busy` at
15 seconds. Tauri tests cover forced termination past the grace period. Vitest
covers early main-window close, confirmation and detached-window close.

```powershell
npm run test:e2e:desktop:build -- --lifecycle
```

This Windows test requires an interactive desktop, WebView2, loopback access
and PowerShell 7. It launches a hash-verified `com.netrix.e2e.*` build with its
own WebView data folder. It checks normal close from the lock screen, detached
terminal and map capabilities, termination of the shell PID and immediate
unlock after restart, backend process loss and launch failure. A separate test
parent holds the private pipe without a Netrix Job Object and is terminated to
exercise EOF fallback. The test checks actual child PIDs and listener release.
The build-based test uses the debug sidecar path. For a local installed smoke,
build with a `com.netrix.e2e.<32 hex digits>` identifier and unique product
and main executable names. Install only that QA product. Point
`NETRIX_E2E_BUILD_ROOT` at a directory with `build.json` in the existing E2E
manifest format, using the installed shell and sibling sidecar paths and hashes.
Run `node scripts/sidecar-desktop-smoke.mjs --installed`. The debug-only missing
sidecar override is skipped for an installed build. Run the full installed
candidate matrix separately for clean-machine dependencies and signatures. See the
[installed-build checks](build_instructions.md#verify-an-installed-build).

```powershell
npm run build:sidecar:debug
cargo test --locked --manifest-path src-tauri/Cargo.toml backend_process::restart_tests::restart_waits_for_the_previous_sidecar_when_job_assignment_is_denied -- --exact --ignored --nocapture
```

The native test supplies a Job handle without assignment rights to the real
supervisor. It expects Windows error 5, stalls a request and kills the supervisor.
The replacement must wait for the old lock, reopen the workspace and read the
committed row with the original lock-file bytes preserved. See [Windows Job assignment](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

## Problem reporting

```powershell
npm run test:run --prefix frontend -- src/features/feedback src/components/HelpCenterModal.test.tsx src/features/security/AppSecurityBoundary.test.tsx src/App.navigation.test.tsx --maxWorkers=2
cargo test --locked --manifest-path src-tauri/Cargo.toml problem_report::tests
```

Tests cover safe fields, the fixed GitHub form, URL encoding, long reports,
preview, clipboard and IPC failures, and access from Help and the startup gate.
Check the form at narrow sizes, keyboard focus and prefill without submitting
an issue.

## Startup diagnostics

```powershell
cargo test --locked --manifest-path backend-rs/Cargo.toml --bin netrix_backend startup_diagnostics::tests
cargo test --locked --manifest-path backend-rs/Cargo.toml --test startup_diagnostics_tests
cargo test --locked --manifest-path src-tauri/Cargo.toml backend_diagnostics::tests
npm run test:run --prefix frontend -- src/api.test.ts src/features/security/AppSecurityBoundary.test.tsx --maxWorkers=2
```

Tests distinguish generic exit 1 from Windows loader and crash statuses. They
verify allowlisted diagnostics, recovery controls and a workspace that remains
locked even if an unlock response arrives after confirmed failure. Manual UI
checks cover missing-library and unknown-cause messages at normal and narrow
sizes.

## Installer and payload checks

Windows CI reads `ProductName` and `ProductVersion` from the debug backend EXE.
`npm run check:windows:binaries` repeats this check on the release sidecar that
NSIS embeds. Both values must match `productName` and the full `version` in
`src-tauri/tauri.conf.json`, including any prerelease suffix.

Windows installer changes require `npm run test:scripts`, `npm run check:tauri`
and `npm run test:tauri`. After a Tauri build has installed the NSIS toolchain,
`npm run test:installer` compiles the production runtime hook with harmless native
fixtures and exercises eight scenarios: available, missing/repaired,
installer-failed, still-unavailable, unexpected probe exit, probe timeout,
unexpected exit after repair and an invalid executable that cannot launch.
Launch errors, timeouts and unexpected exits must report that runtime availability
was not determined; they must not claim WebView2 is missing. This does not emulate
Smart App Control enforcement. The test never runs Netrix or the
Microsoft installer, writes only its isolated temporary directory, and deletes
only that directory. `npm run check:windows:binaries` then checks both actual
release EXEs with dumpbin, rejects redistributable DLL imports (including delayed
ones) and verifies PE architecture, sidecar staging hashes and the NSIS payload
source. It exercises the read-only WebView2 probe.
Both commands are required by `release:check`. Run the
[installed-build checks](build_instructions.md#verify-an-installed-build) for clean-profile and offline acceptance.

## UI and workspace regression checks

Shared form styling is verified with frontend typecheck/build and the existing modal and module tests. `QuickActionModal.test.tsx` covers footer submission with unchanged command text, edited metadata and explicit delete/cancel behavior. For visual QA, check dialogs at 1280×800 and 460×560: 12px corners, no horizontal overflow, visible footer actions and internally scrollable fields. Check Connections and Settings at narrower content widths as well as desktop width; keep circular switches and status indicators intact.

`HostFormModal.test.tsx` covers Save host and Connect only for SSH, Telnet, Serial and Local shell, independent port drafts, active-protocol payloads, saved credential unlink/replacement, exact local arguments, key-file cancellation, missing-key passphrases, password generation, vault-gated saves and appearance settings. Visual QA includes all protocol layouts, SSH key authentication and expanded appearance at 1024×640, narrow fields at 420×640, keyboard radio navigation and returning from Vault without losing the draft. Use disposable fixtures; these UI checks do not connect to saved hosts or real serial devices.

Whole-database encryption has focused unit tests in `database_encryption.rs` and
an authenticated startup/rotation/reset/restart test in `startup.rs`:

The startup fixture runs the production workspace shutdown, awaits its pool
close before reopening the profile and checks that the temporary directory can
be removed on Windows. An access violation after a passing assertion summary
fails the release gate.

`AppSecurityBoundary.test.tsx` additionally checks explicit password reveal and concealment, relock clearing, Caps Lock feedback, Unicode setup length, correction of stale errors, exact existing-password submission, duplicate-submit prevention, disabled pending controls, retry focus and backend-error recovery. Visual QA uses disposable mocked startup snapshots for encrypted startup, setup, upgrade-in-progress, an existing session lock and backend failure, including a 360×480 viewport. Do not use a real workspace or master password for these UI checks.

```powershell
cargo test --manifest-path backend-rs/Cargo.toml database_encryption::tests --lib
cargo test --manifest-path backend-rs/Cargo.toml startup::tests --lib
npm run test:run --prefix frontend -- src/features/security/AppSecurityBoundary.test.tsx
```

Direct `cargo test` now isolates settings before first use: unit tests select a UUID temporary identity and every integration fixture calls `tests/common::init()`. No environment override is required. New fixtures that can reach `SETTINGS` must call this helper first; never set process environment independently in parallel tests. Standalone application/smoke launches still require an explicitly disposable profile. Tests use UUID-scoped temporary databases, never saved hosts or real credentials. Coverage includes every-table
roundtrip, independently reopened encrypted backup, WAL recovery, live-writer
rejection, both sides of atomic replacement, partial output, wrong/missing/corrupt
key, ciphertext tampering, process exclusion, both password-rotation crash windows
and reset preserving the encrypted workspace verifier. Intentional wrong-key and
tamper tests may print SQLCipher HMAC errors; these are expected rejection paths.
The SFTP smoke runner now opens its disposable database via `/security/unlock`.

Electricity variation tests exercise 500 seeded passes across wide/narrow layouts: every complete ten-strike bag uses all variants, neighboring route families cannot repeat, and a pair changes its variant on the next pass. Geometry tests verify distinct paths, glyph-bounded randomized contacts and stable remeasurement. Binary-content tests exercise 500 seeded passes plus repeated random edge values, checking six distinct balanced octets, at least three changed digits per group and no previous-pass values. Component tests cover actual iteration-event renewal, synchronized base/lit digits with retained DOM nodes, hidden/restored octets, stable content on resize, preserved cadence and no regeneration after stop/completion. Run `npm run test:run --prefix frontend -- src/terminal/connectionBits.test.ts src/terminal/connectionLightning.test.ts src/components/ConnectionBitStream.test.tsx src/components/ConnectionStatusPanel.test.tsx src/components/TerminalCanvas.test.tsx --maxWorkers=4`.

Terminal appearance regressions cover all 16 ANSI colors plus cursor/selection colors, typography bounds (including Unicode font names), false/zero values, live xterm updates without clearing ANSI output, per-color/global reset, Quick Connect, and appearance-only defaults across new/edit/failed-save flows. Run `npm run test:run --prefix frontend -- src/terminal/appearance.test.ts src/themes.test.ts src/features/settings/terminalOptions.test.ts src/components/HostFormModal.test.tsx src/components/TerminalCanvas.test.tsx src/features/settings/settings.test.ts`. On machines under heavy load use `--maxWorkers=4` for the full frontend suite. `cargo test --manifest-path backend-rs/Cargo.toml --test management_tests` covers host/recent DTO round trips, replacement/null semantics and encrypted backup compatibility; migration tests preserve old hosts.

For a real HTTP/SQLite persistence check, build the backend with `cargo build --manifest-path backend-rs/Cargo.toml`, then run `node scripts/terminal-appearance-smoke.mjs`. It launches the debug backend with its own temporary data directory and stdin token, checks every appearance field, rejects invalid payloads, restarts the process to verify persistence, tests replacement/reset, and removes its test data. It does not connect to remote hosts or use the user's database. Browser QA should save a profile through HostFormModal, reload, open a blank new form to verify remembered defaults, and edit a running real xterm to confirm palette/font/cursor changes preserve output. ANSI palette overrides do not recolor explicit truecolor output; italic/underline and actual prompt text remain controlled by the shell.

Standalone detached-window regressions cover workspace routing from both tab detach and pane extraction, all four layout controls with an unchanged mounted terminal/session ID, and the real empty-pane connection picker. The desktop smoke also switches a single detached session through every layout while checking xterm/socket identity and the loopback transport count; floating-window checks use the active local tab ID.

Cross-monitor drop regressions cover native physical coordinates overriding a different DOM sample, native coordinates arriving during final validation, a transient native hit-test miss, Escape during retry, and rejection outside the destination despite a prior armed hover. The desktop smoke reads physical monitor bounds through `scripts/terminal-monitor-layout.ps1` and, when two displays are available, places only its isolated source/main windows on different monitors for single and grid returns. It prints both scales; absent a second display this step is skipped. Physical mouse gestures remain manual.

Floating drag-return regressions cover one/four-session drops with release before the native move acknowledgement, matching DOM release while native observation is delayed, duplicate completion, wrong pointer IDs, and native Escape during the bounded DOM fallback. The desktop smoke returns the complete four-session grid through the title drag path (instead of Return), retaining pane/session IDs and the loopback TCP count. The existing standalone title-drag scenarios remain covered. Physical mouse interaction remains part of manual validation.

Single-mode regressions cover one/multiple members in columns/rows/grid, ordinary tab identity, clearing stale chooser reservations, retaining focus/controller/socket/session identities, untouched unrelated groups, and fresh splits containing only the selected tab. Maximize retains its separate temporary-group behavior. Detached tests cover local tab selection and serialized Return with failed later entries retained; workspace handoff tests cover plain independent tab-strip drops. The isolated desktop smoke exercises the main and floating Single transitions, individual tab drag back to main, native group-tab extraction after re-splitting, and final Return with six unchanged loopback transports. Screenshots `23`â€“`26` record those states.
Controller regressions additionally hold cached renderer restoration during capture, reject a detached/replaced renderer, and retain the existing byte-checkpoint-before-write-barrier test for already active renderers. This covers immediate drag/Return after selecting a hidden Single tab.

Drag stability regressions cover overlapping hover/drop geometry replies, source-scoped hint cleanup, aborted probe listener disposal, Escape while final placement is pending, native capture-loss/blur fallback with a frozen physical release point, duplicate completion and refusing occupied-window drops. Native registry tests cover old/foreign/cancel-before-start observer cancellation. Focused commands: `npm run test:run --prefix frontend -- src/terminal/pointerDrag.test.ts src/terminal/useTerminalPaneDrag.test.tsx src/terminal/dockingQuery.test.ts src/components/TerminalDockTarget.test.tsx src/components/terminalPaneDrag.test.tsx src/components/DetachedTerminalFrame.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml terminal_drag::tests`. Actual OS mouse dragging and mixed-monitor DPI still require the manual lifecycle matrix.

Individual pane extraction covers an exact single-session offer and delayed source release, local extraction without controller/socket disposal, stable neighboring slots in columns/rows/grid, Escape/tiny-drag/occupied-target cancellation, and fixed native routing/permission validation. Focused tests: `moveTerminalPane.test.ts`, `useTerminalPaneDrag.test.tsx`, workspace group tests and `cargo test --manifest-path src-tauri/Cargo.toml terminal_window::tests`. The isolated Windows smoke drives the pane grip to the main tab strip and outside all terminal windows, opens a real native standalone window, checks neighboring xterm/socket identities and empty slots, then returns both extracted sessions and the remaining group without new TCP connections. Screenshots `19`â€“`22` record those states.

Layout-selection regressions verify that columns/rows/grid start with the selected session only, retain manually filled slots when switching layouts, and leave other tabs independent. Return regressions verify serialized preparation, queued cancellation, waiting for outgoing capture without deadlocking independent opposite-direction moves, unminimizing before preparation, clearing stale picker reservations, and retaining the incoming renderer during shortcut navigation. The isolated desktop smoke holds one replay barrier while two native windows request Return, then verifies unchanged session IDs/TCP count and an unchanged existing group; it also returns into a minimized main window.

Exact-pane docking adds store/rendered coverage for stable holes and explicit pane reservations in columns/rows/grid, main-tab drag routing to local/remote cells, addressed probes, occupied/missing/busy cell refusal, incoming replay rollback without destination closure, and detached saved-host selection in pane four while pane three remains empty. `scripts/terminal-window-smoke.mjs` additionally exercises detached Choose a connection, actual tab-pointer insertion and floating-window insertion into a detached grid, then returns the filled grid with unchanged pane/session IDs and TCP count.

Split-group regressions cover independent layouts and standalone tabs, pane replacement/vacancy, explicit empty-pane additions, group selection/ungroup/close, multi-member capture and secret redaction, all-member replay readiness, rollback restoring the prior view/order, and detached close waiting for authenticated deletions. Focused command: `npm run test:run --prefix frontend -- src/features/workspace/groups.test.ts src/components/TerminalWorkspace.test.tsx src/components/TerminalTabsBar.test.tsx src/components/DetachedTerminalWorkspace.test.tsx src/terminal/windowHandoff.test.ts src/terminal/workspaceHandoff.test.ts`.

Terminal window handoff has transaction/StrictMode/checkpoint/xterm/close/DPI regressions plus a real Windows-webview loopback smoke. Run the dedicated-identifier and dedicated-target workflow in [Terminal window handoff](TERMINAL_WINDOW_HANDOFF.md); `APPDATA` alone does not isolate Tauri's native Windows profile directories. The smoke covers three detach/return cycles, the actual tab pointer sensor/preview/Escape, insertion between tabs, native-close dialog return, and simulated dock-hover entry/exit/drop, including unchanged xterm dimensions and a stationary destination. OS dragging across monitors remains manual. Gesture tests also reject tiny clicks, stale hover replies and duplicate completion; placement tests cover monitor work-area bounds at fractional DPI.

SFTP view regressions cover switching away/back during a listing (including cached data and late replies), closing a loading preview, and an old confirmed mutation completing while another host's preview is busy. Transfer-hook tests verify that cancelling a batch does not reload the outgoing host. Disconnect API errors are surfaced. Real-server smoke scenarios additionally verify independent disconnect for two saved profiles at one endpoint, no pool resurrection after an in-flight listing, and cancellation of stalled setup.
SFTP download regressions also cover bounded copies of growing logs, rejection of truncation/early EOF/CLOSE failures, Ctrl/Command/Shift multi-selection, filtering selection, sequential downloads, directory-picker cancellation, local replacement refusal, sanitized filename collisions and partial-batch failure. `scripts/sftp-smoke.py` appends to a real local SFTP file after initial FSTAT and verifies original-byte equality plus completed-job warning metadata.
Profile target changes also discard old paths and selection, while cosmetic profile edits retain the listing; both are covered by rendered component tests.

Saved-host regression coverage: `management_tests.rs` checks invalid/corrupt/missing credentials and legacy migration boundaries across SFTP, snippets and tunnels; a listening loopback socket verifies no rejected operation contacted the destination. `terminal_transport_tests.rs` checks the equivalent WebSocket errors, strict rejection of jump routes, and real SSH reattach/echo after Vault lock followed by refusal to open a new transport. Each protocol fixture uses an independent Known Hosts path and shares that store between its terminal and SFTP managers, preserving strict verification without parallel file-write contention. Snippet API tests cover partial edits, explicit metadata clearing and validation rollback. `SnippetFormModal.test.tsx` verifies exact PATCH fields, registered create URLs, whitespace preservation and failed-save input retention. These tests use in-memory SQLite and isolated loopback servers.

## Current Automated Tests

Backend tests live in `backend-rs/tests/`.

- N01–N03 regressions: `terminal/connectionIdentity.test.ts` exercises saved-profile edits, exact resume/new-session identity, stale acknowledgements, input readiness and credential exclusion. `TerminalCanvas.paste.test.tsx` uses real xterm DOM paste events and native clipboard mocks to cover CR/LF confirmation/cancel, size limits, bracketed paste, broadcast and stale async destinations. `App.navigation.test.tsx` checks identity propagation and confirmation in the standalone detached window. Run `npm run test:run --prefix frontend -- src/terminal/connectionIdentity.test.ts src/terminal/TerminalSessionController.test.ts src/components/TerminalCanvas.paste.test.tsx src/components/TerminalCanvas.test.tsx src/App.navigation.test.tsx`.
- `terminal_transport_tests.rs` verifies that profile A → B edits preserve A's reattachment descriptor and that a new session reports B and sends bytes to B's loopback TCP receiver. `ssh::known_hosts::tests` checks missing/valid stores, invalid UTF-8, malformed/duplicate records, read failures, unchanged damaged files, trust mismatch and durable writes. Focused backend commands: `cargo test --manifest-path backend-rs/Cargo.toml --test terminal_transport_tests` and `cargo test --manifest-path backend-rs/Cargo.toml --lib known_hosts::tests`. Use an isolated `NETRIX_DATA_DIR` and unset `NETRIX_DEV` when running security regressions.
- `api_tests.rs`: integration-style Axum tests for authenticated health/readiness, host CRUD, validation, serial port behavior, SFTP capability basics, vault reset/status/lock/change password, saved host credential lifecycle, vault unlock rate limiting, orphan credential cleanup, auth middleware, quick-connect tickets, and selected network-tool validation.
- `vault_tests.rs`: vault unit tests for key derivation, encryption/decryption, nonce uniqueness, wrong-key failure, tamper failure, short payload failure, empty plaintext, and large plaintext.
- `db.rs` unit tests: migration registry completeness and rollback of schema changes plus bookkeeping after a failing multi-statement migration.
- `vault_tests.rs` also exercises a file-backed WAL-mode legacy database upgrade and verifies its plaintext marker is absent from SQLite database/WAL files after cleanup.
- `ssh::manager` unit tests: session reuse, multiple sessions, detach lookup, multi-client detach behavior, cleanup, reattach resume guard, history replay, and session-ended markers.
- `ssh::sftp` unit tests: SFTP directory/packet bounds, preview limits, exclusive temporary uploads, CLOSE failure, confirmed atomic replacement, permission preservation, pipelined/out-of-order acknowledgements and partial reads, plus job ownership/cancellation/commit races.
- `network_map_tests.rs`: cross-map edge rejection, map-id/endpoint consistency, payload bounds, and transactional duplicate/delete graph behavior.
- Frontend API/readiness tests cover structured errors, invalid JSON, safe retry rules, token refresh, and backend status polling.
- Frontend store tests cover vault lock failure/success and known/unknown status transitions; Vault helper tests cover first-time master-password length and confirmation. Terminal-controller tests cover hidden-renderer replay bounds, reconnect after terminal errors, and quick-connect ticket success/failure.
- Frontend NetworkMap helper tests cover edge paths/waypoints, rendered bounds, zoom limits/anchors, resize stability, minimap letterboxing, fitting around an inspector, connection-property parsing, multi-term device/status search and complete deletion recovery (including partial failures and map switches).
- `NetworkMap.test.tsx` covers selection without writes, release outside the canvas, native wheel handling, search navigation, connection draft retention/retry, persisted label/route clearing, device-edit cancellation, accessible add-dialog dismissal, deletion with incident-link restoration, and input/map-scoped shortcuts. Focused command: `npm run test:run --prefix frontend -- src/features/network-map src/components/NetworkMap.test.tsx`. Browser QA should additionally exercise real SVG transforms while opening panels during a drag, Pan/zoom/Fit, minimap clicks and compact windows; use a synthetic topology when testing edits and ping presentation.
- `App.navigation.test.tsx` covers sidebar navigation with single/split terminals: renderer layout effects survive lazy-module loading, pane DOM/local state and session IDs remain intact, closed tabs dispose their renderers even while hidden, and restored tabs stay dormant until Terminal is opened. `TerminalHints.test.tsx` checks that hidden terminals do not intercept hint shortcuts. Focused command: `npm run test:run --prefix frontend -- src/App.navigation.test.tsx src/components/TerminalHints.test.tsx`.
- `TerminalCanvas.test.tsx` covers command-history privacy in main/detached renderers: typed passwords, pasted input, screen text, edits after action insertion and legacy persisted history never enter launcher history/export. It also checks unchanged input forwarding, successful explicit Quick Action history and blocked handoff sends. Focused command: `npm run test:run --prefix frontend -- src/components/TerminalCanvas.test.tsx`.
- Terminal retention regressions cover repeated single-tab switching with unchanged DOM/local state, selection and scroll position, lazy activation of unvisited tabs, hidden-tab disposal, split/maximize/restore and explicit pane positioning when strip order differs. `TerminalCanvas.test.tsx` also verifies that mounting/closing a neighboring terminal does not clear selection. Focused command: `npm run test:run --prefix frontend -- src/components/TerminalWorkspace.test.tsx src/components/TerminalCanvas.test.tsx src/App.navigation.test.tsx src/components/DetachedTerminalWorkspace.test.tsx`. Browser QA with the real xterm should stream more than 2 MiB into a hidden alternate screen, switch back, and verify normal/alternate buffers, saved cursor, colors, a split escape sequence, search query/result/viewport and unchanged socket count; scrollback eviction at the configured line limit remains intentional.

Current backend coverage includes library unit tests, binary CORS tests, API integration tests, and vault crypto/lifecycle tests.

## Validation Commands

- Full validation: `npm run check`.
- Rust formatting: `npm run check:fmt`.
- Backend compile: `cargo check --manifest-path backend-rs/Cargo.toml` or `npm run check:backend`.
- Tauri shell checks on Windows: run `npm run build:sidecar:debug` before standalone `npm run check:tauri` or `npm run test:tauri` on a fresh checkout.
- Backend lint: `cargo clippy --manifest-path backend-rs/Cargo.toml --all-targets -- -D warnings` or `npm run lint:backend`.
- Backend tests: `cargo test --manifest-path backend-rs/Cargo.toml` or `npm run test:backend`.
- Frontend typecheck: `npm run typecheck --prefix frontend`.
- Frontend unit tests: `npm run test:run --prefix frontend`.
- Frontend build: `npm run build --prefix frontend`.
- Frontend combined: `npm run check:frontend`.
- Desktop startup E2E (requires a debug binary, `tauri-driver`, and platform WebDriver): `npm run test:e2e:desktop`; build and run it with `npm run test:e2e:desktop:build`.
- Run `npm audit` at the root and `npm run audit:frontend` for the frontend. The frontend command requires a clean runtime audit and audits development dependencies against the scoped exception in [Security rules](SECURITY_RULES.md).
- Backend dependency audit: `npm run audit:backend` (no blanket advisory ignores; validates the effective SQLCipher source/runtime and excludes dependencies absent from the selected target graph).
- Tauri Windows dependency audit: `npm run audit:tauri`. It runs cargo-audit without advisory ignores, then verifies each reported lockfile package against the actual `x86_64-pc-windows-msvc` cargo tree; any Windows-active advisory fails the command.
- The local `npm run release:check` runs the npm audits before compilation and packaging.
- Before distributing a fork, record manual installer/runtime checks for the exact EXE and checksum; see `docs/build_instructions.md`.

On Windows, running `npx tsc --noEmit --project frontend/tsconfig.json` from the root may prompt for the wrong `tsc` package. Prefer running `npm run typecheck` inside `frontend/` or `npm run typecheck --prefix frontend`.

## CI

GitHub Actions runs the public source workflow in `.github/workflows/windows.yml`:

- Frontend: Node 24.0.0 and latest 24.x, locked dependency installation, Vitest, typecheck and Vite build.
- Windows: redacted secret scan, frontend dependency audit, Rust formatting, script/backend/frontend checks,
  staged debug sidecar, native shell compile check and tests.
- Manual option: build the NSIS installer, run installer-hook fixtures, inspect
  native dependencies, hash the EXE and retain an unsigned Actions artifact.

Run the Rust dependency audits and desktop GUI checks locally. The
[Windows release notes](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.9)
record the runtime checks for the distributed EXE.

The Windows script suite probes the actual release-command runtime for PowerShell 7 and `Get-FileHash`, hashes a non-executable fixture with a space/bracket filename against an independently calculated SHA-256, and rejects multiple installer files. It does not install or launch an application.

## Testing Standards

- Add backend tests when changing validation, credential behavior, migrations, routers, SFTP capability, vault behavior, network-tool bounds, or error mapping.
- Add regression tests for security fixes.
- For frontend changes, at minimum run unit tests, typecheck, and build.
- For Tauri config, capability, IPC, or shell lifecycle changes, run `npm run check:tauri`.
- Manually test terminal session lifecycle with `docs/TERMINAL_LIFECYCLE_TEST_PLAN.md` when touching `TerminalCanvas`, `/ws/*`, or `SessionManager`.
- Manually test SFTP and Files with `docs/SFTP_FILES_TEST_PLAN.md` when touching `SftpBrowser`, `/sftp/*`, `ssh::sftp`, host credentials, or terminal/SFTP coexistence.
- Manually test Vault with `docs/VAULT_TEST_PLAN.md` when touching vault APIs, host credential storage, vault settings, OS keychain behavior, or terminal/SFTP credential loading.
- Verify the installed build in a disposable profile and record results alongside the EXE's SHA-256 before distributing it. Follow the [build guide](build_instructions.md#verify-an-installed-build).

## Coverage Gaps

- Frontend unit coverage includes focused rendered workflows for terminal, hosts, files and NetMap alongside API/store/helper coverage; full end-to-end desktop workflows remain incomplete.
- WebDriver E2E covers startup. The separate dedicated-profile terminal-window smoke covers selected native detach/return/cancel/close workflows through CDP; it does not simulate OS mouse dragging or real devices.
- Full Tauri packaging validation runs only in the tag-based release workflow; pull requests compile-check the shell on Windows.
- Loopback WebSocket detach/reattach/terminate/cancellation and selected real desktop-window flows are covered; the full interactive SSH/device/cross-monitor matrix still needs manual coverage.
- Loopback Telnet transport and SSH exec are covered; An opt-in AsyncSSH script now exercises real SFTP interoperability; OpenSSH/network-appliance variants and real Serial devices still need their manual matrix.
- NetMap gesture/inspector regressions run in jsdom; real-browser SVG geometry and native Tauri detach/reattach still require manual QA. Real network availability is not established by mocked ping fixtures.
- The backend audit rejects active RSA advisories. The documented russh compatibility patch selects the fixed RSA dependency; remove that patch when a compatible upstream release accepts those versions. Inactive SQLx MySQL lockfile entries and the pinned SQLCipher compatibility adapter are checked separately against the reviewed policy.

## Recommended Next Tests

1. Interactive SSH WebSocket lifecycle tests against a disposable OpenSSH server.
2. Desktop E2E tests for terminal detach/return/close flows.
3. Frontend smoke tests for host creation, vault unlock, terminal open error path, and SFTP host picker.
4. Desktop E2E tests for SFTP upload/download/probe flows against a disposable SSH server.
5. Historical-database upgrade fixtures beyond the current registry, rollback, and legacy-vault migration cases.

## Runtime regression tests

- Application security: `npm run test:run --prefix frontend -- src/features/security src/features/settings/settings.test.ts src/features/vault/startup.test.ts src/state/store.test.ts` covers main/detached/map boundaries, retained session drafts, failed password/status checks, forged/stale event snapshots, manual-startup precedence and preservation of saved choices. `cargo test --manifest-path backend-rs/Cargo.toml --lib security::tests` covers the shared inactivity clock and no-password setup. `api_tests` verifies 423 enforcement, no reset/vault-unlock bypass, shared rate limiting, ticket clearing and removal of plaintext GET responses; `terminal_transport_tests` verifies on a real loopback socket that blocked bytes/terminate commands do not reach the device, new attachments fail, and unlock resumes the same transport without replaying input. These fixtures do not access production credentials or remote devices.

- Exact session identity: `terminal_transport_tests.rs` opens two real loopback terminals for the same saved host, detaches/resumes them in reverse order and checks separate history/input without another TCP connection. It rejects missing IDs through canonical, saved-host and ticket routes without borrowing a detached session; live reattachment survives profile deletion and Vault lock. Manager tests check independent JavaScript-safe IDs. Frontend controller tests cover per-tab resume URLs, Quick Connect without reissuing credentials, mismatched server IDs and explicit-only replacement after `session_unavailable`. Focused commands: `cargo test --manifest-path backend-rs/Cargo.toml --test terminal_transport_tests`, `cargo test --manifest-path backend-rs/Cargo.toml --lib ssh::manager::tests`, and `npm run test:run --prefix frontend -- src/terminal/TerminalSessionController.test.ts`.

- Toolbox tests: `network_tools_tests.rs` covers authenticated request boundaries, malformed input and start quotas using isolated SQLite/loopback only. Router unit tests cover actual open/refused ports, active limits, dropping queued probes and stalled TLS socket closure. `features/utilities` and `UtilitiesHub.test.tsx` cover stale view requests, stop/unmount/timer cleanup, numeric errors, Cron/IPv4 correctness, JSON/SQL preservation and local DevTool execution without network/persistence. See [Toolbox implementation](TOOLBOX_IMPLEMENTATION.md).

- Settings/Vault regressions cover canonical/legacy storage migration, malformed fields, failed writes without state changes, bounded port edits, reset preserving SQLite highlighting, live xterm preferences, hidden controller updates, scheduled-retry cancellation, startup-policy precedence and native storage failures. Backup UI tests distinguish completed backend restore from failed local preference persistence. See [Settings implementation](SETTINGS_IMPLEMENTATION.md).
- `cargo test --manifest-path src-tauri/Cargo.toml --bin netrix` includes a real Windows Credential Manager roundtrip under a UUID-scoped test entry with cleanup, and verifies credential commands belong only to the main-window capability. Set an isolated `CARGO_TARGET_DIR`; these tests never access the production remembered-password entry or launch/stop the desktop app.

- management_tests.rs covers token/locked-vault boundaries, actual ED25519/RSA generation and encrypted key decoding, shared credential binding/rotation/orphan protection, selective/idempotent SSH config import, local file reads, SSH-only tunnel rules, and portable backup recovery under a different destination vault password. It restores an archive above 2 MiB to test the dedicated body limit; a deliberately invalid deferred foreign key verifies complete rollback after replacement has begun.
- terminal_transport_tests.rs also forwards real TCP through local and SOCKS5 tunnels, verifies stop closes existing streams/listeners, and authenticates generated encrypted ED25519/RSA keys against a loopback SSH server.
- TerminalWorkspace tests cover all layouts, persisted selection, stable visible renderers/session IDs, maximizing/restoring chosen panes, outside-tab selection, empty-pane actions, disconnect confirmation and transfer locks. TerminalLayoutControl tests cover radio selection, keyboard navigation and disabled states. Focused command: `npm run test:run --prefix frontend -- src/components/TerminalWorkspace.test.tsx src/components/TerminalLayoutControl.test.tsx src/features/workspace/panes.test.ts`. Connection-panel tests cover locked-vault mutation controls and failed restore confirmation/error flows; preference tests reject unknown/prototype/object values and unsafe numeric sizes.
- TerminalTabsBar component tests cover session selection, keyboard navigation/sort cancellation, independent close/detach actions, connection confirmation, toolbar preferences, portal tooltips and overflow scrolling. Focused command: `npm run test:run --prefix frontend -- src/components/TerminalTabsBar.test.tsx`.
- Full desktop WebDriver execution requires tauri-driver and its platform driver. These component/protocol tests do not prove manual desktop layout or real-device/OpenSSH interoperability.

- terminal_transport_tests.rs uses actual loopback Axum/WebSocket and TCP Telnet connections to cover binary Unicode/marker output, JSON-looking terminal input, detach/reattach history, immediate EOF and explicit termination; another case cancels an unresponsive SSH handshake. A gated loopback SSH server verifies that input during authentication reaches the terminal; exec tests verify real stdout/stderr and exit codes without requiring a shell.
- Session-manager tests cover a failed history send with and without another attached client, byte-budgeted replay and unforgeable transport events. Telnet parser tests split negotiations at every boundary and feed them byte by byte; oversize subnegotiation and IAC escaping are covered.
- Frontend controller tests cover split UTF-8, binary input versus text controls, old-socket callbacks, replay replacement and quick-connect destination changes. Identity-file tests preserve corrupt/missing salts and report write failures.

Focused commands: cargo test --manifest-path backend-rs/Cargo.toml --test terminal_transport_tests; cargo test --manifest-path backend-rs/Cargo.toml --lib; npm run test:run --prefix frontend -- src/terminal. These loopback tests do not replace OpenSSH/SFTP device interoperability or manual Tauri detach/window checks.

Reliable-close regressions cover HTTP deletion after WebSocket loss, rejection without authentication, a live sibling on the same server, repeated DELETE and racing WebSocket termination, real SSH server disconnect with keepalive disabled, and cancellation before the new-session ID is acknowledged. Manager tests cancel the cleanup caller while its lock is blocked and verify cleanup continues. Frontend store/controller tests cover retained pending/failed tabs, retrying the same ID, stopping automatic/manual reconnect, ignored late initialization and session-preserving handoff. Detached-window tests wait for confirmed deletion before closing the window. Focused frontend command: `npm run test:run --prefix frontend -- src/state/store.test.ts src/terminal/TerminalSessionController.test.ts src/components/TerminalWorkspace.test.tsx src/components/DetachedTerminalWorkspace.test.tsx`.

## SFTP interoperability and UI regressions

Files UX regressions cover natural and size sorting with folders first, dotfile visibility, case-insensitive filename filtering, keyboard focus/open/rename, filtered selection clearing, validation that retains invalid dialog input, symbolic permissions prefill, retrying failed paths, cached-location Back navigation, remote actions alongside the local panel, explicit local uploads and the oversized-file explanation. Transfer drawer tests keep active jobs ahead of history and verify that clearing finished rows does not cancel jobs. Run `npm run test:run --prefix frontend -- src/components/SftpBrowser.test.tsx src/components/LocalFilePanel.test.tsx src/features/sftp`.

`frontend/src/features/sftp` tests cover confirmation, cancellation of the real job, stopping a queued batch and rejecting incomplete local saves. SftpBrowser component tests exercise confirmed rename and cancelled delete through the rendered UI. `scripts/sftp-smoke.py` tests a disposable loopback SSH/SFTP server and backend, including multi-MiB streaming, reuse, overwrite, CLOSE failure, mutation, Unicode names, cancel cleanup, consumer disconnect and stalled auth. Setup and exact commands are in [SFTP implementation](SFTP_IMPLEMENTATION.md). AsyncSSH is an optional test dependency, not shipped with Netrix.

Hosts regressions are covered by management_tests.rs (partial updates, nullable username, version conflicts/concurrent editors, dependencies, exact locked-vault flags, metadata repair, credential replacement revision, schema-5/6 backup restoration and rollback) and frontend Hosts actions/form/card tests (deduplicated loads, stale response reconciliation, serialized settings changes, field diffs, conflicts preserving input, vault context switching, canonical groups and pointer/keyboard activation). Run npm run check for the complete suite.

The Hosts regression suite also exercises stale edits after explicit host-ID restoration, malformed backup group types, retrying list errors, and preserving local-shell argument whitespace/empty arguments during rename.

Hosts UX regressions cover natural address/name sorting, stable ties, newest-first history with unused profiles last, local/serial search, canonical subtree and Ungrouped filters, preference validation/persistence, descending group order, search expansion without changing saved folder state, action-menu isolation from connection activation, explicit move/cancel/retry, and Quick Connect versus explicit Save host. Run `npm run test:run --prefix frontend -- src/features/hosts src/components/HostDashboard.test.tsx src/components/HostFormModal.test.tsx src/components/DraggableHostCard.test.tsx`.

For Hosts visual QA, check List/Compact/Grid in wide and narrow panes with long names, IPv6, local commands, serial ports, nested/empty groups and recent history. Verify visible focus, keyboard menus, Files access and drag cancellation/outside drops, plus real host moves using a disposable saved profile. A browser preview using mock profiles validates layout and UI transitions but does not establish real SSH/SFTP connectivity.

Connection-screen regressions cover indeterminate progress, elapsed-timer cleanup, real controller phase labels, complete/copyable errors, explicit new-session recovery, cancel failure/retry, vault unlock success/failure and obsolete responses, protocol-specific local/serial messaging, immediate connected handover, and preserved handoff suppression. Run `npm run test:run --prefix frontend -- src/components/ConnectionStatusPanel.test.tsx src/components/TerminalCanvas.test.tsx src/terminal/TerminalSessionController.test.ts src/components/TerminalWorkspace.test.tsx src/components/DetachedTerminalWorkspace.test.tsx`. Visual preview QA checks 1280, 720 and 380 px panes, a moving CSS bit-light trail while connecting, cooling after failure (trigger during a visible strike; verify falling bolt/glow opacity and digit scale, fully unlit within 900 ms), immediate restart on retry, a single phase label and destination line, and priority for the vault form in narrow panes. Reduced motion disables the bit animation. Actual SSH/device behavior still uses the terminal lifecycle manual matrix.


Hosts folder-browser regressions cover subtree navigation/breadcrumbs, empty folder creation and duplicate errors, context-menu rename retry, move-cycle exclusions, selected-folder host creation and confirmed subtree deletion. Folder action tests cover public DTO merging, descendant/collapse preference remapping, empty folder moves, collision/cycle/length validation and failure reconciliation. Backend `management_tests` cases prefixed `host_folder_move` exercise real SQLite atomic renames, canonical legacy paths, literal SQL wildcard names, unchanged unrelated profiles, stale membership/revisions, collisions, oversized descendants and token authentication. Run `npm run test:run --prefix frontend -- src/components/HostDashboard.test.tsx src/features/hosts` and `cargo test --manifest-path backend-rs/Cargo.toml --test management_tests host_folder_move`. Visual QA should check Grid/Compact/List, narrow windows, long names/IPv6, deep trees, folder dialogs and host drag/drop into the sidebar using disposable fixtures.

## Medium regressions and release validation

For a local unsigned installer, follow the [Windows build guide](build_instructions.md).

`npm run check` includes `npm run test:scripts` (Node built-in tests), backend check/clippy/tests and frontend tests/typecheck/build. `npm run test:tauri` runs the native shell tests, including UUID-scoped Credential Manager roundtrips; Windows CI and `release:check` require it. No real keychain entry is used by native tests.

- `TerminalCanvas.paste.test.tsx`: real xterm DSR/DA/OSC replies remain source-only; keyboard/Ctrl+C/arrow keys, approved bracketed paste and Quick Actions reach selected peers once. Button, Alt shortcut and launcher send identical decoded bytes, including literal backslashes, with no automatic newline.
- `QuickActionModal.test.tsx`: create/update/delete API failures keep drafts and committed actions, block duplicate requests/dismissal while pending, and close only after a successful retry.
- `terminal_transport_tests.rs`: delay actual SSH authentication, then stop/delete the tunnel or delete its host; verify failed pending start, remote disconnect, port release and an unaffected neighboring tunnel. Existing encrypted RSA/Ed25519 and host-key rejection tests cover the dependency update.
- `database_encryption::tests::missing_or_corrupt_key_never_creates_an_empty_replacement`: own and gracefully close every SQLite worker after an explicit WAL checkpoint before comparing unchanged DB/WAL bytes. Run with normal suite parallelism; no sleep-based workaround is needed.
- `startup::tests::password_gate_rotation_reset_and_restart_preserve_the_workspace`: take ownership of every pooled connection and await each SQLite worker's close before restarting or removing the disposable workspace. This avoids racing asynchronous connection returns against the pool's idle-queue drain on Windows; retain the immediate file-removal assertion.
- `scripts/tests/validation.test.mjs`: reject vulnerable or mismatched SQLCipher evidence, any active RSA/unknown advisory, production/substituted E2E binaries and unsafe cleanup paths; require native tests in CI/release.

Run `npm run audit:backend` for target-aware advisory triage plus an actual linked native-library probe. Its output includes the backend binary SHA-256 and SQLite source ID; the probe never opens SETTINGS or a user database. Source/adapter policy updates require review, not a blanket ignore.

`npm run test:e2e:desktop:build` builds a uniquely identified shell and separate backend, records both hashes, then runs WebDriver. `npm run test:e2e:desktop` reuses that verified build but creates fresh profiles. It rejects arbitrary `NETRIX_E2E_BINARY` overrides before launching, never migrates the production legacy directory, checks production/legacy identity hashes, waits for process closure and removes only its UUID-scoped profiles. Requires tauri-driver and the WebView2-matching Edge WebDriver on PATH. Optional `NETRIX_E2E_BUILD_ROOT`, `NETRIX_E2E_BACKEND_TARGET` and `NETRIX_E2E_SHELL_TARGET` select **dedicated** build/cache directories; never point them at a running normal application's target.

`node scripts/terminal-appearance-smoke.mjs` checks the locked gate and explicitly submits its random `master_password` to `/security/unlock` on the fresh launch and both restarts. It waits for child `close` before restart/cleanup. `NETRIX_SMOKE_BACKEND` can select a backend from a separate validation target.

## Low regressions and supported toolchain

- `TerminalHints.test.tsx` keeps normal form fields excluded even if they imitate an xterm CSS class. `TerminalCanvas.paste.test.tsx` focuses the real xterm textarea, toggles hints and checks selection, Escape, a second toggle and an unmatched key: all are consumed locally with no bytes to the source or broadcast peers; normal input resumes afterward.
- `atomic_file` tests normalize drive/relative/UNC/already extended/Unicode Windows paths without accessing any network share, reject invalid paths and preserve old/new bytes when replacement fails. Windows `known_hosts` tests persist, reload, reject a changed key and forget trust on short and >260-character paths; a destination handle denying deletion exercises preservation on failure.
- `database_encryption::tests::windows_long_path_recovers_at_both_sides_of_atomic_replacement` repeats interrupted conversion and restart on a >260-character Unicode profile path, verifying the full database fingerprint. All fixtures are disposable; no user database or trust file is read.
- `scripts/tests/validation.test.mjs` guards the Node 24.x policy and the exact-minimum CI matrix. Clean installs use `--engine-strict`, so incompatible locked dependency engines fail CI. Local minimum-version validation uses Node 24.0.0 for both `npm ci --engine-strict` and `npm ci --engine-strict --prefix frontend`, then `npm run release:check` on Windows. Use the latest 24.x patch for normal development.

`npm run release:check` requires both Rustfmt checks, the complete backend/frontend/script suite, Tauri check/tests, the production NSIS build, installer hashes and all dependency audits. The gate builds and stages the debug sidecar before the Tauri checks. The production build then stages the release sidecar for NSIS. When preserving an active developer build, copy the complete current source (including uncommitted files) to a separate workspace and run the gate there with its own build outputs. The gate builds an installer; it does not install or publish it.

`npm run check:windows:binaries` verifies packaged DLL imports and runs read-only
storage/WebView2 probes. WebView2 is checked both against the installed runtime
and an empty-folder override scoped only to the probe child. The latter must
exit 10; it does not alter installed runtimes or establish installer recovery QA.
