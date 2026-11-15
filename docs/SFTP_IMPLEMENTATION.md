# SFTP implementation

Files uses an isolated SFTP v3 SSH transport. It never borrows or resets a terminal
session. Authentication, vault loading, token middleware and strict TOFU are shared
with the existing application security model.

## Safe uploads

An upload checks the destination with LSTAT and opens a random sibling
`.netrix-<uuid>.part` file using WRITE | CREAT | EXCL, initially with mode 0600.
It streams the request body in 32 KiB chunks, with at most eight outstanding WRITE
requests. Progress counts bytes acknowledged by successful server status packets.
Out-of-order acknowledgements are matched by request ID.

After writing, it verifies the available FSTAT size, preserves the old regular
file's ordinary permission bits when replacing it, calls `fsync@openssh.com` when
version 1 is advertised, and checks CLOSE. It then commits with a rename.
New-file commits use standard v3 RENAME, which refuses an existing destination.
Confirmed replacements require advertised version 1 of
`posix-rename@openssh.com`. There is no delete-then-rename or in-place truncation
fallback. Symlinks, directories and special files cannot be replaced by upload.

New files retain mode 0600; users can explicitly change permissions afterwards.
Atomic replacement creates a new inode owned by the authenticated account. It
does not promise preservation of ownership, ACLs, extended attributes or hard-link
relationships. Concurrent edits by other remote clients are not locked.
When fsync is unavailable, a successful operation confirms the server's WRITE,
CLOSE and RENAME replies, not durability through server power loss.

Cancellation wins until the commit boundary. The registry serializes cancellation
with entering `committing`; cancellation returns 409 once the rename is starting.
If the rename reply is lost, the result is a failure with an instruction to inspect
the destination before retrying. Writes are never retried automatically.

A failed/cancelled upload discards its connection and attempts cleanup through a
fresh connection for up to ten seconds. A few bounded retries handle Windows
servers which are still releasing the old channel's file handle. If cleanup is
impossible, the job includes the exact temporary path. An unreachable server or
process crash can leave a `.part` file; existing destination bytes remain untouched
before commit. Do not indiscriminately delete other `.part` files.
Cleanup reserves the failed worker's connection slot so queued transfers cannot
starve it. If OPEN was sent but its handle was never acknowledged, ownership of
the temporary file is unconfirmed: its path is reported for inspection rather than
automatically removing a file the client could not confirm it created.

## Streaming downloads and preview

Full downloads use a four-chunk bounded HTTP output channel. Known-size files are
read with at most eight 32 KiB requests outstanding; responses are ordered by
offset and short reads are filled. Unknown-size files use bounded sequential
reads. Known-size downloads stop at the size observed on the opened handle before
the first READ. If the final FSTAT reports growth, the original byte range is
accepted after successful CLOSE and the job carries a `warning` explaining that
later data is excluded. This supports actively appended logs without following
an indefinitely moving EOF. Shrinkage, early EOF, same-size modification-time
changes, failed CLOSE and initial files over the limit still fail. Unknown-size
files retain bounded EOF reading and strict metadata checks. These checks detect
common concurrent modifications; they do not lock the remote file or guarantee a
consistent snapshot when earlier bytes are rewritten, including rewrite-plus-growth.

An HTTP 200 or an ended body alone does not prove a successful download. Clients
must inspect the associated job; stream errors terminate the body and the job
contains the cause. The UI checks job completion before closing the local writable
file or offering a browser download, and aborts its writable destination on error.
Browser runtimes without a writable save picker use a bounded Blob fallback.
Ctrl/Command-click toggles remote file selection; Shift selects a visible range
and Ctrl+A selects visible rows. Filtering removes hidden selections. Multiple
selection disables single-item operations and mixed file/folder selection cannot
start a download. Selection is scoped to the host/connection/folder listing.
Batch downloads run sequentially with one tracked cancellation scope. Where the
runtime supports directory picking, one user gesture chooses a destination folder;
existing local names require replacement confirmation. Names that collide after
sanitization receive numbered suffixes. Otherwise each verified file is offered
through the existing browser download path, with only one file buffered at a time.
On Windows, when the destination picker requests WebView2 file access, Files
shows the selected files and destination type in an in-app confirmation.
The operating system still provides the file or folder picker. Cancelling the
confirmation stops the download before a transfer job is created.
Failures/cancellation stop the rest of the batch; already completed files remain.
Changing host/closing Files cancels the originating batch. Local writable failures
abort staged writes and are never reported as successful saves.
Backend `completed` for downloads means remote reading/closing completed; the UI
success notification follows local saving. Remote files are never loaded in full
in backend memory. Only bounded preview reads are buffered.

## Jobs, bounds and lifetimes

- File upload/download limit: 128 MiB; backend preview limit: 2 MiB; UI preview:
  1 MiB. The size limit is enforced incrementally, including chunked HTTP uploads.
- Up to eight queued/running jobs and 128 retained in-memory history records.
  Unclaimed jobs expire after 60 seconds. No file bytes or credentials enter job
  records or SQLite. History is scoped to the backend process.
- Four concurrent isolated SFTP connection leases; up to eight idle connections.
  Idle connections expire after 60 seconds, swept every 15 seconds.
- Reuse keys are process-salted SHA-256 digests including endpoint, username,
  saved profile ID, credentials, policy and current known-host entry. Credential/trust changes cannot
  borrow a connection keyed to the previous values. Secrets in temporary target
  objects are zeroized on drop.
- Setup deadline: 20 seconds in HTTP workflows, covering queueing, TCP/SSH,
  authentication, channel, subsystem and SFTP initialization. Packet I/O and HTTP
  source/destination stalls: 30 seconds. Listings and mutations: 30 seconds total;
  preview: 60 seconds; transfer preparation/read: 15 minutes total.
- Paths: 4096 bytes; handles: 256 bytes; packets: 16 MiB; directory batches:
  10,000 entries; a full listing: 100,000 entries and 16 MiB of metadata.
  Invalid/non-UTF-8 names and slash/NUL in directory entry names are rejected.
- Failed, cancelled or timed-out connections are discarded. There is no automatic
  replay of a file write on a stale connection.
- Disconnect invalidates only the selected saved profile's pool lifetime, drops its idle connections and cancels its pending setup. A lease already executing an operation cannot return to the pool after disconnect, even if it finishes successfully. Other profiles, including profiles for the same endpoint, retain their own connections. Host deletion uses the same scoped invalidation; workspace restore invalidates all pool lifetimes. Weak lifetime references are pruned so the pool does not retain a history of previously visited hosts.
- Transfer workers own workspace read leases until cleanup ends. Restore cannot
  replace database state beneath active workers, rejects queued jobs, and drops
  idle connections. Closing Files cancels its requests/jobs; closing a download
  body also stops its worker. Terminal connections remain independent.

Switching Files hosts cancels the outgoing view's pending requests and transfer batch. Interrupted directory loads become retryable and reload on return, including when a previous listing was cached. Late responses cannot replace a newer listing. Closing a preview cancels that specific read and prevents its response from reopening the preview. Completion callbacks are scoped to the view which started them; an old mutation/transfer cannot clear a different view's busy state or preview. A confirmed mutation already sent to the server is allowed to settle and invalidates its original host's listing; changing tabs does not claim to roll it back. Navigation and double-click actions are blocked while another file action owns the current view. A failed backend disconnect is reported instead of silently claiming success.

Cached listings carry a secret-free connection key (address, port, username, protocol, credential link and jump link). Changing these profile fields hides old entries/selection immediately, cancels that view's pending actions and opens the new target's home directory. Cached states lacking a binding are refreshed too. Cosmetic profile edits retain the listing. This UI binding does not replace backend credential loading and strict server-key verification.

## API

All routes require the existing API token.

| Route | Contract |
| --- | --- |
| POST `/sftp/hosts/{id}/transfers` | JSON `kind: upload/download`, `path`, optional `bytes_total`, `overwrite`. Replacement requires `confirmation: OVERWRITE`. Returns 201 and the job. |
| POST `/sftp/hosts/{id}/upload?path=...&transfer_id=...` | Raw streamed file body. Claims a job once; host, path and direction must match. A successful JSON result includes `size` and `transfer_id`. |
| GET `/sftp/hosts/{id}/download?path=...&transfer_id=...` | Streaming octet body with `x-netrix-transfer-id`. `truncate=true` selects the bounded preview route instead. |
| GET `/sftp/transfers` | `{transfers:[...]}`, newest first. |
| GET `/sftp/transfers/{id}` | Job with status, acknowledged/read bytes, total and optional error. |
| POST `/sftp/transfers/{id}/cancel` | Explicit cancellation; 409 during commit. Cancellation is idempotent for terminal jobs. |
| POST `/sftp/hosts/{id}/operations` | JSON `action`, `path`, optional `destination` or three-digit octal `permissions`. Actions: mkdir, rename, delete, chmod. Returns 204. |
| POST `/sftp/hosts/{id}/disconnect` | Cancels this host's jobs/setup, invalidates its leases and clears only its idle SFTP transports; returns 204. Already executing non-transfer operations may settle under their existing deadlines. |

Upload/download requests without a job ID create and claim an implicit job for
compatibility; implicit uploads do not authorize overwriting. Explicit jobs are
recommended for progress and cancellation. Statuses are `queued`, `connecting`,
`running`, `finalizing`, `committing`, `cancelling`, `completed`, `failed`, `cancelled`.

Delete requires `confirmation` equal to the exact requested path. It uses LSTAT to
distinguish files/symlinks from directories, removes only empty directories, and
never recurses. Rename refuses an existing destination. Chmod accepts 000-777 and
rejects symlinks. Root, final `.`/`..`, empty and NUL paths are rejected for mutations.
SFTP v3 path operations cannot eliminate races with other remote filesystem users.

Folder recursion, synchronization and resume after application restart are not
implemented. File operations are explicit and no background upload starts on launch.

## Verification

Normal checks include deterministic packet-level tests, router validation/auth
tests, job cancellation/commit tests, UI dialog tests and transfer hook tests.
Run `npm run check` and `cargo fmt --manifest-path backend-rs/Cargo.toml -- --check`.

For an opt-in real SSH/SFTP interoperability test, install AsyncSSH in an isolated
directory and run the script against a newly built backend:

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'backend-rs/target/validation'
cargo build --manifest-path backend-rs/Cargo.toml
python -m pip install --target backend-rs/target/validation/sftp-test-deps asyncssh==2.24.1
$env:PYTHONPATH = Join-Path (Get-Location) 'backend-rs/target/validation/sftp-test-deps'
python scripts/sftp-smoke.py --backend backend-rs/target/validation/debug/netrix_backend.exe
```

This script binds only loopback, uses a fresh ephemeral SSH key and strict TOFU,
launches its own token-authenticated backend and tests against disposable files.
It covers explicit subsystem rejection, multi-MiB byte equality, reuse, replacement, CLOSE failure, Unicode/space
names, basic mutations, cancellation cleanup, consumer disconnect and an SSH auth
stall. It kills only its own child and removes only its temporary test directory.
The server requires a nonempty password supplied from the saved host's encrypted Vault item. A lock/unlock case verifies that new SFTP operations are rejected while locked even with a cached authenticated transport, and that safe reuse resumes after unlock.
Two profiles for one endpoint verify independent reuse and disconnect. A gated directory listing verifies that a lease finishing after disconnect cannot revive the pool, and a stalled handshake verifies immediate setup cancellation rather than waiting for the setup timeout.
Fixture cleanup aborts its own accepted transports before awaiting listener shutdown and is bounded to 10 seconds, including stalled authentication on Python 3.12/Windows.
On Windows this TCP-only fixture uses the Selector event loop to avoid Proactor connection-lost callback failures during injected resets; it does not change the application's transport runtime.
It does not replace native Tauri/WebView save-picker QA or tests on OpenSSH and
network appliances; use `SFTP_FILES_TEST_PLAN.md` for those.

Protocol references: [SFTP v3 draft](https://www.ietf.org/archive/id/draft-ietf-secsh-filexfer-02.txt),
[OpenSSH extensions](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL),
[AsyncSSH server documentation](https://asyncssh.readthedocs.io/en/latest/).

## Comparison with the local Termos SFTP module

The reference is the local a separately reviewed reference implementation source, not the original Termius application. In `SftpView.tsx` and the preload/main handlers, local browsing and remote READDIR are implemented. Remote connection opens an SSH shell before listing; the SFTP handle is stored with that session. A listing error silently retries `.`. Filter/Actions buttons have no handlers, and the preload/main API exposes no SFTP upload, download or mutation operations. Switching the remote host does not explicitly disconnect the previous session or reject its late listing responses.

Netrix already implements isolated SFTP transports, per-host browser state, home/parent/back/forward navigation, bounded preview, streaming upload/download, transfer jobs/cancellation and confirmed mkdir/rename/delete/chmod. These features are backed by protocol/API/UI tests and the opt-in real server suite. The useful reference idea is a local/remote browsing workspace; Netrix retains its own UI and does not adopt hidden navigation fallbacks, unimplemented action buttons or shell-coupled SFTP. This pass fixes view lifecycle and per-profile disconnect behavior. Directory recursion/sync, navigating directory symlinks, persistent transfer resume and a native Tauri save-picker QA pass remain outside this implementation.
