//! Local shell PTY transport.
//!
//! Spawns a process attached to a pseudo-terminal so that interactive
//! shells (powershell, pwsh, cmd, bash, zsh, fish, ...) behave the same
//! as in a real terminal emulator.
//!
//! Cross-platform via [`portable_pty`]:
//! - Windows: ConPTY (Windows 10 1809+).
//! - Unix:    `openpty` / `forkpty`.
//!
//! The PTY's read/write halves are blocking I/O. We bridge them to the
//! async world with:
//! - a dedicated OS thread that reads the PTY and forwards bytes through
//!   a bounded `tokio::mpsc::Sender<Vec<u8>>` with reader backpressure,
//! - a `tokio::sync::Mutex` around the boxed writer; writes go through
//!   `tokio::task::spawn_blocking`.
//!
//! The spawned process inherits the backend's user privileges. This is
//! intentional and matches MobaXterm / Windows Terminal behaviour. The
//! frontend is expected to surface a clear warning to the user.

use std::io::{Read, Write};
use std::sync::Arc;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tokio::sync::{mpsc, Mutex};
use tracing::warn;

/// All handles required to drive a live local shell PTY.
pub struct LocalPtySession {
    /// Blocking writer wrapped for async access. Use `spawn_blocking`.
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// PTY master — used for resize. `MasterPty::resize` is sync.
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Child process. `Child::kill` is sync.
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Output stream from the dedicated read thread.
    pub rx: mpsc::Receiver<Vec<u8>>,
}

/// Platform-appropriate default shell when the user did not configure one.
pub fn default_shell_command() -> String {
    #[cfg(windows)]
    {
        // `powershell.exe` ships with every supported Windows release. We
        // prefer it over `cmd.exe` because it gives nicer ANSI output.
        // `pwsh.exe` (PowerShell 7+) is preferred if present; ConPTY will
        // resolve via PATH, but to keep behaviour predictable we just pick
        // the legacy shell. The user can override per-host.
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }
}

/// Validate a configured command path. Rejects path-traversal and empty input.
fn validate_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Local shell command is empty".into());
    }
    if trimmed.contains("\0") {
        return Err("Local shell command contains a NUL byte".into());
    }
    // Path-traversal sniff: reject "../" anywhere.
    if trimmed.split(['/', '\\']).any(|seg| seg == "..") {
        return Err("Local shell command contains '..' path traversal".into());
    }
    Ok(())
}

/// Spawn a local shell PTY.
///
/// `args` are passed verbatim — no shell interpretation occurs.
/// `cwd` (if provided) must reference a valid directory; the OS will
/// surface an error at spawn time otherwise.
pub fn spawn(
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    cols: u16,
    rows: u16,
) -> Result<LocalPtySession, String> {
    validate_command(command)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(command);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = cwd {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            cmd.cwd(trimmed);
        }
    }
    // Provide TERM so interactive shells render colours correctly.
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn '{command}' failed: {e}"))?;

    // Important on Unix: drop the slave end so the master can detect EOF.
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone PTY reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take PTY writer failed: {e}"))?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>(32);

    // Dedicated OS thread — blocking PTY read → async channel.
    std::thread::Builder::new()
        .name("netrix-local-pty-reader".into())
        .spawn(move || {
            let mut buf = vec![0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.blocking_send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        warn!("[local-pty] read error: {e}");
                        break;
                    }
                }
            }
        })
        .map_err(|e| format!("spawn PTY reader thread failed: {e}"))?;

    Ok(LocalPtySession {
        writer: Arc::new(Mutex::new(writer)),
        master: Arc::new(Mutex::new(pair.master)),
        child: Arc::new(Mutex::new(child)),
        rx,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_empty() {
        assert!(validate_command("").is_err());
        assert!(validate_command("   ").is_err());
    }

    #[test]
    fn validate_rejects_traversal() {
        assert!(validate_command("../bin/sh").is_err());
        assert!(validate_command("..\\evil.exe").is_err());
        assert!(validate_command("/usr/bin/../bin/sh").is_err());
    }

    #[test]
    fn validate_accepts_normal_paths() {
        assert!(validate_command("/bin/bash").is_ok());
        assert!(validate_command("powershell.exe").is_ok());
        assert!(validate_command("C:\\Windows\\System32\\cmd.exe").is_ok());
    }

    #[test]
    fn default_shell_is_non_empty() {
        assert!(!default_shell_command().trim().is_empty());
    }
}
