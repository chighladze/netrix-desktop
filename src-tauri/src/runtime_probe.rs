//! Installer-only discovery. Runs before Tauri, plugins, logging or app data.
use std::ffi::OsString;

pub const UNAVAILABLE: i32 = 10;

pub fn requested(mut args: impl Iterator<Item = OsString>) -> bool {
    args.next().is_some_and(|arg| arg == "--check-webview2") && args.next().is_none()
}

fn exit_code(succeeded: bool, version: &str) -> i32 {
    if succeeded && !version.trim().is_empty() && version.trim() != "0.0.0.0" {
        0
    } else {
        UNAVAILABLE
    }
}

pub fn run() -> i32 {
    use webview2_com::take_pwstr;
    use webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString;
    use windows_core::{PCWSTR, PWSTR};

    let mut value = PWSTR::null();
    // SAFETY: null folder selects installed Evergreen, exactly as Wry does.
    // The loader owns allocation; take_pwstr frees it with CoTaskMemFree.
    let result =
        unsafe { GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut value) };
    let version = take_pwstr(value);
    match &result {
        Ok(()) => println!("WebView2 loader version: {version}"),
        Err(error) => eprintln!("WebView2 loader failed: {error}"),
    }
    exit_code(result.is_ok(), &version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requires_only_the_exact_probe_argument() {
        for args in [
            vec![],
            vec!["--check-webview2x"],
            vec!["--check-webview2", "extra"],
        ] {
            assert!(!requested(args.into_iter().map(OsString::from)));
        }
        assert!(requested([OsString::from("--check-webview2")].into_iter()));
    }

    #[test]
    fn failed_or_empty_loader_result_cannot_report_availability() {
        assert_eq!(exit_code(true, "143.0.1.2"), 0);
        for version in ["", "  ", "0.0.0.0", "143.0.1.2"] {
            assert_eq!(exit_code(false, version), UNAVAILABLE);
        }
        for version in ["", "  ", "0.0.0.0"] {
            assert_eq!(exit_code(true, version), UNAVAILABLE);
        }
    }
}
