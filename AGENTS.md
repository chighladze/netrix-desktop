# AGENTS.md

This file tells autonomous coding agents how to work inside Netrix.

## Mission

Netrix is a local desktop terminal client for SSH, Telnet, Serial, SFTP file workflows, credential vaulting, network tools, snippets, quick actions, host organization, and network maps. Agents should preserve the local-first security model and improve the system incrementally.

## Repository Map

- `frontend/`: React 18, TypeScript, Vite, Tailwind, Zustand, xterm.js, Tauri webview APIs.
- `backend-rs/`: Rust Axum sidecar, SQLx SQLite, Tokio, russh SSH, minimal Telnet, tokio-serial, SFTP v3 client, vault crypto, network tools.
- `src-tauri/`: Tauri 2 shell, plugin permissions, backend sidecar lifecycle, app packaging.
- `backend-rs/migrations/`: SQLite migrations embedded from `backend-rs/src/db.rs`.
- `docs/`: project context, architecture, API, database, security, testing, deployment, and workflow docs.
- `.github/skills/`: reusable AI workflows for this project.

## Agent Workflow

1. Start from the file or behavior the user names. If no file is named, use the docs and source map above to find the owning module.
2. Read the nearest implementation and tests before editing.
3. State a narrow hypothesis for the change in your own working notes.
4. Make the smallest coherent edit.
5. Run the most focused validation command available.
6. Update docs or skills when changing architecture, workflow, API, schema, security rules, or testing commands.

## Change Boundaries

- Do not collapse the backend into Tauri or the frontend into backend APIs. The three-process/source-boundary model is intentional.
- Do not add new global frontend state outside the Zustand store unless it is strictly local component state.
- Do not add plaintext credential fields to frontend-visible DTOs.
- Do not add SQL migrations without registering them in `backend-rs/src/db.rs`.
- Do not weaken localhost binding, token auth, CORS restrictions, or host key verification without an explicit security decision.
- Do not introduce generated code, Docker, OpenAPI, or new test frameworks unless the task calls for it.

## Coding Standards

- Rust: explicit errors, `AppResult<T>` in handlers, `AppError` for user-facing API errors, no `unwrap` in request paths, SQLx binds for all user input.
- TypeScript: strict types, small helpers, local casts only for Tauri/browser gaps, use `authenticatedFetch` for backend HTTP.
- Naming: Rust modules and functions use `snake_case`; TypeScript components use `PascalCase`; hooks use `useX`; Zustand actions use verb phrases; API JSON keeps existing snake_case fields from Rust DTOs.
- Logging: use `tracing` in Rust and avoid secrets. Frontend console output is dropped in production builds through Vite config.
- Tests: backend behavior needs integration/unit coverage when changing routers, vault, validation, migrations, session behavior, or network-tool constraints.

## Security Priorities

- Saved credentials belong in the encrypted vault only.
- Backend tokens are per-session and must stay in stdin/IPC/header/subprotocol transport.
- Quick connect uses one-time authenticated tickets; never put credentials in URL query strings.
- SFTP operations open separate SSH connections and must not interfere with terminal sessions.
- Network tools can scan remote targets by design; keep rate limits, bounds, and authorization messaging intact.
- Tauri permissions are part of the threat model. Any permission expansion requires documentation in `docs/SECURITY_RULES.md`.

## Validation Reference

- `npm run check`: backend check, backend clippy, backend tests, frontend typecheck, frontend build.
- `npm run check:backend`: Rust backend compile check.
- `npm run check:tauri`: Tauri shell compile/config check.
- `npm run lint:backend`: Rust backend clippy with `-D warnings`.
- `npm run test:backend`: Rust backend tests.
- `npm run check:frontend`: frontend typecheck and Vite build.
- `cargo build --manifest-path backend-rs/Cargo.toml`: required before Tauri dev can launch the debug sidecar.
- `npm run tauri dev`: full desktop app in development.

## Important Docs

- `AI_RULES.md`: detailed engineering rules for AI agents.
- `docs/PROJECT_CONTEXT.md`: complete context map and fragile areas.
- `docs/architecture.md`: current architecture and risk analysis.
- `docs/SECURITY_RULES.md`: security model and review findings.
- `docs/TESTING.md`: current automated validation and gaps.
