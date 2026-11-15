# Vault Test Plan

Use this runbook before a production release when `routers/vault.rs`,
`vault.rs`, host credential storage, vault settings, OS keychain behavior, or
terminal/SFTP credential loading changes.

## Test Setup

- Build and run the desktop app with `npm run tauri dev` or test the latest
  release installer.
- Use a disposable app data profile or a test machine so reset scenarios do not
  delete real credentials.
- Prepare one reachable SSH host with valid credentials.
- Prepare one saved host credential through the normal New Host/Edit Host flow.
- Use a disposable Windows account/test machine with Windows Credential Manager for manual remembered-password checks. A separate app-data directory alone does not isolate the fixed production credential-store entry. Automated native tests use a unique entry instead.

## Automated Coverage

Backend tests cover these Vault invariants:

- Fresh vault status reports uninitialized before first unlock.
- First unlock rejects a master password shorter than 10 characters.
- First unlock bootstraps the vault check item.
- Repeated wrong passwords are rate-limited.
- Lock drops in-memory key access and blocks secret create/read until re-unlock.
- Saved host credentials are stored in `vault_items`, not plaintext host columns.
- Host API responses expose credential flags, not password/private key/passphrase.
- Saved host credentials decrypt again after lock and re-unlock.
- Reset requires the exact confirmation phrase.
- Reset deletes vault items and detaches hosts from credential IDs.
- Vault status reports secret and linked-host counts.
- Change password re-encrypts secrets, rejects the old password, and accepts the
  new password.

Run:

```powershell
npm run test:backend
```

## Manual Matrix

| Scenario | Steps | Expected result |
| --- | --- | --- |
| Fresh vault init | Start with empty app data, open Settings or side vault prompt, enter a new master password. | Vault initializes, becomes unlocked, status/counts update without errors. |
| Unlock | Restart or lock the app, then unlock with the correct master password. | Vault opens and saved credential workflows become available. |
| Wrong password rate limit | Enter the wrong master password repeatedly. | Attempts fail with an auth message and eventually show rate-limit feedback. |
| Lock vault | Click Lock Vault or wait for auto-lock if enabled. | Vault state changes to locked and stored credentials require unlock before use. |
| Saved host credential after unlock | Save an SSH host with credentials, lock vault, unlock again, then connect. | Terminal connects using stored credentials; host form/list never displays plaintext secrets. |
| New connection while locked | Save a host with credentials, lock Vault and try a new terminal, SFTP operation, snippet run and tunnel start. | Each reports locked Vault before contacting the destination. An idle SFTP transport does not bypass this check. |
| Reattach while locked | Establish SSH, detach, lock Vault, then reattach by session ID. | The same transport resumes and accepts input. After it ends, a new connection requires unlock. |
| Broken credential link | In isolated test data, damage a linked encrypted item or its credential JSON. | All connection paths report repair/replace guidance without exposing values or falling back to empty authentication. |
| Reset vault | Type `RESET VAULT` in the reset flow. | Vault locks, secrets are deleted, hosts remain but no longer show stored credential flags. |
| Change vault password | Unlock, change master password, lock, try old password, then try new password. | Old password fails, new password unlocks, saved host credentials still work. |
| Remembered password enabled | Select session unlock mode, enable Remember Vault Password, unlock, restart the app on Windows. | Windows Credential Manager holds the password; an existing Vault unlocks automatically. Enabling alone takes effect after the next successful unlock. |
| Password required at startup | Keep remembering enabled, select Require on each app start, restart. | Vault stays locked and saved-password shortcuts are unavailable. Manual master password is required. |
| Native storage failure | In a controlled test, reject credential-store save/read/remove. | Vault unlock/password change remains correctly reported; remembering/removal failure is visible and no false success flag or plaintext fallback appears. |
| Remembered password disabled | Disable Remember Vault Password, restart, and try Use Saved. | OS keychain entry is removed or ignored; app requires manual master password. |
| Reset clears remembered password | Enable remembered password, reset vault, restart. | Saved keychain password is cleared/ignored and no auto-unlock occurs. |

## Release Definition Of Done

- Run the manual matrix on the primary release OS.
- If shipping all platforms, repeat remembered-password checks on each OS.
- Remembering is currently implemented for Windows only; macOS/Linux must not be advertised as supported until their native backends and checks are implemented.
- No plaintext password/private key/passphrase appears in host API responses,
  logs, localStorage, or debug dumps.
- No saved credential is usable while the vault is locked.
- Saved host credentials still connect after lock/unlock and password rotation.
- Vault reset leaves no linked host credentials or remembered password path.
- `npm run check` passes after the test build.
- `npm run check:tauri` passes after the test build.
