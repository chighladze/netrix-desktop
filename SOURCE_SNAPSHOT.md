# Netrix 0.3.0-beta.11 source

Both Windows x64 installers were built from commit `d25ccab7b700cad22b3c29b1be8e83ad4856a46f`. The release metadata identifies Lightweight as the primary download. [Release metadata](https://github.com/chighladze/netrix-releases/releases/download/v0.3.0-beta.11/release.json).

| Installer | Bytes | SHA-256 |
| --- | ---: | --- |
| `Netrix_0.3.0-beta.11_x64-lightweight-setup.exe` | 9,339,797 | `2a91e59ad8d4005fb7875f5c1cc90c8a2b5ec11caaa2fcdf42c52b925fb7ba72` |
| `Netrix_0.3.0-beta.11_x64-offline-full-setup.exe` | 225,462,504 | `4a85a79936a837986d42cfbe97f7d55bc7ff535e3a38878ed321f01a55d1eb98` |

The complete `backend-rs/`, `frontend/` and `src-tauri/` trees and the root npm manifest and lockfile match the build source. The public repository maintains its own development guides and Windows CI. Its history begins with the [beta.8 source snapshot](https://github.com/chighladze/netrix-desktop/tree/v0.3.0-beta.8).

Build both installers using the [Windows build guide](docs/build_instructions.md). The [Windows release](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.11) lists download links and the results for existing, online and offline WebView2 installations.

The public source workflow scans with Gitleaks 8.30.1. Its fixture-specific
exceptions cover upstream russh test keys, the RFC 6455 example WebSocket nonce
and a static JWT decoder example. The exceptions are listed in
[`.gitleaksignore`](.gitleaksignore).
