# Netrix

A free, MIT-licensed desktop workspace for SSH, Telnet, Serial and SFTP.
Keep connections, terminals, files, snippets and network maps on your computer.

[![Netrix demo preview showing side-by-side terminal sessions](https://netrix-console.com/media/terminaltrove/netrix-preview.gif)](https://netrix-console.com/media/terminaltrove/netrix-preview.mp4)

[Watch the full 24-second demo](https://netrix-console.com/media/terminaltrove/netrix-preview.mp4) · [Website](https://netrix-console.com) · [Download for Windows](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.10) · [Build from source](docs/build_instructions.md) · [Customize Netrix](docs/CUSTOMIZATION.md) · [Report a bug](https://github.com/chighladze/netrix-releases/issues/new?template=bug-report.yml)

![Windows checks](https://github.com/chighladze/netrix-desktop/actions/workflows/windows.yml/badge.svg)

## Install and run

1. Open the [Windows release](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.10).
2. Download **Netrix_0.3.0-beta.10_x64-setup.exe** from Assets, run the installer, then open Netrix.
3. Create a local workspace and keep its master password safe. On **Add your first host**, select **Import SSH config** to preview your OpenSSH aliases and choose the hosts to save, or select **New Host** to enter one manually.

The installer is unsigned and includes WebView2. A standard user installed beta.10
over beta.9 in an offline Windows 10 LTSC x64 VM with WebView2 already installed.
The imported host remained available after restarting and unlocking Netrix.

**Source code ZIP/TAR files are for developers.** They contain this repository's
application code and must be built. To install the ready-made app, choose the EXE
in the separate [installer releases](https://github.com/chighladze/netrix-releases/releases).

## Build your own version

Development and packaging currently target Windows x64. Install Git, Node.js 24,
Rust stable with the MSVC toolchain, Microsoft C++ Build Tools and WebView2.
See the [complete setup guide](docs/build_instructions.md) for prerequisites.

```powershell
git clone https://github.com/chighladze/netrix-desktop.git
cd netrix-desktop
npm ci --engine-strict
npm ci --engine-strict --prefix frontend
npm run build:sidecar:debug
npm run tauri dev
```

Create an unsigned local Windows installer with `npm run build`.
It appears in `src-tauri/target/release/bundle/nsis/`.
Building can download Rust/npm dependencies, Tauri packaging tools and Microsoft's
WebView2 installer. This repository does not require a Netrix account or private
repository credentials.

## Make it yours

Fork this repository, create a branch, and change the application:

| Area | Start here |
| --- | --- |
| Interface, layouts, appearance | `frontend/src/` |
| Hosts, SSH/SFTP, vault and network tools | `backend-rs/src/` |
| Native windows, permissions and packaging | `src-tauri/` |
| Architecture and data model | `docs/architecture.md`, `docs/DATABASE_STRUCTURE.md` |

The [customization guide](docs/CUSTOMIZATION.md) explains the extension points and
how to keep a fork's workspace separate. Preserve localhost authentication, vault
encryption and SSH host verification when extending the app.

## Contribute

Pull requests are welcome here. Follow [CONTRIBUTING.md](CONTRIBUTING.md) and run
`npm run check` before proposing a change. Public bug reports and feature requests
stay in [netrix-releases/issues](https://github.com/chighladze/netrix-releases/issues),
so existing reports and installer links remain in one place. Never include
credentials, private keys or workspace databases in public reports.

GitHub Actions checks the Windows source on pushes and pull requests. From the
**Actions → Windows checks and optional installer → Run workflow** menu, the
maintainer of a fork can also build an unsigned installer artifact. This does not
publish an official release or provide a publisher signature.

## Version and license

The public tag `v0.3.0-beta.10` contains the application source, assets and
lockfiles used to build the Windows installer. The public build guides and CI
live alongside them. [Source and installer provenance](SOURCE_SNAPSHOT.md).

Netrix is licensed under [MIT](LICENSE). You may use, modify and redistribute it
under that license, retaining its notice. Third-party dependencies retain their
own licenses; vendored notices are preserved. Security reports follow
[SECURITY.md](SECURITY.md).
