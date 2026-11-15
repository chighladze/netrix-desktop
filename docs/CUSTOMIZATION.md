# Customize Netrix

For ordinary use, start with the application's Settings, terminal themes,
keyword highlighting, snippets, Quick Actions and host groups. Editing code is
optional. To change behavior or interface layout, fork this repository and follow
[the build guide](build_instructions.md).

## Find the owning code

| Change | Starting point |
| --- | --- |
| Application layout and navigation | `frontend/src/App.tsx`, `frontend/src/components/` |
| Themes and terminal rendering | `frontend/src/components/Settings.tsx`, `frontend/src/components/TerminalCanvas.tsx` |
| Shared frontend state | `frontend/src/state/store.ts` |
| API access | `frontend/src/api.ts` |
| SSH, Telnet, Serial and SFTP | `backend-rs/src/ssh/`, `backend-rs/src/routers/` |
| Database and vault | `backend-rs/src/db.rs`, `backend-rs/src/vault.rs` |
| Native windows and sidecar lifecycle | `src-tauri/src/main.rs` |
| Packaging, icon and application identifier | `src-tauri/tauri.conf.json`, `src-tauri/icons/` |

Read the nearest implementation and tests, make one focused change, then run
`npm run check`. Changes to Tauri additionally need `npm run check:tauri` and
`npm run test:tauri` after staging the debug sidecar.

## Keep a fork's data separate

The stock app identifier is `com.netrix.app`. Its source build can share the
official app's workspace. For an independent fork, choose your own product name
and unique identifier in `src-tauri/tauri.conf.json`, then review native data-path
and legacy-migration behavior before running it. A fresh Windows user or a VM is
the simplest isolated place to test. Preserve an encrypted backup and its password.

Do not weaken token authentication, localhost binding, encryption, SSH host-key
checks or Tauri capabilities to simplify a customization. The architecture and
security boundaries are documented in [architecture.md](architecture.md) and
[SECURITY_RULES.md](SECURITY_RULES.md).

## Share a change

Open a pull request with an explanation, relevant tests and screenshots when the
interface changes. Use the public [bug/feature forms](https://github.com/chighladze/netrix-releases/issues/new/choose)
for reports. When distributing a fork, clearly identify it as your build, preserve
license notices and describe its actual signing and testing status.
