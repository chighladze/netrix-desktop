# Netrix 0.3.0-beta.13 source

The three Windows x64 downloads were built from commit `263bb26ce031c69fddcf0d729cfd6209b1839f21`. Lightweight is the primary installer. [Release metadata](https://github.com/chighladze/netrix-releases/releases/download/v0.3.0-beta.13/release.json).

| Windows x64 download | Bytes | SHA-256 |
| --- | ---: | --- |
| Lightweight | 9,350,018 | `3f157c37fb625da6cff03db17519d69c50946575a067682aba4ebfbf66b6a2b6` |
| Offline Full | 305,518,698 | `7f5650b0bf3ec203a227cc293fcc0502a6052e84b8c632dd71b97b21c26fb56b` |
| Portable ZIP | 9,956,736 | `0addcc441992d8e4a580a39eb8f8c119021f7d44839a672019b05987fa0a2ff2` |

The complete `backend-rs/`, `frontend/` and `src-tauri/` trees and the root npm manifest and lockfile match the build source. The public repository maintains its own development guides and Windows CI. Its history begins with the [beta.8 source snapshot](https://github.com/chighladze/netrix-desktop/tree/v0.3.0-beta.8).

The [Windows build guide](docs/build_instructions.md) covers both installers and the Portable ZIP. The [Windows release](https://github.com/chighladze/netrix-releases/releases/tag/v0.3.0-beta.13) records the upgrade, offline installation and two-machine transfer checks.

The public source workflow scans with Gitleaks 8.30.1. Its fixture-specific
exceptions cover upstream russh test keys, the RFC 6455 example WebSocket nonce
and a static JWT decoder example. The exceptions are listed in
[`.gitleaksignore`](.gitleaksignore).
