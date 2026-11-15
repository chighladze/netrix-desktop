# Security Policy

Netrix handles sensitive operational data, including host credentials, private
keys, and terminal output. Please report security issues responsibly.

## Reporting a Vulnerability

- Prefer GitHub private vulnerability reporting when it is available for this
  repository.
- If private reporting is unavailable, open a minimal public issue asking for a
  private maintainer contact. Do not include exploit details, credentials,
  private keys, logs, or host information in a public issue.
- Include the affected Netrix version or commit, operating system, impact, and a
  concise reproduction path when you can do so safely.

## Scope

Security-sensitive areas include:

- Backend authentication and localhost API exposure.
- WebSocket terminal/session handling.
- Vault encryption, unlock, reset, and keychain workflows.
- SSH host key verification and credential handling.
- Build, packaging, and update workflows.

For the current security model and known limitations, see
[docs/security.md](docs/security.md).