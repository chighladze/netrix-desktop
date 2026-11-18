# Netrix Copilot Instructions

These instructions are for AI agents working in this repository. Netrix is a local-first desktop terminal client for network professionals. The repo is production-oriented but still evolving, so prefer small, verified changes over broad rewrites.

## Project Shape

- `src-tauri/` is the Tauri 2 shell. It owns window lifecycle, plugin permissions, backend sidecar startup, and Tauri commands such as `get_backend_port` and `get_api_token`.
- `frontend/` is a React 18 + TypeScript + Vite + Tailwind app. It uses Zustand for app state, xterm.js for terminals, Tauri APIs for desktop integration, and authenticated HTTP/WebSocket calls to the backend on `127.0.0.1`.
- `backend-rs/` is the Rust Axum sidecar. It owns REST APIs, WebSocket terminal sessions, SQLite persistence, SSH/Telnet/Serial transports, SFTP operations, network tools, logging, and the encrypted credential vault.
- `backend-rs/migrations/` contains versioned SQLite schema migrations. Every new migration must also be registered in `backend-rs/src/db.rs`.
- `docs/` contains human and AI onboarding material. Uppercase docs are the AI-friendly canonical map; existing lowercase docs are retained for compatibility.

## Core Runtime Flow

1. Tauri generates a per-launch API token, starts the sidecar and writes the token to private stdin.
2. The sidecar binds on `127.0.0.1:0` and reports the bound port on private stdout. Tauri authenticates `/health` before publishing readiness.
3. The frontend retrieves the verified port and token through Tauri IPC. Tauri closes the stdin pipe to request bounded backend shutdown.
4. HTTP requests use `X-API-Token`; WebSockets use `Sec-WebSocket-Protocol` values `netrix.v1` and `netrix-token.<token>`.
5. Backend binds only to `127.0.0.1`, applies token middleware, serves Axum routers, and uses SQLite under the Netrix app data directory.

## Engineering Rules

- Do not rewrite architecture unless the user explicitly asks. Preserve the Tauri shell, React frontend, and Rust sidecar separation.
- Keep router handlers thin when adding backend behavior. Put shared behavior in domain modules such as `ssh/manager.rs`, `ssh/sftp.rs`, `vault.rs`, or focused helpers.
- Use parameterized SQLx queries with `.bind(...)`. Do not build SQL with user-controlled strings.
- API errors should use `AppError` and return `{"detail": "..."}` through the existing `IntoResponse` path.
- Saved-host secrets must go through the vault. Never add plaintext credentials to API responses.
- Quick-connect sends ephemeral credentials through authenticated HTTP and uses an expiring one-time ticket for the WebSocket. Keep credentials out of URLs.
- Validate inputs at the backend boundary. Host validation is the strongest existing example; match or improve that standard for new routers.
- For schema changes, add a numbered SQL migration and update the embedded migration list in `backend-rs/src/db.rs` in the same change.
- For frontend API calls, use `authenticatedFetch` from `frontend/src/api.ts` unless a browser API requires manual headers, as in SFTP upload progress.
- For terminal connections, respect the existing session/detach/reattach model in `TerminalCanvas` and `backend-rs/src/ssh/manager.rs`.
- Do not introduce cloud dependencies or telemetry without explicit product direction. Netrix is designed to keep data local except user-initiated remote connections.

## Frontend Standards

- Use strict TypeScript types. Avoid `any` unless bridging untyped browser/Tauri APIs and keep the cast local.
- Keep persisted UI preferences in localStorage; do not store credentials or vault passwords there.
- Use Zustand actions for shared app state. Avoid scattering duplicate global state in components.
- Use Tailwind and existing visual language. The current app is a dense desktop operations UI, not a marketing site.
- Preserve xterm.js lifecycle rules: dispose terminals and close sockets when tabs are removed.
- Prefer `authenticatedFetch`, `getApiBase`, `getWsBase`, and Tauri `invoke` helpers instead of hard-coded ports or tokens.
- When modifying WebSocket behavior, keep progress/control messages prefixed with `__JSON__` on the backend path that TerminalCanvas expects.

## Backend Standards

- Rust edition is 2021. Use `cargo fmt`, `cargo check --manifest-path backend-rs/Cargo.toml`, and `cargo test --manifest-path backend-rs/Cargo.toml` for backend changes.
- Do not use `unwrap` or `expect` in request paths. Tests may use them.
- Use `tracing` for backend logs. Avoid logging secrets, private keys, passphrases, vault plaintext, or full command payloads.
- Host key verification defaults to strict TOFU. Do not bypass it except through the existing `SSH_KNOWN_HOSTS_POLICY=insecure` setting, and document any change clearly.
- Keep network-tool limits conservative. TCP scan and TLS inspect are intentionally rate-limited and input-validated.
- SFTP must remain separate from interactive terminal sessions. Do not reuse or close terminal SSH sessions for Files operations.

## Tauri Standards

- Tauri owns backend process lifecycle and plugin permissions. Be careful when changing `src-tauri/capabilities/default.json` or `src-tauri/tauri.conf.json`.
- Backend token must stay out of command-line arguments. It is written to sidecar stdin for a reason.
- Production sidecar packaging depends on `scripts/prepare-sidecar.mjs` and `src-tauri/binaries/netrix_backend-*`.
- The current CSP includes `unsafe-eval` and `unsafe-inline`; treat CSP relaxation as security-sensitive and document why it is needed.

## Validation Commands

- Full local check: `npm run check`
- Backend check: `npm run check:backend`
- Backend tests: `npm run test:backend`
- Frontend typecheck/build: `npm run check:frontend`
- Frontend only: run `npm run typecheck` and `npm run build` from `frontend/` when root `npx tsc` resolution is unreliable on Windows.
- Tauri dev: `cargo build --manifest-path backend-rs/Cargo.toml` then `npm run tauri dev`

## Known Risk Areas

- `frontend/src/App.tsx`, `frontend/src/components/TerminalCanvas.tsx`, and `frontend/src/state/store.ts` are large coordination files. Make narrow changes and validate manually where possible.
- WebSocket terminal lifecycle is fragile because detach, reattach, reconnect, resize, and close semantics cross frontend and backend.
- Database migrations are manually registered in Rust.
- Frontend has no dedicated unit or E2E test suite today; typecheck/build are the main automated frontend gates.
- Quick-connect credential transport, CSP allowances, broad Tauri shell permissions, and incomplete endpoint rate limiting are documented security debts.

## Documentation Expectations

- Update the relevant uppercase doc in `docs/` when changing architecture, API routes, schema, security posture, deployment, or testing expectations.
- Update `.github/skills/*/SKILL.md` when a repeatable workflow changes.
- Do not add placeholder documentation. If behavior is not implemented, say so explicitly.
