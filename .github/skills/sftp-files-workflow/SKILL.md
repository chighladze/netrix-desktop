---
name: sftp-files-workflow
description: 'Use when: changing Netrix SFTP Files workflow, SFTP capability probing, directory listing, preview, download, upload, transfer UI, or host capability cache.'
---

# SFTP Files Workflow

## Purpose

Guide SFTP feature changes across backend `routers/sftp.rs`, `ssh/sftp.rs`, database `host_capabilities`, and frontend `SftpBrowser.tsx`.

## Rules

- SFTP is SSH-only.
- SFTP must use separate SSH connections, not active terminal sessions.
- Keep download, preview, and upload size limits bounded.
- Known-size downloads stop at the initial handle size. Final growth is a successful bounded copy with a visible warning; truncation, early EOF, same-size mtime changes and failed CLOSE still fail. Never describe this as a coherent snapshot of a concurrently rewritten file.
- Remote multi-selection must survive Ctrl-click focus, exclude filtered-out rows, and disable single-item mutations. Batch downloads share one view-scoped cancellation controller and commit only after backend completion; local collisions require confirmation when writing through a chosen directory handle.
- Keep capability states explicit: `unknown`, `supported`, `unsupported`, `auth_failed`, `error`.
- Treat upload, replacement, rename, delete and chmod as explicit remote writes. Uploads use exclusive temporary files and checked CLOSE before rename; never truncate the destination in place.

## Architecture Guidance

- Capability cache is stored in `host_capabilities` with 12-hour expiry timestamps.
- Backend loads saved credentials through the vault when `credential_id` is present.
- Scope pool reuse and lifetime invalidation by saved host ID. Disconnect must preserve other profiles and prevent old leases from returning to the pool. Restore invalidates all lifetimes.
- Frontend Files view filters to SSH hosts.
- `/sftp/transfers` exposes bounded in-memory jobs, real progress and explicit cancellation. Streaming workers retain workspace leases until cleanup completes.

## Coding Standards

- Validate remote paths for empty, length, and NUL bytes.
- Return helpful errors for auth failure, host key mismatch, unsupported subsystem, and network/probe failures.
- Use `authenticatedFetch` for streaming upload/download; progress comes from backend job acknowledgements, never localhost HTTP upload progress.
- Scope view completion callbacks, busy state and previews to their initiating view/request. Reset cancelled listings to a retryable state, and never reload a departed host from a cancelled transfer's finally block. Tab changes cannot roll back an already dispatched mutation.
- Bind cached listings/selection to secret-free profile connection parameters. Endpoint/user/protocol/credential-link/jump-link changes must not reuse old server paths; cosmetic edits should preserve the view.

## Anti-Patterns

- Probing SFTP automatically when opening normal terminal sessions.
- Showing SFTP actions for Telnet or Serial hosts.
- Reading or uploading unbounded files.
- Hiding host key mismatch as a generic network error.

## Example

Mutations use POST /sftp/hosts/{id}/operations. Keep exact-path deletion confirmation, no-overwrite rename, empty-directory-only deletion and 000-777 permissions. Follow docs/SFTP_IMPLEMENTATION.md and extend negative-path packet/router/UI tests. Run scripts/sftp-smoke.py against an isolated backend for interoperability.
See [SFTP implementation](../../../docs/SFTP_IMPLEMENTATION.md) for job contracts, commit/cancel ordering, streaming limits, connection reuse and cleanup.
