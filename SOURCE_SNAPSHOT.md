# Netrix 0.3.0-beta.10 source

The public source tag `v0.3.0-beta.10` contains the application code used to build
the official Windows x64 installer. The build recorded the following identifiers
in the [published release.json](https://github.com/chighladze/netrix-releases/releases/download/v0.3.0-beta.10/release.json).

| Item | Value |
| --- | --- |
| Build source commit | `857c09342a4140a3810bd1dffaa784d9ec095959` |
| Installer | `Netrix_0.3.0-beta.10_x64-setup.exe` |
| Installer size | 225,462,519 bytes |
| Installer SHA-256 | `5d65301e7b6078a44dd036100a65ac30b14272d8cd7bf36796ba38e4dbf0b07b` |

The complete `backend-rs/`, `frontend/` and `src-tauri/` trees, root package manifest
and lockfile match the build source byte for byte. The public repository maintains
its own development guides, CI workflow and corresponding checks. Its history
starts with the [beta.8 snapshot](https://github.com/chighladze/netrix-desktop/tree/v0.3.0-beta.8).

To build this version, check out `v0.3.0-beta.10` and follow the
[Windows build guide](docs/build_instructions.md). To install the official build or
review the offline upgrade and first-host SSH config import checks, see
the [Windows release](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.10).

The public source workflow scans with Gitleaks 8.30.1. Its fixture-specific
exceptions cover upstream russh test keys, the RFC 6455 example WebSocket nonce
and a static JWT decoder example. The exceptions are listed in
[`.gitleaksignore`](.gitleaksignore).
