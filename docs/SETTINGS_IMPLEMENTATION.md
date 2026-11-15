# Settings implementation and scope

This review compares the local Termos source at a separately reviewed reference implementation with actual Netrix consumers. Termos `SettingsView.tsx` keeps terminal controls in component state; `TerminalView.tsx` still constructs its terminal with fixed font/theme values. Configuration import/export is wired, but visible controls alone do not demonstrate persistence or runtime support.

## Netrix ownership

| Configuration | Storage and consumer | Application scope |
| --- | --- | --- |
| Theme and font size | Validated `appSettings` in localStorage; Zustand compatibility mirrors; `TerminalCanvas` | Global defaults. A saved host's own theme/font override remains authoritative. |
| Font family, cursor, scrollback, keypress scrolling | Same preferences; `features/settings/terminalOptions.ts` applies xterm options | Existing renderers update without replacing the transport. Hidden renderers apply current options when mounted. Reducing scrollback intentionally discards history above the new limit. |
| Bell, search and clipboard interaction | Terminal event handlers and search addon read current preferences | No reconnect required. Zero bell volume is silent. `bellVolume` and `copyOnSelect` are consumed internal preferences; the current Settings page has no separate controls for them. |
| Default SSH/Telnet ports | Host form uses defaults for new profiles/protocol changes | Existing saved host ports are preserved. |
| Terminal type, connection timeout, keepalive | `TerminalSessionController` sends parameters on connection preparation | Applies to the next terminal connection. Updating preferences does not renegotiate an existing SSH transport. SFTP, exec and tunnels use separate backend bounds. |
| Autoreconnect and maximum attempts | Existing controllers, including those without a renderer, receive updates from Zustand | Disabling autoreconnect cancels scheduled retries; changes do not open a connection by themselves. |
| Window/tab behavior | React tab layout and Tauri window APIs in `App` | Native window effects still require desktop QA. |
| App/Vault inactivity and clipboard clearing | Backend shared clock, `AppSecurityBoundary` in every window, existing clipboard helpers | Trusted activity in any window counts. App lock hides all windows and blocks input/new API work; vault-only lock keeps existing terminals usable. Both retain transports. |
| Encrypted workspace startup | `AppSecurityBoundary`, `startup.rs`, SQLCipher storage | Explicit master-password entry is required before opening the database on every start. The old vault startup selector is hidden for encrypted storage and does not override this gate. |
| Remembered vault password | Fixed-purpose native commands and Windows Credential Manager | An optional convenience for vault unlock inside an already-open workspace. It cannot open the database or bypass application lock. Existing preference values are retained. |
| Keyword highlighting | Authenticated highlighting API and SQLite | Separate workspace data. Appearance/category resets preserve rules; encrypted backups include them through the backend. |

## Persistence boundary

`features/settings/settings.ts` owns fresh defaults and a whitelist of accepted fields, types, enums and numeric bounds. Loading, store mutations and imported preferences pass this boundary. Unknown fields, objects in primitive fields, inherited keys and invalid sizes are ignored. Credentials and backend-owned highlighting are excluded from the preferences snapshot.

`appSettings` is authoritative. Legacy `terminalTheme` and `terminalFontSize` keys are fallback migration inputs only when the canonical field is absent. Updating through compatibility actions and resetting defaults write the canonical snapshot, so legacy values cannot reverse a reset on restart.

New or missing security preferences use 15-minute app lock, 30-minute vault lock, 30-second clipboard cleanup, manual vault startup and remembering disabled. Explicit existing preferences are preserved. App auto-lock requires a configured master password. Settings includes an explicit Lock Netrix action; password verification is required to unlock every window regardless of the remembered-startup preference.

Store actions persist before applying settings and return success/failure. If writing fails, current settings and appearance mirrors remain unchanged and an error is displayed. Numeric port edits keep incomplete input local and commit bounded integers on blur/Enter. Manual slider edits respect their steps. Backup restore reports explicitly if backend workspace replacement completed but local preferences could not then be saved; the frontend preference/layout phase is not one atomic transaction with SQLite restore.

## Remembered credentials

The previous `tauri-plugin-keychain 2.0.2` desktop implementation had no registered invoke handlers. It has been replaced by `keyring` with its Windows-native backend. Tauri exposes only `read_vault_password`, `save_vault_password` and `remove_vault_password`, targeting the fixed `com.netrix.app.vault` / `master` entry. Only the `main` capability grants those commands. Detached terminal/map windows and previews receive no credential-store permission. No caller can select arbitrary entries.

Native operations run on the blocking pool and serialize access. The save command wraps the incoming password in `Zeroizing`; reading returns a transient IPC value for unlock, never a persistent frontend field or a backend public DTO. Missing entries are normal; other failures propagate as fixed messages without native error contents. The frontend distinguishes successful Vault operations from failed remembering/removal and does not claim storage success after failure. Disabling remembering during an in-flight save performs a final removal after that save completes.

Remembering happens after the next successful unlock/password change; enabling the preference alone cannot recover a password from the unlocked Vault. This implementation currently supports Windows only. Other platforms return an explicit unsupported error rather than using an in-memory mock or plaintext fallback. No SQLite migration or portable-backup schema change is involved; export remains schema 6, restore supports schemas 5/6.

## Verification and remaining work

Frontend tests cover malformed/legacy preferences, reset/restart consistency, failed persistence, numeric edits, database-owned highlighting, existing xterm output, hidden controllers, retry cancellation, Vault startup policy, native command responses, remembering failure and late-save removal. Tauri tests exercise save/read/replace/delete of a UUID-scoped Windows credential with cleanup, plus capability isolation. These tests never use the production credential entry.

Run `npm run test:run --prefix frontend`, `npm run typecheck --prefix frontend` and `npm run build --prefix frontend`. For native validation use an isolated `CARGO_TARGET_DIR`, then `cargo test --manifest-path src-tauri/Cargo.toml --bin netrix`, `cargo check --manifest-path src-tauri/Cargo.toml`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, and `npm run audit:tauri`.

Manual Tauri restart, saved-password buttons, multi-window propagation, actual audio/clipboard and window positioning remain unverified by these tests. The existing OS inactivity timers observe main-window activity; activity in detached windows is not aggregated. The Scroll on Output toggle currently gates explicit scrolling only; xterm's own output-follow behavior still needs a complete viewport policy and regression tests. Native credential support for macOS/Linux, configurable SFTP timeouts and additional SSH transport options need separate implementations; no placeholder controls were added.
