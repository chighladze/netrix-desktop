# Terminal window handoff

Terminal transports remain owned by the Rust sidecar. A window move transfers
the renderer and attaches a new WebSocket to the same live session; it never
opens a replacement SSH/Telnet/Serial/local connection.

## Transaction

`terminal/windowHandoff.ts` coordinates a bounded, in-memory Tauri event exchange:

1. The source blocks input, snapshots its xterm write queue and records an exact
   backend byte checkpoint. Its socket keeps receiving output throughout.
2. The destination requests an offer containing a secret-free host descriptor,
   session status and serialized screen. Window URLs contain only routing IDs.
3. The destination restores the screen at the original dimensions, then uses
   `/ws/sessions/{sid}?after={offset}` to catch up. It does not send input or
   resize the shared PTY during preparation.
4. After `replay_end` and the xterm write barrier, it acknowledges readiness.
   The source requests commit; the destination shows/focuses its window, enables
   input and acknowledges commit. Only then does the source remove its tab or
   close its own detached window while preserving the backend transport.

Preparing a screen has a five-second deadline. The window transaction has a
20-second deadline. Cancellation, creation failure, expired output checkpoints
and replay errors leave the original session connected and release only the
speculative destination attachment. A missing live session fails explicitly;
handoff cannot silently create a new login. Events carry a random transaction ID
and both window labels; duplicate offers/requests cannot create duplicate tabs.
The receiver waits until after React StrictMode's mount replay before starting
an external transaction.

Each receiver serializes incoming handoffs and waits for outgoing screen capture
or reuse of the same session before preparing the next one. Independent moves
in opposite directions may proceed after capture, avoiding a commit deadlock.
Queued addresses are registered for
cancellation immediately; a cancelled queued return never creates a tab. One
incoming transfer owns the active view until completion, so shortcuts or another
return cannot unmount its renderer during replay. Existing destination windows
are shown and unminimized before preparation; newly created floating windows stay
hidden until commit. Plain Return ignores pending connection-picker reservations
and returns as an independent tab unless an explicit pane placement was supplied.

Split groups use the same transaction with an optional workspace offer containing
up to four sanitized hosts, session snapshots and serialized screens, plus pane
order, layout and focused member. Every member is input-guarded and rendered for
capture/replay, including temporarily hidden panes. The receiver remaps tab IDs,
waits for every member's replay barrier, then commits the group together. Failure
releases every speculative attachment and restores the previous group/view/order;
the source keeps all original sessions. All newly detached terminals use
`workspace=true` alongside routing IDs in their URL, the existing detached-terminal
capabilities and the existing native drag/Return controls. Single tabs and extracted
panes use the same workspace with Single, Side by side, Stacked and 2 × 2 controls,
the local connection picker and Quick Actions. Their offers remain single-session
offers; a group is created only when the user chooses a split. Closing offers
Return / Disconnect all / Cancel; Disconnect all waits for authenticated session
deletions before closing. Detached workspaces do not overwrite the main saved tab
list. Individual pane extraction opens a workspace through the fixed-purpose
opener; generic webview creation remains main-only.

Single dissolves the selected group into independent tabs, even if it contained
only one session. Group metadata and its picker reservation are removed; live
controllers, session IDs and focus remain. The pane maximize button preserves
membership through its separate store action. A floating workspace exposes its
own tabs after Single. Those tabs can be selected, reordered, detached or closed;
creating a split again includes only the selected tab. Its fixed-purpose opener
accepts `workspace: true` to open a group tab at the same validated local route.
Plain incoming drops into that workspace's tab strip allocate a fresh local tab.
Returning the window serializes its independent entries through the existing
bounded handoff, with the selected entry last to preserve focus. Successfully
returned entries remain in the destination if a later entry fails/cancels; all
unreturned sessions remain in the source. Empty source windows close normally.
Capturing a newly selected tab waits for its cached screen restoration to finish
and verifies the same renderer is still attached. Already active renderers keep
the original synchronous checkpoint timing before the capture write barrier.

Vacant cells have stable group/index addresses. Main tab drags and floating-window
drags can insert one existing session directly into an exact vacant cell in either
the main or a detached workspace. Local insertion retains the same controller;
cross-window insertion uses the existing capture/replay/commit exchange. A filled,
removed or busy cell refuses the move; a failed incoming move never closes the
existing destination workspace. Group offers with multiple sessions cannot be
inserted into one cell. Pane positions, including holes, survive group return.

Dock discovery first resolves one native destination. On Windows this respects
window z-order and foreign-window occlusion, excluding the moving source and
metadata drag cards as appropriate. Only that destination responds to the probe,
so an overlapping background window cannot win a reply race. Detached workspaces
advertise vacant cells; main also advertises its tab strip. Choose a connection
opens an in-window saved/open-session picker in detached groups and reserves the
chosen index through the normal Hosts flow in main.

Each populated split pane has a numbered drag grip and an individual detach
button. Dragging one member to main's tab strip creates an independent tab;
dragging to a vacant cell moves only that member; dropping outside terminal
windows opens a standalone window. Local moves retain the same controller.
Cross-window moves use a single-session offer and remove the source member only
after commit, leaving its original cell empty. Its neighbors keep their slots
and transports. Escape, tiny movements and occupied destinations leave the group
intact. The native opener derives its source identity, validates routing UUIDs,
and never accepts arbitrary URLs or credentials. The last member leaving a
detached group triggers that empty source window's existing close flow.

Snapshots include normal/alternate buffers, styles, cursor/modes, scrollback,
viewport and selection. Unfinished UTF-8 and VT sequences are carried alongside
the screen so a chunk boundary cannot corrupt the continuation. Snapshots are
limited to 8 MiB, with a 64 KiB unfinished control-sequence limit. The backend's
2 MiB/2048-chunk ring must still contain output produced since the checkpoint;
otherwise the move is refused and the source remains available. Inline image
addon content is not included by xterm's serializer.

## Interface and closing

The transfer card, destination shelf and renderer entrance use the existing
dark/cyan palette, short transitions and a reduced-motion override. Input paths,
including quick actions and broadcast, respect the socket's transfer guard.
Tabs remain present while preparing, can be cancelled and cannot be closed by
an unrelated tab action during a move.

Each receiving workspace computes its actual vacant-pane rectangles. The main
window also computes the tab-bar rectangle (or a shelf inside its content area
when another view is open). It converts its own client coordinates to physical
pixels. The source probes with the physical cursor point;
sidebar width, tab position, negative monitor coordinates and DPI do not rely on
guessed constants. Minimized main windows are not docking targets. The Return
button remains available independently of drag docking.

`useTerminalWindowDrag` owns one complete gesture, with idle, dragging, armed and
returning phases. A six-pixel threshold preserves ordinary title clicks and
double-click maximize. Escape, teardown and native failure dispose that gesture's
listeners and timers; late probes cannot arm a newer gesture. User cancellation is
a typed, quiet outcome rather than a red error toast.
Once commit begins, both sides disable cancellation; queued Cancel clicks cannot
roll back a destination that is becoming active.

On hover, `DetachedTerminalFrame` scales the live terminal to a compact card (at
most 420 × 280 logical pixels) with a cyan outline, destination arrow and release
label. Floating windows have transparent native and webview backgrounds, so the
workspace remains visible outside the card. It uses only a CSS transform:
xterm stays mounted at the same dimensions, so previewing never reflows an editor
or resizes the remote PTY. Leaving the shelf restores the full surface; a successful
drop keeps it compact until the handoff finishes. The Return button and close
dialog use the same compact appearance. A short polling heartbeat keeps
the shelf visible while the pointer is stationary. Late geometry responses cannot
bring the shelf back after drag end. Reduced motion disables the preview transitions.

Windows `startDragging` acknowledges an asynchronous move-loop request; it does
not report release. `pointerDrag.ts` combines pointer capture with a cancellable,
caller-scoped native observer for trusted mouse gestures in main and detached
terminals. `wait_terminal_drag_release(gestureId)` reads fixed left button/Escape
states until release, cancellation or a 120-second deadline, then returns
`{ released, point: { x, y } }` in physical pixels. `cancel_terminal_drag(gestureId)`
stops only that window's matching observer. Replaced and cancelled gestures
cannot complete a later drag, even when cancellation arrives before observation.
Touch, synthetic gestures and unsupported platforms retain their DOM event path.
Capture loss/blur during an active native mouse gesture waits for this fallback;
Escape still cancels immediately. Native observation never generates OS input.

Floating title gestures start native release observation before calling
`startDragging` and hand pointer capture to the OS after the movement threshold.
Both native release and matching DOM pointerup can finish the same gesture once,
even if the move acknowledgement is still pending. For a trusted mouse, DOM
release waits up to 48ms for the fixed-key observer to report an Escape consumed
by the OS, then completes independently of a delayed observer. Late acknowledgements
and duplicate releases cannot start another return. Release coordinates stay
frozen; one-session and multi-session returns use the same completion path.

The Windows release worker uses `GetPhysicalCursorPos`, whose coordinates do not
depend on the worker thread's DPI context. Native release coordinates take
priority over a DOM cursor sample, including when they arrive during final drop
validation. A previously armed destination gets at most two fresh retries,
50ms apart, to allow native move-loop geometry to settle. Every attempt uses
captured coordinates and repeats native hit-testing and destination validation;
cached hover placement is never sufficient to commit a return. Escape/unmount
abort retry waits. See Microsoft's [physical cursor API](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getphysicalcursorpos).

Tabs and panes keep a bounded hover heartbeat while stationary. Pane preview
updates are coalesced per animation frame; the native tab preview follows at
roughly 30fps with one move request in flight. Release freezes the cursor point,
and final drop resolution blocks a second tab drag. Escape remains available
while destination geometry is pending. Abort signals remove outstanding probe
listeners immediately. Overlapping hover/final requests each receive a reply;
only the latest probe updates the destination's visual hint. End messages are
scoped to source/gesture, so ending an old gesture cannot erase a newer hint.
A refused occupied-window drop does not create an unintended floating window.
New floating windows also use the frozen release point for placement after
screen preparation. If its monitor disappeared, the native opener falls back
to the current cursor's monitor and keeps the window inside its work area.

The destination shows an insertion caret between actual visible tab midpoints,
with a quiet lane and a labeled release card. Its neighbor ID travels in the
in-memory offer; a removed neighbor falls back to appending. Reordering existing
tabs still works horizontally. Tear-out uses the real strip bounds with hysteresis,
keeps the source slot until commit and is disabled for keyboard sorting. The
non-focusable native drag card contains only public name/protocol/status metadata;
there are no simulated command rows or localStorage preview snapshots. Late-created
cancelled cards close immediately. Placement uses the cursor monitor's scale and
work area, including negative coordinates, fractional DPI and taskbar space.

Transfer feedback appears after 150 ms to avoid flashing on fast moves. Source
input remains guarded immediately; cancelling removes the speculative destination
and restores the source. Floating feedback leaves the surrounding workspace visible.
Cancellation/failure restores keyboard focus when the original terminal is still
active; switching to another tab during a move does not lose that tab's focus.

Custom and native main-window close requests use `terminal/appClose.ts`, including
detached sessions even when the main window has no tabs. Detached native close
requests open the same Return / Disconnect / Cancel dialog, with focus trapping
and Escape cancellation. Disconnect awaits authenticated session deletion.
`close_terminal_window` destroys only the calling detached window; generic
`core:window:allow-destroy` is deliberately not granted.

## Validation

Focused frontend coverage: controller checkpoint timing, UTF-8/VT splits, actual
xterm serialization including alternate screens, transaction rollback/timeout,
StrictMode startup, close policy and DPI geometry. Backend unit and loopback
tests cover cursor slicing/eviction, auth, active multi-client resume and source
input after cancelling a destination.

For actual Windows webviews, run Vite on 127.0.0.1:3017 and use the dedicated smoke
identifier. **Overriding APPDATA alone does not isolate Windows Known Folder
paths used by Tauri.** The runner refuses an ordinary binary and any unexpected
profile content. It uses only synthetic loopback Telnet data, cleans up its host
and closes the app. Remote debugging is enabled only in that spawned test process.

```powershell
cargo build --manifest-path backend-rs/Cargo.toml
$env:TAURI_CONFIG = Get-Content scripts/terminal-smoke.tauri.json -Raw
cargo build --manifest-path src-tauri/Cargo.toml --target-dir backend-rs/target/terminal-window-shell
Remove-Item Env:TAURI_CONFIG
node scripts/terminal-window-smoke.mjs
```

Start a fresh `npm run dev --prefix frontend -- --host 127.0.0.1 --port 3017` process separately before the runner,
and keep source files unchanged during the smoke (Vite HMR can load multiple
module generations into debug imports).
Finish frontend tests/builds before starting that Vite process. Even changes to
unimported test files can trigger a full Vite page reload and clear fixture state;
do not edit those files during the desktop smoke either.
`terminal-monitor-layout.ps1` reads monitor bounds under a temporary, restored
thread DPI context. With multiple monitors the runner places its own source and
destination windows on different displays for both single-session and grid title
returns, and prints their webview scales. It also compares native/UI cursor
samples when the physical pointer stays stationary. No display settings or OS
mouse input are changed; a one-monitor machine skips this cross-monitor step.
For an actual mouse driver, set `NETRIX_TERMINAL_SMOKE_REAL_MOUSE=1` before running
the script. It pauses at single-session and four-session title returns instead
of synthesizing those gestures. `real-mouse-ready.json` in the artifact directory
contains the fixture PID, window labels and physical destination point. Each
checkpoint has a four-minute deadline and still verifies session IDs, transport
count, destination state and source closure before proceeding and cleaning up.
The dedicated target directory never overwrites the normal dev binary, including
when an ordinary Netrix instance is running. `NETRIX_TERMINAL_SMOKE_BINARY` can
point to another dedicated binary; the identifier guard still applies. The smoke
checks three real detach/return cycles, one transport/session ID, cancellation,
native-close dialogs, Escape, docking geometry and usable input. Synthetic PNGs
are written to `backend-rs/target/terminal-window-smoke/`. It drives DOM controls
through CDP; OS mouse dragging across monitors and real SSH/Serial devices still
belong to the manual lifecycle matrix.

The runner also simulates the native drag-loop/cursor boundary to check real
cross-window hover entry/exit/drop, stationary shelf visibility and the compact
preview. It asserts that xterm identity, rows/columns and native window dimensions
stay unchanged. `07-compact-dock-preview.png` and `08-active-dock-destination.png`
show the hover appearance; OS dragging is still a separate manual check.

It also drives the actual tab pointer sensor through tear-out and Escape, checks
that the source slot keeps its width and that the native preview closes, inserts
a returning terminal between two idle tabs, and returns through the native-close
dialog. `09-detach-drag-preview.png` shows the drag card.

The pane scenarios detach a 2×2 group, use Choose a connection in pane four while
pane three stays vacant, insert a main-window tab into pane two through the real
tab pointer sensor, and insert a standalone floating terminal into pane three.
The filled group returns to main with all four session IDs in the same cells and
exactly four loopback TCP connections. Screenshots `13`–`16` record those states.
Native window hit-testing and addressed Tauri handoffs remain real; cursor and
native move-loop completion are simulated at the same boundary as the earlier
drag scenarios. Actual OS dragging across monitors remains a manual check.

Return regressions additionally cover a minimized main window and two concurrent
floating-window returns. The first replay barrier is deliberately held while the
second request arrives, verifying one active preparation and preserved renderer
ownership before releasing it. Both session IDs return without new connections,
and the existing grid stays unchanged. With six live sessions present, selecting
grid on a standalone session produces three vacant cells; changing to rows or
columns never adds the other sessions. Screenshots `17`–`18` record these states.

Individual extraction scenarios drive the pane header grip from a detached grid
to the main tab strip and outside terminal windows. The latter opens a real
standalone window through `open_terminal_window`. Only the chosen source slots
become empty; neighboring xterm/socket objects and all four TCP connections stay
unchanged. The extracted sessions return individually, then the remaining group
returns with its vacant cells preserved. Screenshots `19`–`22` record these states.
Pointer/cursor input is simulated through CDP; routing, native window creation,
hit-testing and handoff commit remain real.
The runner additionally invokes the native observer/cancellation IPC in main and
a detached terminal, checking cancel-before-start and release result shape.

Screenshots `23`–`26` cover Single restoring an ordinary one-session tab, splitting
a four-session floating group into accessible independent tabs with unchanged
sockets, dragging one back to main, making a fresh one-session split while its
siblings stay independent, extracting that group through the native opener,
and returning all remaining singles without new transports or lost focus.
