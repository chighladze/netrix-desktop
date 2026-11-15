# User Guide

This guide covers the current Netrix desktop workflow.

## 1. First Launch and Credential Vault

Netrix is a local-first desktop application and does not require an account or
online registration. On a clean installation, a Welcome Guide explains the
workspace and lets you create the local Credential Vault immediately, before
saving passwords or private keys. You do not need to find Security settings
during initial setup.

1. Enter and confirm a master password with at least 10 characters.
2. Store the password somewhere safe. Netrix cannot recover it through an
   account or an online service.
3. Select **Create & Unlock Vault**. The Vault remains unlocked in backend memory for
   the current session, until manual/automatic lock, or until Netrix exits.

The unlocked Vault is required to save and use stored SSH/SFTP passwords,
private keys, and passphrases. Quick Connect, Local/Serial connections, host
profiles without saved secrets, maps, and network utilities remain available
without saved Vault credentials.

When an initialized Vault is locked, Netrix displays a persistent notice. Select
**Unlock Vault** to enter the master password in a focused dialog; the current
workspace stays open and Netrix does not redirect you to Settings.

When **Remember Vault Password** is enabled, Netrix asks the operating system
keychain to store the password on that device. Otherwise, unlock the Vault again
after restarting the app. If the password is forgotten, the only recovery path
is **Reset Vault**: encrypted secrets are deleted and detached from their hosts,
while the non-secret host profiles remain.

## 2. Create or Open a Host

Use the Hosts view to create saved connection profiles:

- SSH
- Telnet
- Serial

Each host can store terminal theme/font overrides and optional credentials.

## 3. Quick Connect

Quick Connect creates an ephemeral terminal tab without saving a host profile.
It supports the same currently implemented protocols and opens immediately in a
new terminal tab.

## 4. Work with Terminal Tabs

Terminal tabs support:

- Multiple concurrent sessions.
- Drag-and-drop tab reordering.
- Detach/reattach between windows.
- Per-tab connection status.

## 5. Use Terminal Tools

Inside terminal sessions you can use:

- Quick action buttons.
- Snippet execution.
- Search in terminal buffer.
- Keyword highlighting.

## 6. Vault Operations

Vault actions are available via backend API and UI flows:

- Unlock with master password.
- Unlock with a saved OS keychain password when the remember option is enabled.
- Store and retrieve encrypted secrets.
- See when a host already has a vault-linked credential, replace it by entering
  a new password/key, or remove the saved credential while keeping the host.
- Save encrypted SSH private keys with an optional key passphrase.
- Lock manually or via auto-lock settings.
- Reset a forgotten Vault password from the lock screen. This is destructive:
  it removes saved secrets and detaches credential links from host profiles.

If the vault is locked when connecting to a host with stored credentials,
Netrix prompts to unlock and reconnect.

## 7. Network Map and Utilities

The app includes:

- Visual network map sheets (nodes/edges).
- TCP scan utility.
- TLS inspection utility.

Use these only in authorized environments.

## 8. Files and SFTP

The Files view is available for SSH hosts. Netrix opens SFTP only when you open
Files, browse a folder, or click Recheck. Normal terminal connections do not run
SFTP checks.

When SFTP is available, Files shows a directory browser with folders, files,
sizes, modified times, permissions, breadcrumbs, refresh, parent-folder
navigation, upload, and Terminal actions. Click a row to select it, then use the
visible action buttons; double-click a folder to open it.

Select a file to show View and Download actions. View opens a text preview for
small text files; binary files should be downloaded and opened locally. Download
shows transfer progress and prompts for a destination when the runtime supports
the native save picker, otherwise it falls back to the browser download flow.

Use Upload or drag files onto the Files view to send local files to the current
remote directory. Uploads run in the foreground and show a progress line.

SFTP states:

- Not checked: Netrix has not probed this host yet.
- Checking: Netrix is opening a separate SSH SFTP subsystem connection.
- Available: the remote SSH server accepted the SFTP subsystem and browsing can
  continue.
- Not available: the device does not expose SFTP. Terminal access still works.
- Auth issue: credentials or vault unlock state need attention.

Telnet and Serial hosts do not show Files actions. This avoids noisy failures on
network devices that provide terminal access but no SFTP subsystem.

Rename, delete, and resumable background transfer queue actions are not yet
enabled.

## 9. Recent Connections and Host Groups

- Recent connections are tracked for quick reopening.
- Hosts can be grouped and reorganized.

## 10. Settings

Settings include:

- Terminal rendering options.
- Connection defaults.
- Keyboard behavior.
- Window behavior.
- Security options (auto lock, vault behavior).

## 11. Help and Getting Started

Select **Help & Getting Started** near the bottom of the navigation rail to
reopen the guide. It explains the Vault states, the normal three-step workflow,
and links directly to Hosts, Terminal, Files, Network Map, Snippets, and Tool
Box.

## 12. Troubleshooting

- If a tab fails to connect, check host reachability and credentials.
- If credentials are vault-backed, verify vault unlock state.
- If backend is unreachable, restart the app and ensure sidecar startup
  succeeds.
- If Files reports that SFTP is not available, continue using Terminal. Many
  network devices support SSH shell but do not implement the SFTP subsystem.
- If Files shows an auth issue, check saved credentials and vault unlock state.
