# Terminal Lifecycle Test Plan

Use this runbook before a production release when `TerminalCanvas`, `/ws/*`,
`SessionManager`, detached windows, or quick-connect behavior changes.

## Test Setup

- Build and run the desktop app with `npm run tauri dev` or test the latest
  release installer.
- Prepare one reachable SSH host with valid credentials.
- Prepare the same host with an intentionally wrong password or passphrase.
- Prepare one unreachable target, for example a private IP with no route or a
  closed SSH port.
- Keep Task Manager or equivalent open so backend and app processes can be
  checked after each destructive flow.

## Automated Coverage

Backend unit tests cover these lifecycle invariants:

- Reusing an existing `sid` returns the same session handle.
- Two different session IDs can exist at the same time.
- Detached lookup matches only exact host, port, and username.
- Detach does not mark a session detached while another WebSocket client is
  still attached.
- WebSocket client release saturates at zero.
- Live sessions are preserved only when a transport exists.
- SSH reattach resumes an existing detached transport before attempting a new
  network connection.
- Cleanup removes the session and reports whether it terminated anything.
- Terminal history is replayed to new subscribers for reattach.
- Backend session-ended payloads round-trip their disconnect reason.
- User-facing connection errors map authentication, refused, timeout, and route
  failures to stable messages.

Run:

```powershell
npm run test:backend
```

## Manual Matrix

The actual-window loopback smoke and safe profile setup are documented in [Terminal window handoff](TERMINAL_WINDOW_HANDOFF.md). Also test cancelling a move, target creation failure, rapid output during transfer, normal/alternate screen restoration, native Alt+F4 with all sessions detached, and dragging at 100/125/150% DPI across monitors. The original terminal must stay usable after any failed move.

Check the complete gesture: a title click and double-click must not dock; the
source tab must keep its width while tearing out; returning into the strip must
show the exact insertion caret. Pause, leave and re-enter the target, then test
release and Escape. Transparent space outside the compact preview must reveal
the workspace. Repeat near taskbars, screen edges and negative-coordinate monitors.
Cancel a long transfer and verify the source expands without an error toast.

| Scenario | Steps | Expected result |
| --- | --- | --- |
| SSH connect success | Open a saved SSH host with valid credentials. | Tab reaches connected state, prompt is usable, no duplicate tab appears. |
| SSH wrong password | Open the same host with bad credentials. | UI shows authentication failure, session does not stay stuck in connecting. |
| Unsupported jump route | Open an isolated saved profile with `jump_host_id`. | UI reports unsupported jump traversal before direct contact. Existing profile edits preserve the route and display a warning. |
| Vault lock and reattach | Connect SSH, detach, lock Vault and return by session ID; then end the session and reconnect. | The live transport resumes; a new connection is blocked until unlock. |
| SSH unreachable host | Open unreachable host or blocked port. | UI shows timeout/refused/route error, session can be closed cleanly. |
| Open two tabs | Open two tabs to the same saved host. | Both tabs are independent and closing one does not break the other. |
| Detach active tab | Drag an active tab out into a detached window. | Main tab is removed, detached window remains connected, backend process count is stable. |
| Return detached tab | Use Return from detached window title bar/close dialog. | Main window receives one tab, terminal state/history remains visible, no duplicate SSH login occurs. |
| Close detached window -> Return | Click detached window close, choose Return. | Same result as Return; detached window closes after main tab is restored. |
| Close detached window -> Disconnect | Click detached window close, choose Disconnect. | Detached window closes, backend session terminates, no stale tab/session remains. |
| Main window close while detached exists | With a detached active terminal open, close the main window. | Confirmation appears; accepting closes detached window(s) and backend exits cleanly. |
| Backend killed while terminal active | Kill the backend sidecar while a terminal is active. | Terminal reports disconnect/error and can be closed without freezing the app. |
| Reattach duplicate guard | Detach and return the same active tab repeatedly. | Each return creates/reuses only one tab and the remote host sees no extra SSH login. |
| Quick Connect detach gate | Start Quick Connect and detach before it is established, then after it is connected. | Before `sid`, detach is blocked with a toast; after `sid`, detach works and preserves the session. |

## Release Definition Of Done

- Run the manual matrix 20-30 times across a mix of saved SSH and Quick Connect.
- No stuck connecting/disconnecting state.
- No duplicate restored tabs.
- No duplicate SSH connection during detach/return.
- No broken or orphaned backend process after close/disconnect flows.
- No lost visible terminal state after detach/return.
- `npm run check` passes after the test build.
- `npm run check:tauri` passes after the test build.
