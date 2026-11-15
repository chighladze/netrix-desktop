//! Only allowlisted startup codes cross IPC. Stderr may contain sensitive data
//! and is never copied into these user-visible diagnostics.
use serde::{Deserialize, Serialize};

const PREFIX: &str = "NETRIX_STARTUP_FAILURE:";
const RESTART: &str = "Close all Netrix windows and open Netrix again. If the problem continues, copy the diagnostic details for a bug report and review the local log.";

#[derive(Clone, Serialize)]
pub struct BackendDiagnostic {
    pub code: &'static str,
    pub message: &'static str,
    pub recovery: &'static str,
    pub details: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StartupCode {
    WorkspaceBusy,
    WorkspaceKeyMissing,
    WorkspaceDatabaseMissing,
    WorkspaceKeyInvalid,
    WorkspaceAccessDenied,
    DataDirectoryUnavailable,
    WorkspaceUnavailable,
    ListenerDenied,
    LocalPortInUse,
    ListenerUnavailable,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartupReport {
    code: StartupCode,
    os_error: Option<i32>,
}

impl StartupReport {
    pub fn from_line(line: &[u8]) -> Option<Self> {
        if line.len() > 256 {
            return None;
        }
        let text = std::str::from_utf8(line).ok()?.trim();
        serde_json::from_str(text.strip_prefix(PREFIX)?).ok()
    }

    fn description(&self) -> (&'static str, &'static str, &'static str) {
        match self.code {
            StartupCode::WorkspaceBusy => (
                "workspace_busy", "This workspace is already open in another Netrix process.",
                "Close the other Netrix instance, then close and reopen this one. Do not delete the workspace lock or database files.",
            ),
            StartupCode::WorkspaceKeyMissing => (
                "workspace_key_missing", "The encryption key file for this workspace is missing.",
                "Restore .database-key from the backup matching this workspace. Keep the existing database and other identity files; do not reset or delete them.",
            ),
            StartupCode::WorkspaceDatabaseMissing => (
                "workspace_database_missing", "The encrypted workspace database is missing.",
                "Restore the matching workspace backup, including its database and identity files. Keep the files that are still present.",
            ),
            StartupCode::WorkspaceKeyInvalid => (
                "workspace_key_invalid", "The workspace encryption key file is damaged or uses an unsupported format.",
                "Use a compatible Netrix version or restore the original key file from the matching backup. Do not delete or replace the database with an empty workspace.",
            ),
            StartupCode::WorkspaceAccessDenied => (
                "workspace_access_denied", "Netrix does not have permission to access its local workspace files.",
                "Check the data folder permissions and whether security software blocked Netrix, then close and reopen the app. Keep the workspace files intact.",
            ),
            StartupCode::DataDirectoryUnavailable => (
                "data_directory_unavailable", "Netrix could not initialize its local data folder or identity files.",
                "Check folder access, available disk space and the local log. Preserve existing workspace files before attempting recovery.",
            ),
            StartupCode::WorkspaceUnavailable => (
                "workspace_unavailable", "Netrix could not read the local workspace during startup.",
                "Review the local log for the underlying storage error. Preserve the database and identity files; do not reset the workspace to fix a startup error.",
            ),
            StartupCode::ListenerDenied => (
                "listener_denied", "The operating system denied Netrix's local connection listener.",
                "Check whether a device policy or security software blocked Netrix's loopback connection, then close and reopen the app.",
            ),
            StartupCode::LocalPortInUse => (
                "local_port_in_use", "Another process took the local port Netrix was about to use.",
                "Close and reopen Netrix so it can select a new local port.",
            ),
            StartupCode::ListenerUnavailable => (
                "listener_unavailable", "Netrix could not start its local connection listener.", RESTART,
            ),
        }
    }
}

pub fn terminated(
    code: Option<i32>,
    signal: Option<i32>,
    report: Option<&StartupReport>,
) -> BackendDiagnostic {
    let (reason, message, recovery) = if let Some(report) = report {
        report.description()
    } else {
        match code.map(|value| value as u32) {
            Some(0xC0000135) => (
                "missing_runtime_library", "Windows could not find a library required by the local Netrix service.",
                "Install the latest Netrix version. For older builds, install or repair Microsoft Visual C++ Redistributable x64, then close and reopen Netrix. Official download: https://aka.ms/vc14/vc_redist.x64.exe. This exit code does not identify the missing DLL.",
            ),
            Some(0xC000007B) => (
                "invalid_binary", "Windows rejected an application file or library because its format is invalid.",
                "Reinstall Netrix using the official Windows x64 installer. A damaged file or a library for a different architecture can cause this error.",
            ),
            Some(0xC0000142) => (
                "library_initialization_failed", "A library required by Netrix failed to initialize.",
                "Restart Windows and reinstall the latest Netrix version if the error continues. Review the local log and Windows application error details.",
            ),
            Some(0xC0000005 | 0xC0000409) => (
                "backend_crashed", "The local Netrix service crashed.", RESTART,
            ),
            _ => (
                "backend_exited", "The local Netrix service stopped. Its exit code alone does not identify the cause.", RESTART,
            ),
        }
    };
    let exit = code.map_or_else(
        || "unavailable".into(),
        |value| format!("{value} (0x{:08X})", value as u32),
    );
    let signal = signal.map_or_else(|| "none".into(), |value| value.to_string());
    let mut details = format!(
        "Netrix version: {}\nReason: {reason}\nBackend exit code: {exit}\nSignal: {signal}",
        env!("CARGO_PKG_VERSION")
    );
    if let Some(os_error) = report.and_then(|value| value.os_error) {
        details.push_str(&format!("\nOS error: {os_error}"));
    }
    BackendDiagnostic {
        code: reason,
        message,
        recovery,
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_dll_is_distinct_from_an_ordinary_exit_code() {
        let missing = terminated(Some(-1073741515), None, None);
        assert_eq!(missing.code, "missing_runtime_library");
        assert!(missing.details.contains("0xC0000135"));
        assert!(missing.recovery.contains("Visual C++ Redistributable x64"));
        let unknown = terminated(Some(1), None, None);
        assert_eq!(unknown.code, "backend_exited");
        assert!(!unknown.recovery.contains("Visual C++"));
        assert!(unknown.details.contains("1 (0x00000001)"));
    }

    #[test]
    fn preserves_the_reported_reason_when_the_process_exits_with_one() {
        let report = StartupReport::from_line(
            br#"NETRIX_STARTUP_FAILURE:{"code":"workspace_busy","os_error":32}"#,
        )
        .unwrap();
        let failure = terminated(Some(1), None, Some(&report));
        assert_eq!(failure.code, "workspace_busy");
        assert!(failure.recovery.contains("Do not delete"));
        assert!(failure.details.contains("OS error: 32"));
    }

    #[test]
    fn rejects_raw_stderr_unknown_codes_and_extra_private_fields() {
        for line in [
            "Error: token=private-value",
            "NETRIX_STARTUP_FAILURE:{\"code\":\"private-value\"}",
            "NETRIX_STARTUP_FAILURE:{\"code\":\"workspace_busy\",\"message\":\"private-value\"}",
            "NETRIX_STARTUP_FAILURE:{\"code\":\"workspace_busy\",\"os_error\":\"private-value\"}",
        ] {
            assert!(StartupReport::from_line(line.as_bytes()).is_none());
        }
        assert!(StartupReport::from_line(&vec![b'x'; 257]).is_none());
    }

    #[test]
    fn handles_other_loader_errors_signals_and_all_startup_codes() {
        assert_eq!(
            terminated(Some(0xC000007B_u32 as i32), None, None).code,
            "invalid_binary"
        );
        assert_eq!(
            terminated(Some(0xC0000142_u32 as i32), None, None).code,
            "library_initialization_failed"
        );
        assert_eq!(
            terminated(Some(0xC0000005_u32 as i32), None, None).code,
            "backend_crashed"
        );
        assert!(terminated(None, Some(9), None)
            .details
            .contains("Signal: 9"));
        for code in [
            "workspace_busy",
            "workspace_key_missing",
            "workspace_database_missing",
            "workspace_key_invalid",
            "workspace_access_denied",
            "data_directory_unavailable",
            "workspace_unavailable",
            "listener_denied",
            "local_port_in_use",
            "listener_unavailable",
        ] {
            let line = format!("{PREFIX}{{\"code\":\"{code}\",\"os_error\":null}}");
            let report = StartupReport::from_line(line.as_bytes()).unwrap();
            assert_eq!(terminated(Some(1), None, Some(&report)).code, code);
        }
    }
}
