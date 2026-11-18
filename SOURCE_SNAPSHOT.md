# Netrix 0.3.0-beta.9 source

The public source tag `v0.3.0-beta.9` contains the application code used to build
the official Windows x64 installer. The build recorded the following identifiers
in the [published release.json](https://github.com/chighladze/netrix-releases/releases/download/v0.3.0-beta.9/release.json).

| Item | Value |
| --- | --- |
| Build source commit | `edf4bdb3952f6330d86795744631c1a2d3551c15` |
| Installer | `Netrix_0.3.0-beta.9_x64-setup.exe` |
| Installer size | 225,459,245 bytes |
| Installer SHA-256 | `b70bfe67eac2eb336952465f41abc9bd0118c8c2495ef9614ab7757af8132b5c` |

The complete `backend-rs/`, `frontend/` and `src-tauri/` trees, root package manifest
and lockfile match the build source byte for byte. The public repository maintains
its own development guides, CI workflow and corresponding checks. Its history
starts with the [beta.8 snapshot](https://github.com/chighladze/netrix-desktop/tree/v0.3.0-beta.8).

To build this version, check out `v0.3.0-beta.9` and follow the
[Windows build guide](docs/build_instructions.md). To install the official build or
review its clean-profile, upgrade, offline WebView2 and crash-restart results, see
the [Windows release](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.9).

The public source workflow scans with Gitleaks 8.30.1. Its fixture-specific
exceptions cover upstream russh test keys, the RFC 6455 example WebSocket nonce
and a static JWT decoder example. The exceptions are listed in
[`.gitleaksignore`](.gitleaksignore).
