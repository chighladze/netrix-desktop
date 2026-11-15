# Deployment and Packaging

## Encrypted database upgrade

The backend statically builds SQLCipher 4.20.0 / SQLite 3.54.1 from the pinned
`sqlcipher-src` crate using the local `backend-rs/vendor/libsqlite3-sys` ABI adapter.
The existing C/C++ toolchain is required; no external SQLCipher/OpenSSL DLL, Perl
or database server is needed. Build and ship the updated frontend and backend
together. Ordinary SQLite cannot open the new storage format.

Close other Netrix instances before first launch. The password gate uses the
existing vault master password and performs the verified conversion only after
entry. For a workspace without a vault password it asks to create and confirm one.
Keep the resulting `encryption-backup-<uuid>` directory and its historical password.
The backup includes the encrypted database, `.database-key` and `.vault_salt`.
Never roll back to an old backend against the converted working file; restore a
complete recovery set with an encryption-capable build or use a portable archive.
Missing or damaged key material requires restoration, not deletion/reinitialization.

Tauri treats `.database-key` and the database/journal/salt files as one identity
set during legacy app-data directory migration. No new Tauri capability or IPC
permission is required by database encryption.

Netrix is packaged as a Tauri desktop app with a bundled Rust backend sidecar.

## Development Run

```bash
cargo build --manifest-path backend-rs/Cargo.toml
npm run tauri dev
```

In development, Tauri starts the debug backend binary from `backend-rs/target/debug/netrix_backend.exe` on Windows. The frontend dev server runs through `npm run dev --prefix frontend` on port 3000.

## Production Build

```bash
npm run tauri build
```

The Tauri config runs:

```bash
npm run build --prefix frontend
cargo build --release --manifest-path backend-rs/Cargo.toml
node scripts/prepare-sidecar.mjs release
```

`scripts/prepare-sidecar.mjs` detects the Rust target triple, copies `backend-rs/target/<profile>/netrix_backend(.exe)` into `src-tauri/binaries/` as `netrix_backend-<target-triple>(.exe)`, and Tauri bundles it through `externalBin`.

## Application Icons

The original Netrix artwork is preserved in `frontend/public/icon.png`, with its existing favicon and packaged icons in `src-tauri/icons/`. The sidebar displays the original mark at 44px without an extra padded frame; the About view uses it at 96px. Presentation changes should not replace the artwork. Packaged/window icons take effect after rebuilding the desktop executable.

## Release Check

Keep the root/frontend package manifests, both Cargo package versions, Tauri
configuration and their lockfiles synchronized. The sidebar and About dialog
read the frontend package version at build time. Update `CHANGELOG.md` and the
README badge, then verify consistency with
`powershell -File scripts/check-release-version.ps1 -Tag v0.3.0`.

Before publishing a release artifact, run:

```bash
npm run release:check
```

This runs Rust formatting checks, backend/frontend validation, Tauri compile checks, production packaging, installer hash generation, frontend production dependency audit, the backend Rust audit, and a no-ignore Windows-target audit of the Tauri dependency tree.

To regenerate installer hashes after a build:

```bash
npm run hash:installers
```

The release configuration builds one publishable NSIS `.exe`. Its hash is written to `src-tauri/target/release/bundle/installer-hashes.sha256`; the hash script fails unless exactly one NSIS installer is present.

### WebView2 prerequisite

Windows packaging uses `bundle.windows.webviewInstallMode.type = offlineInstaller`.
Tauri embeds Microsoft's complete Evergreen WebView2 installer and invokes it
when the runtime is missing. The packaging machine needs network access to obtain
the Microsoft payload; the destination computer does not need a separate runtime
download. Evergreen retains Microsoft's normal runtime updates. Expect a much
larger EXE than the approximately 9 MB beta.4 package; record the actual built size.

Beta.4 used `embedBootstrapper`, which bundles only the small downloader and still
requires internet during runtime installation. An owner report from another PC
showed a missing-runtime launch error. The screenshot alone does not distinguish
download failure, a damaged runtime, a stale registration or a user-scope issue.
The offline package removes the download dependency; it does not bypass Windows
policy or establish successful installation on that PC without a new runtime test.
See [the public build guide](build_instructions.md) for recovery and QA.
The isolated packaging check on 2026-11-13 produced a 225,465,558-byte EXE and
verified the embedded Microsoft installer's signature; no missing-runtime install
was exercised. See [the published release notes](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.8). Distribution behavior is described
in [Tauri's packaging documentation](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)
and [Microsoft's runtime guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

## Public GitHub build workflow

The public repository runs `.github/workflows/windows.yml` on pushes and pull
requests. It checks the source on Windows and the frontend on Node 24.0.0/24.
Run it manually with `build_installer` enabled to retain an unsigned installer
artifact. It does not publish releases or require private-repository credentials.
See [the build guide](build_instructions.md) and [source snapshot](../SOURCE_SNAPSHOT.md).

## Runtime Configuration

- Backend port is random per app start.
- API token is random per app start.
- Backend process receives port and parent PID as args, and token through stdin.
- Tauri reports sidecar state through `get_backend_status`: `starting`, `ready`, or `failed`. It reports `ready` only after an authenticated `GET /health` returns HTTP 200. Frontend startup waits for `ready` and surfaces the safe `message` when startup reaches `failed`.
- Backend exits when Tauri exits.
- Windows production uses `windows_subsystem = "windows"`, so shell errors are also written to `%APPDATA%/com.netrix.app/tauri_main.log`.
- On upgrade, Tauri migrates legacy `%APPDATA%/Netrix` entries into `%APPDATA%/com.netrix.app` before starting the backend. Destination files are never overwritten. If a SQLite/WAL, Vault identity, or known-host conflict exists, the entire legacy data set remains unchanged to avoid mixing coupled files; the conflict is logged for manual recovery.

## Artifacts

- Backend debug binary: `backend-rs/target/debug/netrix_backend(.exe)`.
- Backend release binary: `backend-rs/target/release/netrix_backend(.exe)`.
- Prepared sidecar: `src-tauri/binaries/netrix_backend-<target-triple>(.exe)`.
- Tauri NSIS output: `src-tauri/target/release/bundle/nsis/*.exe`.
- Installer hashes: `src-tauri/target/release/bundle/installer-hashes.sha256`.

## Installer Runtime Validation

Before publishing a Windows installer, follow `docs/INSTALLER_RUNTIME_TEST_PLAN.md`. It covers clean-profile install, launch, backend sidecar startup, SSH connection, restart persistence, uninstall/reinstall behavior, clean reinstall behavior, and installer SHA256 verification.

Before every release, record the actual manual QA result in `docs/RELEASE_QA.md`.
For public beta releases, the required manual pass/fail gate is summarized in
`docs/BETA_READINESS.md`.

## CI Coverage

Current pull-request CI checks Rust formatting for backend and Tauri, backend compile, backend clippy with warnings denied, backend tests, frontend unit tests/typecheck/build, a dedicated Windows `cargo check`, and a real Tauri/Edge WebDriver startup smoke test. The tag workflow runs full npm and Rust dependency audits through `release:check`, packages the NSIS installer, signs stable releases, and optionally creates a public-repository draft. CI still does not install and uninstall the generated NSIS package; exact-installer runtime QA remains a publication gate.

## Deployment Risks

- Packaging depends on the sidecar name matching Tauri `externalBin` expectations.
- Frontend production build uses manual vendor chunks for React, Tauri APIs, icons, xterm, and other vendor code.
- Prerelease NSIS installers may be unsigned for tester distribution; stable publishing requires a valid Authenticode signature.
- Linux and macOS packaging are roadmap items, not validated in the current CI.
- Tauri CSP still allows inline styles, and desktop permissions should be reviewed before distributing beyond trusted users.
