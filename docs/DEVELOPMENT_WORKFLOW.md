# Development Workflow

## Setup

1. Install Node.js 24.x LTS (minimum 24.0.0; use the latest 24.x patch) and stable Rust. `.nvmrc` selects the supported Node major.
2. Install locked dependencies with `npm ci` and `npm ci --prefix frontend` from the repo root.
3. Build the backend sidecar for development with `cargo build --manifest-path backend-rs/Cargo.toml`.
4. Start the desktop app with `npm run tauri dev`.

The frontend dev server runs on port 3000. Tauri expects that fixed port in `src-tauri/tauri.conf.json`.

## Common Commands

- `npm run check`: backend check, backend tests, frontend typecheck, frontend build.
- `npm run check:backend`: `cargo check --manifest-path backend-rs/Cargo.toml`.
- `npm run check:tauri`: `cargo check --manifest-path src-tauri/Cargo.toml`.
- `npm run lint:backend`: `cargo clippy --manifest-path backend-rs/Cargo.toml --all-targets -- -D warnings`.
- `npm run test:backend`: `cargo test --manifest-path backend-rs/Cargo.toml`.
- `npm run check:frontend`: frontend typecheck and production build.
- `npm run format`: Prettier for TS/JS/JSON/CSS/MD files.
- `npm run tauri dev`: full desktop app.
- `npm run tauri build`: production package.

## Change Workflow

1. Identify the owning surface: frontend component/store, backend router/domain module, Tauri shell, migration, or docs.
2. Read the nearest existing implementation and tests.
3. Make a narrow change that preserves existing API and runtime boundaries.
4. Run the narrowest validation command first.
5. Update the relevant docs in `docs/` and skill file in `.github/skills/` when the workflow changes.
6. Run `npm run check` before a broad or release-bound change.

## Backend Workflow

- Add endpoints in the closest router under `backend-rs/src/routers/`.
- Add or update DTOs in `backend-rs/src/models.rs`.
- Use `AppError` for validation and business failures.
- Use SQLx binds for database access.
- For schema changes, add a migration and register it in `db.rs`.
- Add backend tests under `backend-rs/tests/` for behavior changes.

## Frontend Workflow

- Add shared state/actions to `frontend/src/state/store.ts` only when multiple components need them.
- Keep one-off UI state inside the component.
- Use `authenticatedFetch` for HTTP and the existing WebSocket token protocol for terminal sessions.
- Preserve localStorage usage for settings/layout only.
- Validate with frontend typecheck/build after TS or UI changes.

## Tauri Workflow

- Treat all files under `src-tauri/capabilities/`, `src-tauri/build.rs`, and `src-tauri/tauri.conf.json` as security-sensitive. Keep app commands and core/plugin permissions scoped to the smallest window-label set.
- If backend sidecar packaging changes, verify `scripts/prepare-sidecar.mjs` and Tauri `externalBin` still agree.
- Keep API token transport via stdin and IPC.

## AI Agent Expectations

- Do not invent frameworks or project structure.
- Prefer existing router/component/store patterns.
- Avoid unrelated cleanup.
- Document unimplemented behavior instead of pretending it exists.
- Always call out security implications for credentials, shell permissions, CORS, CSP, filesystem access, remote command execution, or network scans.
