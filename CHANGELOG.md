# Changelog

All notable changes to Netrix will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0-beta.9] — 2026-11-18

### Added
- Preview and copy a problem report from Help or the startup failure screen before opening the public bug form.

### Fixed
- Stop terminal sessions, tunnels, transfers and the database during bounded sidecar shutdown.
- Wait for the workspace lock during an immediate restart after a crash, including when Windows denies Job Object assignment.
- Distinguish a blocked, timed-out or failed WebView2 probe from a missing runtime in Windows Setup.

### Changed
- Check the architecture and source of the Windows x64 payload. When a signing certificate is configured, sign the shell, backend, uninstaller and Setup before recording the installer checksum.

## [0.3.0-beta.8] — 2026-11-15

### Fixed
- Explain startup failures with safe diagnostic codes, recovery steps and the local log location.
- Keep protected workspace content hidden if a late unlock response arrives after backend failure.
- Build Windows release sidecars with static MSVC CRT, reject unexpected Visual C++ DLL dependencies in release checks, and verify WebView2 loader availability with an offline recovery attempt before installing app files. Clean-machine candidate QA is still required.
- Bundle the complete Evergreen WebView2 installer on Windows to remove the runtime download dependency on target computers. The new package still requires missing-runtime installation QA before publication.

## [0.3.0] — 2026-11-09

### Added
- SQLCipher encryption for the entire local database, including hosts, snippets and network maps, with a master password required at startup.
- Verified migration of existing databases, encrypted recovery copies and recovery from interrupted migration or password changes.
- Application locking shared across main and detached windows, with configurable inactivity timeouts.
- Terminal history navigation with section previews, visible line ranges and a return-to-latest control showing new output.
- Per-host terminal appearance controls for colors, typography, cursor and selection.

### Changed
- Redesigned Hosts organization and Net Map navigation, toolbars and inspectors.
- Refined terminal connection status, session controls and history preview layout.
- Improved SFTP file lists, multi-file selection and local download permission dialogs.
- Sidebar and About now display the version from the frontend package manifest.
- Updated SSH and desktop dependencies and expanded security and regression coverage.

### Fixed
- Downloads of growing log files now save their original byte range and report subsequent growth.
- Terminal history previews stay within their panels, and session controls avoid covering terminal output.
- Password changes and credential resets preserve access to the encrypted workspace.

### Upgrade notes
- Existing installations use their current vault master password to encrypt the database on first unlock.
- Keep the encrypted recovery copy and its matching password. Older Netrix versions cannot open the converted database.

## [0.2.2] — 2026-07-13

### Added
- GitHub Actions CI for backend checks/tests and frontend typecheck/build.
- Frontend `typecheck` script and root validation scripts.
- First-run Help Center with direct workspace navigation and persistent in-app access.
- Inline Credential Vault creation with password confirmation and validation guidance.
- Focused Vault unlock dialog and component coverage for setup and failure states.

### Changed
- WebSocket authentication now requires token-bearing subprotocol headers instead of accepting token query parameters.
- Terminal connection timeout and keepalive settings are passed through to the backend session manager.
- Password generation utilities now use Web Crypto instead of `Math.random`.
- SSH/log command builders now quote POSIX shell arguments more defensively.
- README and security documentation now distinguish implemented features from roadmap items.
- Vault status and unlock actions now use consistent, responsive UI across application views.
- Terminal and full-height workspace layouts now reserve space correctly for persistent notices.
- Snippet empty states now explain the next useful action.

### Fixed
- TCP scanner rejects zero or excessive concurrency instead of hanging on zero-permit scans.
- Snippet execution now resolves vault-backed host credentials before connecting.
- Closing the main window now terminates the full application and sidecar lifecycle.
- The locked-Vault notice no longer pushes Terminal tabs or action bars outside the window.
- Singular locked-Vault copy now uses correct grammar for one saved host.

## [0.2.1] — 2026-02-11

### Added
- Hover tooltips on terminal tabs showing host connection details
- Consistent tab widths across all terminal sessions
- Connection overlay with binary animation during SSH handshake
- Consolidated disconnect notification toast
- Terminal tab metadata and connection-state affordances
- Quick action categories and descriptions
- Terminal highlight rules (keyword-based background/foreground coloring)
- Recent connections history panel
- Host group management with drag-and-drop reorganization
- Detachable terminal tabs (open in separate windows)

### Changed
- Standardized host card action buttons across all view modes
- Improved terminal search bar positioning (inside terminal area)
- Refined About page messaging

### Fixed
- Duplicate SSH sessions on detach/reattach
- Multiple terminal connections to same host now create independent sessions
- Connection refused errors on backend startup
- Dashboard layout stretching issue

## [0.2.0] — 2026-02-01

### Added
- Multi-protocol support (SSH, Telnet, Serial)
- Terminal theming with multiple built-in themes
- Command snippets with template variables
- Quick action bar for frequently used commands
- Settings page with terminal, connection, keyboard, and window options
- Encrypted credential vault with Argon2id key derivation
- Audit log schema and read endpoint groundwork
- Drag-and-drop tab reordering

### Changed
- Migrated from Electron to Tauri for smaller binary size
- Switched to Zustand for state management

## [0.1.0] — 2026-01-15

### Added
- Initial release
- SSH terminal emulation with xterm.js
- Host management (add, edit, delete)
- Tabbed terminal interface
- Dark mode UI
- Basic settings

