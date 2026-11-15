---
name: vault-auth-security
description: 'Use when: changing Netrix vault, authentication, API tokens, saved credentials, keychain unlock, host key verification, CORS, CSP, or Tauri security permissions.'
---

# Vault, Auth, and Security

## Purpose

Guide security-sensitive changes in Netrix.

## Rules

- Saved credentials must use the vault and must not appear in host API responses.
- Whole-database encryption uses a random SQLCipher key wrapped by the master password. The startup gate must require explicit entry before publishing any workspace router. Coordinate vault password changes with the database key envelope; never remove the workspace verifier during credential reset. Preserve the encrypted recovery set and test both interrupted password-rotation commit windows. Do not store an unwrapped database key or silently regenerate a missing/corrupt key file.
- Application lock is backend-owned (`AppState.security`) and distinct from vault-only lock. Keep every protected window inside `AppSecurityBoundary`; never reintroduce a keychain/reset shortcut on its lock screen. Lock events are hints to fetch status, not trusted state. Vault mutation handlers serialize with application lock transitions. Do not restore plaintext-secret GET responses.
- API token transport stays stdin from Tauri to backend, IPC to frontend, header/subprotocol to backend.
- Backend stays on `127.0.0.1`.
- Host key verification defaults to strict TOFU.
- Update `docs/SECURITY_RULES.md` for any security posture change.

## Architecture Guidance

- `vault.rs` derives keys with Argon2id and encrypts with AES-256-GCM.
- `routers/vault.rs` exposes unlock, lock, reset, status, password rotation, and item APIs.
- Remembered-password IPC is in `features/vault/keychain.ts` and `src-tauri/src/vault_keychain.rs`, using fixed-purpose main-window commands and Windows-native `keyring`. Do not reintroduce the former keychain plugin, whose desktop implementation had no invoke handlers. Other platforms must fail explicitly, never use a mock/plaintext fallback.
- The manual-startup policy precedes remembering. Native save/remove failure must not become false success; keep passwords transient and regression-test late saves after remembering is disabled.
- CORS and body limits are configured in `backend-rs/src/main.rs`.

## Coding Standards

- Use constant-time comparisons for tokens or derived key comparisons.
- Zero key material when locking or replacing it.
- Avoid logging secrets or decrypted plaintext.
- Keep destructive actions confirmation-protected.

## Anti-Patterns

- Storing vault passwords in localStorage.
- Passing secrets as process args.
- Disabling host key checks silently.
- Widening CORS to arbitrary origins.
- Adding broad Tauri permissions without review.

## Example

To change vault status fields, update `routers/vault.rs`, frontend `VaultStatus`, settings/lock-screen UI, tests in `api_tests.rs`, and security docs.

## Key and identity lifetime

Run Argon2 in the bounded blocking pool and keep temporary passwords/keys in Zeroizing containers. Identity-file read, validation and durable-write failures must propagate at startup. Never replace a corrupt salt or generate a fresh salt beside an existing database. Raw database copies require the matching installation salt; portable logical backups instead decrypt under the source vault and re-encrypt under the destination vault after archive authentication.

Managed credentials reuse vault items; return public metadata only and preserve managed entries during automatic orphan cleanup. Shared replacement and binding must remain transactional. Restore requires RESTORE BACKUP, an exclusive workspace lease, empty terminal/tunnel registries, schema/host/foreign-key validation and atomic rollback. Clear ephemeral quick-connect tickets after successful replacement. Never auto-start imported tunnel rules or transfer server trust implicitly.

Saved-host runtime connections must use `ssh::saved_host::load_credentials`; do not add another permissive JSON loader. Stop new connections on locked, missing, malformed or undecryptable linked credentials and on unsupported jump routes. Never include serde errors or decrypted values in user-facing errors. Terminal reattach after preparation failure must use `resume_live`, which cannot open a new socket.
