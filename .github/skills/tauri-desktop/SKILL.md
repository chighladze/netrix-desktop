---
name: tauri-desktop
description: 'Use when: changing Netrix src-tauri Tauri shell, sidecar startup, plugin permissions, CSP, packaging, commands, or desktop lifecycle.'
---

# Tauri Desktop

For detached terminal dragging, `startDragging()` acknowledges startup, not release.
Keep the scoped `wait_terminal_drag_release` Windows observer and the pointerup
fallback; never finish docking immediately after the native startup acknowledgement.
The gesture belongs to `useTerminalWindowDrag`, with a slop threshold, Escape and
stale-response cleanup. Keep floating native/webview transparency together so the
compact live surface reveals the dock target without resizing the PTY. Smoke
builds use their own target directory, never the normal app binary.

## Purpose

Guide changes to `src-tauri/`, which owns desktop lifecycle, sidecar launch, Tauri commands, permissions, and packaging.

## Rules

- Keep the backend token out of command-line arguments. It must be sent through stdin and exposed to frontend through IPC.
- Keep backend binding local by preserving the sidecar model.
- Treat `capabilities/default.json` and `tauri.conf.json` as security-sensitive.
- Keep sidecar naming aligned with `scripts/prepare-sidecar.mjs` and `externalBin`.
- Release sidecars use `scripts/build-sidecar.mjs`, an explicit target and static CRT on Windows MSVC. Keep `--check-webview2` before all app initialization; it must never touch app data, start a backend or invoke single-instance handling. Keep the NSIS recovery probe and its post-install verification when changing packaging.

## Architecture Guidance

- Development launches `backend-rs/target/debug/netrix_backend.exe` on Windows.
- Production launches the bundled sidecar through `tauri-plugin-shell`.
- Tauri commands expose backend port/token/status, quit and fixed-purpose remembered Vault password operations. The latter are granted only to `main`, use the fixed Windows credential target and run on the blocking pool. Keep detached/preview capabilities free of credential-store access.
- Windows Job Object support groups/kills backend processes with the app.

## Coding Standards

- Log production shell errors to `%APPDATA%/Netrix/tauri_main.log` when stderr is invisible.
- Avoid adding new plugin permissions unless the feature requires them.
- Document any CSP relaxation or permission expansion in `docs/SECURITY_RULES.md`.
- Register app commands in both `generate_handler!` and `build.rs` command metadata. Native credential tests must use UUID-scoped disposable entries, never the production Vault-password entry.

## Anti-Patterns

- Passing secrets as process arguments.
- Allowing arbitrary shell execution.
- Binding the backend to non-local interfaces.
- Changing dev port assumptions without updating Vite and Tauri config together.

## Example

If adding a new Tauri command, define it in `src-tauri/src/main.rs`, add it to `generate_handler!`, call it through `invoke` in frontend, and document the new desktop permission or data flow if security-relevant.
