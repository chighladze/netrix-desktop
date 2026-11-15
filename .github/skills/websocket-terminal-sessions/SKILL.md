---
name: websocket-terminal-sessions
description: 'Use when: changing Netrix terminal WebSockets, xterm TerminalCanvas, SSH/Telnet/Serial sessions, detach, reattach, resize, heartbeat, or session cleanup.'
---

# WebSocket Terminal Sessions

## Purpose

Guide terminal session changes across frontend `TerminalCanvas.tsx`, backend `routers/sessions.rs`, and `ssh/manager.rs`.

## Rules

- WebSockets must authenticate through `netrix-token.<token>` subprotocol.
- Keep terminal control messages with the `__JSON__` prefix.
- Preserve detach/reattach semantics and session history replay.
- Do not let SFTP operations reuse or close interactive terminal sessions.
- Avoid logging terminal input or credentials.

## Architecture Guidance

- Saved hosts use `/ws/terminal/{host_id}`.
- Quick connect creates a one-time authenticated ticket before opening `/ws/quick-connect`; credential query parameters are rejected.
- `SessionManager` owns connection state and per-session broadcast history.
- Frontend tab state tracks `sessionId`, socket, xterm instance, and status.

## Coding Standards

- Clamp terminal size, timeout, and keepalive values as the backend already does.
- Close old sockets before reconnecting.
- Dispose xterm instances on tab removal.
- Keep user-facing connection errors actionable.

## Anti-Patterns

- Creating duplicate sockets for one tab.
- Matching detached sessions by host only when session ID is available.
- Treating normal terminal output as JSON unless it uses the expected control prefix.
- Expanding quick-connect URL credential behavior.

## Example

When changing reattach behavior, inspect `TerminalCanvas.tsx`, `App.tsx` reattach events, `routers/sessions.rs`, and `SessionManager::find_detached`. Then manually test connect, detach, return, close, and reconnect.

## Wire and lifecycle invariants

- Split layouts mount up to four visible renderers; preserve pane keys when focus changes and route global shortcuts/hints to the active pane. Hidden controllers keep their existing transport.
- After the first Terminal visit, module navigation must hide its workspace without disposing xterm or replaying history. Keep it outside other modules' Suspense boundaries: suspending a shared boundary tears down xterm's layout effects. Preserve dormant restored tabs before the first visit, and gate terminal/hint shortcuts by the active view. Validate with `App.navigation.test.tsx` and `TerminalHints.test.tsx` alongside the terminal suite.
- WebSocket callbacks hold a workspace read lease from host loading through session registration, then release it before the bridge. This excludes backup replacement without blocking restore for the lifetime of a session.

- Binary WebSocket frames carry terminal input/output; JSON text carries controls. Use terminal/wire.ts for all frontend terminal sends. Keep the backend __JSON__ control prefix.
- replay_start replaces the old renderer buffer before binary history. Do not append duplicate history on reconnect.
- Keep internal session events typed; never inspect terminal bytes for transport-ended sentinels.
- Every bridge exit releases its attachment, including failed replay; reconnect callbacks check generation before modifying timers.
- Run the isolated terminal_transport_tests loopback suite for protocol/lifecycle changes. Quick-connect credentials now use authenticated one-time tickets, not URL query fields.
- Window handoff uses prepare/ready/commit and `/ws/sessions/{sid}?after=...`; do not replace it with sleeps, early source detach, or a saved-host reconnect. Keep xterm write barriers, UTF-8/VT checkpoint tails and input/resize guards. Snapshots are in-memory only. See `docs/TERMINAL_WINDOW_HANDOFF.md` for bounds and the dedicated-identifier Windows smoke; APPDATA overrides alone do not isolate Tauri Known Folder paths.
