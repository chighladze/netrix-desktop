# Build Netrix on Windows

This repository supports local development and builds the Lightweight and Offline
Full installers and the Portable ZIP for Windows x64.
macOS and Linux packaging are not currently maintained release targets.

## Prerequisites

- Git and Node.js **24.x** with npm (use the latest 24.x patch).
- Rust stable via [rustup](https://rustup.rs), using `stable-x86_64-pc-windows-msvc`.
- Microsoft C++ Build Tools with **Desktop development with C++**, MSVC and a Windows SDK.
- Microsoft Edge WebView2 Runtime for running the desktop webview.
- PowerShell 7 (`pwsh`) for installer hashing and the extended release scripts.

Follow [Tauri's official Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
when installing these tools. Restart the terminal after changing PATH. The
native dependencies also use CMake, available with the C++ build tools; the GitHub
Windows runner supplies it. The pinned SQLCipher adapter does not require a
separate OpenSSL DLL or Perl installation.

## Clone and run

```powershell
git clone https://github.com/chighladze/netrix-desktop.git
cd netrix-desktop
npm ci --engine-strict
npm ci --engine-strict --prefix frontend
npm run build:sidecar:debug
npm run tauri dev
```

`build:sidecar:debug` compiles the Rust backend and stages its platform-specific
binary for Tauri. `tauri dev` starts the Vite frontend and the native app. Running
the frontend alone does not provide desktop IPC or a backend workspace.

To reproduce a released version, check out its public tag before installing dependencies.
For beta.13, use `git switch --detach v0.3.0-beta.13`.

Use a disposable development workspace. An unmodified development build uses the
same application identifier as official Netrix. See [CUSTOMIZATION.md](CUSTOMIZATION.md)
before testing a fork against valuable data.

## Build the Windows installers

```powershell
npm run build:windows:installers
npm run check:windows:binaries
```

Tauri builds the frontend, shell and statically linked backend once. Find both
installers and their SHA-256 manifest in `src-tauri/target/release/bundle/windows-installers/<version>/`.
Lightweight downloads WebView2 from Microsoft only if it is missing. Offline Full
includes the runtime for disconnected PCs. Use `npm run build` to build just Lightweight.

## Build the Portable ZIP

After building the installers, package their release binaries with this command.

```powershell
./scripts/build-windows-portable.ps1 -Tag v0.3.0-beta.13 -OutputDirectory release-artifacts
```

To build only Portable, first run `npm run tauri -- build --no-bundle` to build
the release binaries. Extract the ZIP into a writable folder on a Windows x64 PC
with WebView2 Evergreen. Launch `Netrix.exe` there. To move the workspace, close
Netrix and copy the whole folder, including `Data` and `Netrix.portable`. Unlock
it on the other PC with the original master password.

## Checks

```powershell
npm run check:fmt
npm run check
npm run build:sidecar:debug
npm run check:tauri
npm run test:tauri
```

The extended `npm run release:check` also needs `cargo-audit` and NSIS packaging
tools. It includes binary-dependency checks and installer-hook fixtures. Review
manual installation, upgrade and runtime behavior before distributing a custom
installer. Keep the original workspace and an encrypted backup intact.

## Verify an installed build

Record the exact EXE's SHA-256 with `Get-FileHash -Algorithm SHA256`. Install into a
disposable Windows profile, open and unlock Netrix, save a test host, and confirm
that it survives a restart. For a beta.13 upgrade, create a host and Vault item in
beta.12, close the app, install Lightweight and reopen the same workspace and
Vault with the original password.

The [sidecar lifecycle checks](TESTING.md#sidecar-lifecycle) cover immediate restart
when Windows denies Job Object assignment. To verify offline WebView2 recovery,
start with a disposable VM where the runtime is absent and disconnect the network
before installing. Record the Windows edition, runtime version and observed result.
The release notes record which Windows installations and Portable transfers were
verified. [Windows beta.13](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.13)

## GitHub Actions

The `Windows checks and optional installer` workflow checks every push to `main`
and every pull request. Fork owners can run it manually with `build_installer`
enabled to produce both unsigned EXEs and their checksum manifest as an Actions
artifact. Fork owners can run this workflow using the public code and their
repository's Actions permissions.

## Troubleshooting

- Missing sidecar: run `npm run build:sidecar:debug` before `npm run tauri dev`.
- Missing compiler/SDK: install the Windows C++ workload and reopen PowerShell.
- Missing WebView2: install the official Microsoft Evergreen x64 runtime.
- Keep Windows protection enabled. Report its precise blocking message.
- Preserve lockfiles; use `npm ci` rather than changing versions to fix setup errors.
