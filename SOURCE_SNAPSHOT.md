# Netrix 0.3.0-beta.12 source

Both Windows x64 installers were built from commit `dbc875504a413202f911f49e05cfc77ca3309f91`. The release metadata identifies Lightweight as the primary download. [Release metadata](https://github.com/chighladze/netrix-releases/releases/download/v0.3.0-beta.12/release.json).

| Installer | Bytes | SHA-256 |
| --- | ---: | --- |
| `Netrix_0.3.0-beta.12_x64-lightweight-setup.exe` | 9,342,073 | `5b7cda0b88eacef3bbdeb32939606d7e4bf1738c6fe85bc3c81a0539c2e85180` |
| `Netrix_0.3.0-beta.12_x64-offline-full-setup.exe` | 225,467,274 | `5c055927c6b10e1bd6fc1f89eed344435537298064b0ac43a36b4bc0f4d100eb` |

The complete `backend-rs/`, `frontend/` and `src-tauri/` trees and the root npm manifest and lockfile match the build source. The public repository maintains its own development guides and Windows CI. Its history begins with the [beta.8 source snapshot](https://github.com/chighladze/netrix-desktop/tree/v0.3.0-beta.8).

Build both installers using the [Windows build guide](docs/build_instructions.md). The [Windows release](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.12) lists download links and the results for existing, online and offline WebView2 installations.

The public source workflow scans with Gitleaks 8.30.1. Its fixture-specific
exceptions cover upstream russh test keys, the RFC 6455 example WebSocket nonce
and a static JWT decoder example. The exceptions are listed in
[`.gitleaksignore`](.gitleaksignore).
