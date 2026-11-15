# SFTP And Files Test Plan

Additional view/pool regressions: switch hosts during initial or cached-folder loading and return; close preview before its response; complete a confirmed mutation after opening another host's preview; edit a profile endpoint and verify old paths/actions disappear and the new home opens; rename/change font and verify the listing remains. Disconnect one of two profiles at the same address and verify the other reuses its connection. Disconnect while listing/setup is in flight and verify old leases cannot revive the pool. A submitted mutation can settle after leaving a view; do not promise rollback.

Use this runbook before a production release when `SftpBrowser`,
`/sftp/*`, `ssh::sftp`, vault credential handling, host CRUD credentials, or
terminal/SFTP coexistence behavior changes.

## Test Setup

- Build and run the desktop app with `npm run tauri dev` or test the latest
  release installer.
- Prepare one SSH host with valid credentials and SFTP enabled.
- Prepare the same SSH host with intentionally wrong credentials.
- Prepare one SSH host or device that accepts terminal SSH but rejects the SFTP
  subsystem.
- Prepare a remote directory with at least 500 entries.
- Prepare one small text file, one binary file, and one file larger than the
  text preview limit.
- Keep an active terminal session to the same host open while running SFTP
  actions.

## Automated Coverage

Backend tests cover these SFTP invariants:

- SFTP capability is `unknown` for SSH hosts until probed.
- SFTP capability and file operations reject non-SSH hosts.
- Upload path validation and download read-limit validation happen before
  network I/O.
- Remote directory batches under the parser limit are accepted.
- Remote directory batches over the parser limit are rejected.
- `.` and `..` directory entries are filtered.
- File type, permissions, paths, and modified timestamps are parsed from SFTP
  directory attributes.
- Preview reads can truncate at the configured limit.
- Full downloads fail when the remote file exceeds the configured read limit.
- Uploads use exclusive temporary files, bounded pipelining, checked CLOSE and a final rename; replacements require confirmation and atomic-rename support.
- Oversized SFTP packets are rejected.
- SFTP subsystem rejection messages stay stable for the UI.

Run:

```powershell
npm run test:backend
```

## Manual Matrix

| Scenario | Steps | Expected result |
| --- | --- | --- |
| Open SFTP from SSH host | Open Files, choose a valid SSH host with SFTP enabled. | Directory listing loads, status shows available, path and entries are visible. |
| Wrong credentials | Save/open the same host with a bad password or locked credential. | Files shows an auth error, no endless loading state, terminal sessions remain unaffected. |
| Host without SFTP support | Open Files for an SSH device that rejects the SFTP subsystem. | Files shows unavailable/unsupported, terminal access to the same host still works. |
| Large directory listing | Open a directory with 500+ entries. | Listing remains responsive, entries are sorted with directories first, scrolling is smooth. |
| Filter and sort | Search by part of a name, toggle hidden files, sort Name/Size/Modified in both directions. | Filtering applies to the current directory; folders stay first, dotfile counts are visible, hidden selection cannot be deleted. |
| Direct path and recovery | Use Ctrl+L within a file pane, enter a valid path, then an inaccessible one; Retry, Home, Back and Forward. | Retry targets the failed path; navigation recovers and Back includes the initially cached folder. Root has no enabled parent action. |
| Local and remote panes | Toggle Local panel at wide and narrow desktop widths; select a remote file. | View, Download and mutation actions remain accessible, filenames fit without a forced 680px table, secondary metadata is available in File details. |
| Keyboard and dialogs | Move through rows with arrows/Home/End, open with Enter, rename with F2, delete with Delete and cancel. Enter an invalid name or permission value. | Deletion requires confirmation; invalid input stays visible with an inline error; preview/details trap focus and close with Escape. |
| Permissions prefill | Select a directory with mode 750 and open Permissions. | The editor starts at 750; invalid octal digits cannot be submitted. |
| Local upload selection | Select a local file, then a file exceeding 128 MiB. | Selection alone never uploads; the upload target is visible and an oversized file has an explanation. |
| Transfer drawer | Start a transfer with recent history present; collapse, expand and clear finished rows. | Active transfers stay visible ahead of history; clearing finished rows never cancels active jobs. |
| Upload | Upload a small text file and a larger binary file. | Remote file appears with the expected size, progress reaches done, no stale busy state remains. |
| Download | Download a small text file and a binary file. | Saved file size/content matches the remote file, progress reaches done. |
| Download active log | Append new lines while downloading a known-size log. | Download completes at the initial size; history explains that later data is excluded. A shrinking/rewritten file, early EOF or failed CLOSE still fails. |
| Select several files | Ctrl-click two files, toggle one off, Shift-click a range, then filter. | Highlight/count matches the selection; focus does not collapse it; hidden items are removed and single-item mutations are disabled for multiple selection. |
| Batch download | Download several selected files; cancel the picker, decline an existing-name replacement, cancel/switch hosts during transfer, and try a failed local save. | One folder picker when supported, otherwise individual browser downloads. Files process sequentially; cancelled/failed work stops the queue; acknowledged prior files remain; uncommitted writable data is aborted. |
| Local save access on Windows | In Netrix, select a disposable destination for a download that requests WebView2 file access. Verify the file list and destination type. Cancel once, then repeat and allow. | The Files form appears after the system picker. Cancellation starts no transfer. Approval applies to the outstanding picker and starts the transfer after access is granted. |
| Preview bounded file | Preview a text file larger than the preview limit. | Preview opens quickly, shows truncated marker, full download is still available. |
| SFTP while terminal active | Keep an interactive terminal open, then list/upload/download through Files. | Terminal prompt remains usable, no disconnect/reconnect happens in the terminal tab. |
| Terminal while SFTP active | Start an upload/download, then open or use terminal for the same host. | SFTP continues or fails independently; terminal state is not reset. |
| SFTP disconnect | Close the Files session while the terminal tab is connected. | Files state clears, terminal tab remains connected. |

## Release Definition Of Done

- Run the manual matrix across at least 10 valid SFTP sessions and 10 failure
  sessions.
- No stuck checking/loading/uploading/downloading state.
- No terminal disconnect or duplicate SSH login caused by SFTP actions.
- No backend crash or orphaned backend process after SFTP failures.
- Upload/download file sizes match expected values.
- Unsupported SFTP hosts remain usable in Terminal.
- `npm run check` passes after the test build.
- `npm run check:tauri` passes after the test build.

## Transfer hardening matrix

| Scenario | Expected result |
| --- | --- |
| Cancel while uploading over a slow link | Backend job stops, original destination is intact, temporary file is removed or its remaining path is reported. |
| Disconnect after final rename was sent | No automatic write retry; inspect destination if acknowledgement was lost. |
| Server returns failure on CLOSE or fsync | No rename; existing file remains intact. |
| Replace on server without posix-rename v1 | Clear refusal; choose a new name; never delete/truncate the original. |
| Local save fails or is cancelled | Writable destination is aborted, no download-success toast. |
| Delete a non-empty directory | Refused, children are untouched. |
| Rename to an existing name | Refused, neither entry is overwritten. |
| Unicode and leading/trailing spaces | Paths round-trip exactly. Non-UTF-8 names are rejected explicitly. |
| History | Back/forward works independently for local folders and each remote host. |
| Concurrent tabs | Closing/switching Files cancels its work without affecting terminals. |

The opt-in smoke command and protocol/size limits are documented in [SFTP implementation](SFTP_IMPLEMENTATION.md). Native WebView save-picker/Downloads behavior still requires this manual runbook.

Focused regressions: `cargo test --manifest-path backend-rs/Cargo.toml --lib ssh::sftp` and `npm run test:run --prefix frontend -- src/features/sftp src/components/SftpBrowser.test.tsx src/components/LocalFilePanel.test.tsx src/state/store.test.ts`. The isolated AsyncSSH smoke also appends after initial FSTAT, verifies exact original bytes and checks completed-job warning metadata.
