//! User-reviewed reports. Never read logs, workspace files, tokens or host data.
use crate::{BackendPhase, BackendState, BackendStatus};
use serde::Serialize;
use tauri::{AppHandle, State, Url};
use tauri_plugin_shell::ShellExt;

const ISSUE_URL: &str = "https://github.com/chighladze/netrix-releases/issues/new";
const MAX_URL_BYTES: usize = 7000;

#[derive(Serialize)]
pub struct ProblemReportDiagnostics {
    app_version: &'static str,
    operating_system: String,
    architecture: &'static str,
    backend_status: &'static str,
    reason: Option<&'static str>,
    exit_code: Option<i32>,
    signal: Option<i32>,
    os_error: Option<i32>,
}

fn collect(status: Option<&BackendStatus>) -> ProblemReportDiagnostics {
    let diagnostic = status.and_then(|status| status.diagnostic.as_ref());
    ProblemReportDiagnostics {
        app_version: env!("CARGO_PKG_VERSION"),
        operating_system: operating_system(),
        architecture: std::env::consts::ARCH,
        backend_status: match status.map(|status| &status.status) {
            Some(BackendPhase::Starting) => "starting",
            Some(BackendPhase::Ready) => "ready",
            Some(BackendPhase::Failed) => "failed",
            None => "unavailable",
        },
        reason: diagnostic.map(|value| value.code),
        exit_code: diagnostic.and_then(|value| value.exit_code),
        signal: diagnostic.and_then(|value| value.signal),
        os_error: diagnostic.and_then(|value| value.os_error),
    }
}

#[cfg(windows)]
fn operating_system() -> String {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        dwMajorVersion: 0,
        dwMinorVersion: 0,
        dwBuildNumber: 0,
        dwPlatformId: 0,
        szCSDVersion: [0; 128],
    };
    // SAFETY: a correctly sized, initialized structure is valid for this call.
    // Only numeric OS version/build fields are exposed, not machine identity.
    if unsafe { RtlGetVersion(&mut version) } == 0 {
        format!(
            "Windows {}.{} (build {})",
            version.dwMajorVersion, version.dwMinorVersion, version.dwBuildNumber
        )
    } else {
        "Windows (build unavailable)".into()
    }
}

#[cfg(not(windows))]
fn operating_system() -> String {
    std::env::consts::OS.into()
}

#[tauri::command]
pub fn get_problem_report_diagnostics(state: State<BackendState>) -> ProblemReportDiagnostics {
    let snapshot = state.status.lock().ok().map(|value| value.clone());
    collect(snapshot.as_ref())
}

fn validate_issue_url(value: &str) -> Result<Url, &'static str> {
    if value.len() > MAX_URL_BYTES || !value.starts_with(&format!("{ISSUE_URL}?")) {
        return Err("Only the Netrix GitHub report form can be opened");
    }
    let url = Url::parse(value).map_err(|_| "Invalid report link")?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.path() != "/chighladze/netrix-releases/issues/new"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid report destination");
    }
    let mut keys = std::collections::HashSet::new();
    for (key, content) in url.query_pairs() {
        if !matches!(
            key.as_ref(),
            "template"
                | "title"
                | "version"
                | "environment"
                | "area"
                | "reproduce"
                | "expected"
                | "actual"
                | "evidence"
        ) || !keys.insert(key.into_owned())
        {
            return Err("Unexpected report field");
        }
        if content.contains('\0') {
            return Err("Invalid report field");
        }
    }
    if !url
        .query_pairs()
        .any(|(key, value)| key == "template" && value == "bug-report.yml")
    {
        return Err("Invalid report template");
    }
    Ok(url)
}

#[tauri::command]
pub fn open_problem_report(app: AppHandle, url: String) -> Result<(), String> {
    let validated = validate_issue_url(&url)?;
    // Reuse the installed shell plugin behind a fixed-purpose command. Do not
    // grant shell:allow-open or accept a browser executable from the renderer.
    #[allow(deprecated)]
    app.shell()
        .open(validated.to_string(), None)
        .map_err(|_| "Could not open GitHub. Copy the report and open the form manually.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_excludes_raw_messages_paths_and_display_diagnostics() {
        let mut status = BackendStatus::terminated(Some(-1073741515), None, None);
        status.message = Some("password=private-value host=private.example".into());
        status.log_path = Some(r"C:\Users\private-user\tauri_main.log".into());
        status.diagnostic.as_mut().unwrap().details = "token=private-value".into();
        let report = serde_json::to_value(collect(Some(&status))).unwrap();
        assert_eq!(report["reason"], "missing_runtime_library");
        assert_eq!(report["exit_code"], -1073741515);
        assert_eq!(report["backend_status"], "failed");
        assert!(!report.to_string().contains("private"));
        assert!(!report.to_string().contains("log_path"));
    }

    #[test]
    fn unavailable_status_remains_reportable_without_a_backend() {
        let report = collect(None);
        assert_eq!(report.backend_status, "unavailable");
        assert!(report.reason.is_none());
        assert!(report.exit_code.is_none());
        assert_eq!(report.app_version, env!("CARGO_PKG_VERSION"));
        assert!(!report.operating_system.is_empty());
    }

    #[test]
    fn permits_only_encoded_fields_on_the_fixed_form() {
        let mut url = Url::parse(ISSUE_URL).unwrap();
        url.query_pairs_mut()
            .append_pair("template", "bug-report.yml")
            .append_pair("actual", "Ошибка & # ? = + \"quoted\"\nSecond line")
            .append_pair("environment", "Windows 10.0 (build 26100)");
        assert!(validate_issue_url(url.as_str()).is_ok());
    }

    #[test]
    fn rejects_arbitrary_destinations_templates_and_extra_fields() {
        for url in [
            "https://github.com.evil.test/chighladze/netrix-releases/issues/new?template=bug-report.yml",
            "https://evil.test/?template=bug-report.yml",
            "https://github.com@evil.test/chighladze/netrix-releases/issues/new?template=bug-report.yml",
            "file:///C:/Windows/system32/cmd.exe",
            "javascript:alert(1)",
            "https://github.com/chighladze/netrix/issues/new?template=bug-report.yml",
        ] { assert!(validate_issue_url(url).is_err(), "{url}"); }
        for query in [
            "template=other.yml",
            "title=missing-template",
            "template=bug-report.yml#fragment",
            "template=bug-report.yml&template=bug-report.yml",
            "template=bug-report.yml&redirect=https://evil.test",
            "template=bug-report.yml&actual=%00",
        ] {
            assert!(validate_issue_url(&format!("{ISSUE_URL}?{query}")).is_err());
        }
        assert!(validate_issue_url(&format!(
            "{ISSUE_URL}?template=bug-report.yml&actual={}",
            "x".repeat(MAX_URL_BYTES)
        ))
        .is_err());
    }
}
