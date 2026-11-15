# Contributing to Netrix

Fork [netrix-desktop](https://github.com/chighladze/netrix-desktop), create a branch
and submit a focused pull request against `main`. The public repository contains
the complete application source for the published snapshot.

## Set up and validate

Follow [the Windows build guide](docs/build_instructions.md). Use Node.js 24 and
the committed lockfiles (`npm ci` in the root and frontend); Rust stable and the
Windows MSVC build tools are required.

```powershell
npm run check:fmt
npm run check
npm run build:sidecar:debug
npm run check:tauri
npm run test:tauri
```

Keep PRs small. Describe the problem, resulting behavior, tests and any remaining
manual checks. Include screenshots for visible interface changes. Do not commit
build output, local workspace data, logs, keys, credentials or environment files.

## Project boundaries

- The React frontend, Tauri shell and Rust backend have separate responsibilities.
- Backend HTTP uses authenticatedFetch; tokens belong in approved IPC/header channels.
- Keep localhost binding, vault encryption, SSH host verification and bounds on network tools.
- Add backend tests for changes to validation, vault, routers, migrations or session behavior.
- Register SQL migrations in `backend-rs/src/db.rs` and document permission changes.

See [AGENTS.md](AGENTS.md), [AI_RULES.md](AI_RULES.md) and
[the architecture](docs/architecture.md) for module ownership and conventions.

## Bugs, requests and vulnerabilities

Use the existing [bug and feature forms](https://github.com/chighladze/netrix-releases/issues/new/choose).
Code contributions belong in this repository's pull requests. Include a version,
reproduction steps and expected behavior. Remove personal data and credentials
from reports. Use [SECURITY.md](SECURITY.md) for vulnerabilities.

Contributions are distributed under the repository's [MIT license](LICENSE).
