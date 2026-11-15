---
name: testing-and-ci
description: 'Use when: adding Netrix tests, choosing validation commands, editing GitHub Actions, Dependabot, build checks, frontend typecheck/build, or backend cargo tests.'
---

# Testing and CI

For terminal detach/return changes, use the focused unit/loopback suites and the actual-window runner in `docs/TERMINAL_WINDOW_HANDOFF.md`. Start a fresh Vite server on the smoke-only 127.0.0.1:3017 endpoint and build with `scripts/terminal-smoke.tauri.json` into `backend-rs/target/terminal-window-shell`; never overwrite a running ordinary dev binary with the smoke identifier. Never rely on APPDATA overrides to isolate Tauri's Windows profile.

## Purpose

Guide validation choices and CI changes for Netrix.

## Rules

- Use the narrowest relevant validation first.
- Windows runtime packaging also requires `test:installer` after NSIS is available and `check:windows:binaries` after the release build. Keep dependency evidence private; passing fixture/runner checks is not a clean-machine QA result.
- Run backend tests for backend behavior changes.
- Run frontend typecheck/build for TypeScript or UI changes.
- Update `docs/TESTING.md` when commands, CI, or coverage expectations change.
- Windows releases follow `docs/WINDOWS_RELEASES.md`: private source, public installer-only distribution, exact version tags, draft-first uploads and QA before publication. Never replace published assets or expose private source. Run `npm run test:scripts` with PowerShell 7 available before changing the pipeline.
- Use Node 24.x (minimum 24.0.0, latest patch preferred); keep package/lockfile engines, `.nvmrc`, onboarding docs and the CI minimum/current matrix aligned. Validate clean installs with `npm ci --engine-strict` in both root and frontend. Before release, run `npm run release:check`; use a source-complete separate workspace when current development build outputs must be preserved.

## Architecture Guidance

- Backend integration tests are in `backend-rs/tests/api_tests.rs`.
- Vault unit tests are in `backend-rs/tests/vault_tests.rs`.
- CI has separate backend and frontend jobs.
- Dependabot groups backend Cargo, Tauri Cargo, frontend npm, and GitHub Actions updates.

## Coding Standards

- Prefer deterministic tests with in-memory SQLite where possible.
- Give each loopback SSH fixture a unique `KnownHostsStore::from_path` and clone it across that fixture's terminal/SFTP managers. Keep strict verification; do not share mutable trust files between parallel fixtures.
- Bound interoperability-fixture shutdown, close accepted connections before awaiting listeners, and retain Windows Selector-loop handling for deliberate reset tests in `scripts/sftp-smoke.py`.
- Await SQLx pool closure in encrypted-storage fixtures before destroying their runtime or process. Dropping a pool and yielding once does not guarantee native SQLCipher workers have stopped. Native process-exit crashes fail the release gate even after a passing test summary.
- Before immediately reopening, snapshotting or deleting an encrypted fixture, acquire every pool connection and explicitly await each connection's graceful close, then close the pool. This also drains asynchronous query returns; a pool's closed flag alone does not prove Windows file handles have been released. Keep immediate cleanup assertions instead of sleep/retry workarounds.
- Test validation and error responses, not only success paths.
- For migrations, test the API behavior that depends on the schema.
- For security fixes, add regression tests around rejection paths.

## Anti-Patterns

- Treating frontend build as a substitute for backend tests.
- Adding network-dependent tests to the normal suite without isolation.
- Changing CI without updating local validation docs.
- Ignoring Windows command differences documented in repo memory.

## Example

For a router validation change, add an Axum `oneshot` test in `api_tests.rs`, run `npm run test:backend`, then run broader checks if shared models or frontend payloads changed.
