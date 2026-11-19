#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU16, Ordering},
    mpsc, Mutex, OnceLock,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::StateFlags;

use uuid::Uuid;

mod backend_diagnostics;
mod backend_process;
mod problem_report;
#[cfg(windows)]
mod runtime_probe;
mod sftp_save_access;
mod terminal_drag;
mod terminal_window;
mod vault_keychain;

const APP_DATA_ENV: &str = "NETRIX_DATA_DIR";
const APP_IDENTIFIER: &str = "com.netrix.app";
const LEGACY_APP_DATA_DIR_NAME: &str = "Netrix";

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static APP_SCOPE_IDENTIFIER: OnceLock<String> = OnceLock::new();

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum BackendPhase {
    Starting,
    Ready,
    Failed,
}

#[derive(Clone, Serialize)]
struct BackendStatus {
    status: BackendPhase,
    message: Option<String>,
    diagnostic: Option<backend_diagnostics::BackendDiagnostic>,
    log_path: Option<String>,
}

impl BackendStatus {
    fn starting() -> Self {
        Self {
            status: BackendPhase::Starting,
            message: None,
            diagnostic: None,
            log_path: None,
        }
    }

    fn ready() -> Self {
        Self {
            status: BackendPhase::Ready,
            message: None,
            diagnostic: None,
            log_path: None,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            status: BackendPhase::Failed,
            message: Some(message.into()),
            diagnostic: None,
            log_path: None,
        }
    }

    fn terminated(
        code: Option<i32>,
        signal: Option<i32>,
        report: Option<&backend_diagnostics::StartupReport>,
    ) -> Self {
        let diagnostic = backend_diagnostics::terminated(code, signal, report);
        let message = diagnostic.message;
        Self {
            diagnostic: Some(diagnostic),
            ..Self::failed(message)
        }
    }

    fn record_termination(
        &mut self,
        code: Option<i32>,
        signal: Option<i32>,
        report: Option<&backend_diagnostics::StartupReport>,
    ) {
        let failure = Self::terminated(code, signal, report);
        let generic_exit = failure
            .diagnostic
            .as_ref()
            .is_some_and(|diagnostic| diagnostic.code == "backend_exited");
        // A forced exit after a pipe/setup failure must not erase that reason.
        // A known loader status or explicit backend report is more specific.
        if !matches!(self.status, BackendPhase::Failed) || !generic_exit {
            *self = failure;
        }
    }
}

#[tauri::command]
fn open_telegram_community(app: AppHandle) -> Result<(), &'static str> {
    #[allow(deprecated)]
    app.shell()
        .open("https://t.me/netrix_console", None)
        .map_err(|_| "Could not open the Telegram community in the default browser")
}

#[tauri::command]
fn quit_app(window: tauri::WebviewWindow) -> Result<(), &'static str> {
    if window.label() != "main" {
        return Err("Only the main window can quit Netrix");
    }
    window.app_handle().exit(0);
    Ok(())
}

/// A detached terminal may finish its own close transaction, but may never
/// destroy another window or bypass the main application's exit confirmation.
#[tauri::command]
fn close_terminal_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("detached-") {
        return Err("Only a detached terminal can close itself".into());
    }
    window.destroy().map_err(|error| error.to_string())
}

#[derive(Default)]
struct ExitGate {
    requested: AtomicBool,
    complete: AtomicBool,
}

impl ExitGate {
    fn begin(&self) -> bool {
        !self.requested.swap(true, Ordering::AcqRel)
    }

    fn requested(&self) -> bool {
        self.requested.load(Ordering::Acquire)
    }
}

struct BackendState {
    exit: ExitGate,
    exited: Mutex<Option<mpsc::Receiver<()>>>,
    port: AtomicU16,
    api_token: String,
    status: Mutex<BackendStatus>,
}

impl BackendState {
    fn new() -> Self {
        Self {
            exit: ExitGate::default(),
            exited: Mutex::new(None),
            port: AtomicU16::new(0),
            api_token: Uuid::new_v4().to_string(),
            status: Mutex::new(BackendStatus::starting()),
        }
    }

    fn phase(&self) -> BackendPhase {
        self.status
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .status
    }

    fn is_starting(&self) -> bool {
        self.phase() == BackendPhase::Starting
    }

    fn fail(&self, message: String) {
        *self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = BackendStatus::failed(&message);
        log_error(&message);
    }

    fn fail_if_starting(&self, message: String) {
        if self.is_starting() {
            self.fail(message);
        }
    }
}

fn finish_app_exit(app: AppHandle, code: i32) {
    let worker = app.clone();
    let started = std::thread::Builder::new()
        .name("netrix-app-exit".into())
        .spawn(move || {
            let state = worker.state::<BackendState>();
            let exited = state
                .exited
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
            if let Some(exited) = exited {
                if let Err(error) = exited.recv_timeout(backend_process::EXIT_TIMEOUT) {
                    log_error(&format!(
                        "Backend supervisor did not confirm shutdown: {error}"
                    ));
                }
            }
            state.exit.complete.store(true, Ordering::Release);
            worker.exit(code);
        });
    if let Err(error) = started {
        log_error(&format!("Could not start the exit waiter: {error}"));
        app.state::<BackendState>()
            .exit
            .complete
            .store(true, Ordering::Release);
        app.exit(code);
    }
}

/// Tauri command to get the backend port.
#[tauri::command]
fn get_backend_port(state: State<BackendState>) -> u16 {
    state.port.load(Ordering::Acquire)
}

/// Tauri command to get the API token.
#[tauri::command]
fn get_api_token(state: State<BackendState>) -> String {
    state.api_token.clone()
}

/// Tauri command used by the frontend startup flow to distinguish a backend
/// that is still binding its listener from one that failed to launch.
#[tauri::command]
fn get_backend_status(state: State<BackendState>) -> BackendStatus {
    let mut status = state
        .status
        .lock()
        .map(|status| status.clone())
        .unwrap_or_else(|_| BackendStatus::failed("Backend status lock is unavailable"));
    if matches!(status.status, BackendPhase::Failed) {
        status.log_path = APP_DATA_DIR.get().map(|directory| {
            directory
                .join("tauri_main.log")
                .to_string_lossy()
                .into_owned()
        });
    }
    status
}

#[derive(Default)]
struct AppDataMigration {
    moved_entries: usize,
    conflicts: Vec<String>,
    identity_conflict: bool,
}

fn legacy_app_data_dir(identifier: &str) -> Option<PathBuf> {
    if identifier != APP_IDENTIFIER {
        return None;
    }
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|base| base.join(LEGACY_APP_DATA_DIR_NAME))
}

fn is_backend_identity_file(name: &str) -> bool {
    [
        "database.db",
        "database.db-wal",
        "database.db-shm",
        "database.db-journal",
        ".database-key",
        ".vault_salt",
        ".secret_key",
        "known_hosts",
    ]
    .iter()
    .any(|identity_file| name.eq_ignore_ascii_case(identity_file))
}

/// Move the pre-identifier data directory into Tauri's identifier-based app
/// data directory. Entry-by-entry moves make an interrupted merge resumable;
/// existing destination files are never overwritten.
fn migrate_legacy_app_data(legacy: &Path, current: &Path) -> std::io::Result<AppDataMigration> {
    if legacy == current || !legacy.exists() {
        return Ok(AppDataMigration::default());
    }

    if !current.exists() {
        if let Some(parent) = current.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(legacy, current)?;
        return Ok(AppDataMigration {
            moved_entries: 1,
            conflicts: Vec::new(),
            identity_conflict: false,
        });
    }

    let entries = std::fs::read_dir(legacy)?.collect::<Result<Vec<_>, _>>()?;
    let mut conflicts = entries
        .iter()
        .filter_map(|entry| {
            let file_name = entry.file_name();
            current
                .join(&file_name)
                .exists()
                .then(|| file_name.to_string_lossy().into_owned())
        })
        .collect::<Vec<_>>();

    let legacy_identity_files = entries
        .iter()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            is_backend_identity_file(&name).then_some(name)
        })
        .collect::<Vec<_>>();
    let current_entries = std::fs::read_dir(current)?.collect::<Result<Vec<_>, _>>()?;
    let current_identity_files = current_entries
        .iter()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            is_backend_identity_file(&name).then_some(name)
        })
        .collect::<Vec<_>>();

    // Never split the SQLite/WAL or Vault identity set across roots. If both
    // roots contain any identity material, preserve the complete legacy tree
    // for explicit recovery instead of guessing which data set is authoritative.
    if !legacy_identity_files.is_empty() && !current_identity_files.is_empty() {
        conflicts.extend(legacy_identity_files);
        conflicts.extend(current_identity_files);
        conflicts.sort_unstable();
        conflicts.dedup();
        return Ok(AppDataMigration {
            moved_entries: 0,
            conflicts,
            identity_conflict: true,
        });
    }

    let mut report = AppDataMigration {
        moved_entries: 0,
        conflicts,
        identity_conflict: false,
    };
    for entry in entries {
        let file_name = entry.file_name();
        let target = current.join(&file_name);
        if target.exists() {
            continue;
        }

        std::fs::rename(entry.path(), target)?;
        report.moved_entries += 1;
    }

    if std::fs::read_dir(legacy)?.next().is_none() {
        std::fs::remove_dir(legacy)?;
    }

    Ok(report)
}

/// Log errors to the identifier-based app data directory since eprintln is invisible
/// in production (windows_subsystem = "windows").
fn log_error(msg: &str) {
    eprintln!("{}", msg);
    let log_dir = APP_DATA_DIR.get().cloned().or_else(|| {
        std::env::var_os("APPDATA").map(PathBuf::from).map(|base| {
            base.join(
                APP_SCOPE_IDENTIFIER
                    .get()
                    .map(String::as_str)
                    .unwrap_or(APP_IDENTIFIER),
            )
        })
    });
    if let Some(log_dir) = log_dir {
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("tauri_main.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)
        {
            use std::io::Write;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let _ = writeln!(f, "[{}] {}", now, msg);
        }
    }
}

fn validate_e2e_identifier(identifier: &str, expected: Option<&str>) -> Result<(), &'static str> {
    let e2e = identifier.strip_prefix("com.netrix.e2e.");
    if e2e.is_some() || expected.is_some() {
        if expected != Some(identifier)
            || !e2e.is_some_and(|suffix| {
                suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit())
            })
        {
            return Err("Desktop E2E requires a matching, dedicated build identifier");
        }
    }
    Ok(())
}

fn main() {
    #[cfg(windows)]
    if runtime_probe::requested(std::env::args_os().skip(1)) {
        std::process::exit(runtime_probe::run());
    }

    let context = tauri::generate_context!();
    let identifier = &context.config().identifier;
    if let Err(message) = validate_e2e_identifier(
        identifier,
        std::env::var("NETRIX_E2E_IDENTIFIER").ok().as_deref(),
    ) {
        eprintln!("{message}");
        std::process::exit(2);
    }
    let _ = APP_SCOPE_IDENTIFIER.set(identifier.clone());
    tauri::Builder::default()
        // Keep a single owner for the shared database and in-memory vault key.
        // This must be the first plugin so a secondary launch exits before it
        // initializes any other application state.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label == "main")
                .with_state_flags(StateFlags::SIZE | StateFlags::MAXIMIZED)
                .build(),
        )
        .manage(BackendState::new())
        .manage(terminal_drag::DragObservers::default())
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            get_api_token,
            get_backend_status,
            problem_report::get_problem_report_diagnostics,
            problem_report::open_problem_report,
            open_telegram_community,
            vault_keychain::read_vault_password,
            vault_keychain::save_vault_password,
            vault_keychain::remove_vault_password,
            quit_app,
            close_terminal_window,
            terminal_drag::wait_terminal_drag_release,
            terminal_drag::cancel_terminal_drag,
            terminal_drag::terminal_dock_target,
            terminal_window::open_terminal_window,
            sftp_save_access::watch_sftp_save_access,
            sftp_save_access::finish_sftp_save_access
        ])
        .on_page_load(sftp_save_access::cancel_on_navigation)
        .setup(move |app| {
            let backend = app.state::<BackendState>();
            let app_data_dir = match app.path().app_data_dir() {
                Ok(path) => path,
                Err(error) => {
                    backend.fail(format!("Failed to resolve app data directory: {error}"));
                    return Ok(());
                }
            };
            let _ = APP_DATA_DIR.set(app_data_dir.clone());

            if let Some(legacy_dir) = legacy_app_data_dir(&app.config().identifier) {
                match migrate_legacy_app_data(&legacy_dir, &app_data_dir) {
                    Ok(report) => {
                        if report.moved_entries > 0 {
                            log_error(&format!(
                                "Migrated {} legacy app-data entr{} into {}",
                                report.moved_entries,
                                if report.moved_entries == 1 { "y" } else { "ies" },
                                app_data_dir.display()
                            ));
                        }
                        if report.identity_conflict {
                            log_error(&format!(
                                "Legacy app-data migration was skipped to avoid splitting SQLite/Vault identity files; the legacy directory is unchanged. Conflicts: {}",
                                report.conflicts.join(", ")
                            ));
                        } else if !report.conflicts.is_empty() {
                            log_error(&format!(
                                "Legacy app-data entries were retained because current files already exist: {}",
                                report.conflicts.join(", ")
                            ));
                        }
                    }
                    Err(error) => {
                        backend.fail(format!(
                            "Failed to migrate legacy app data from {} to {}: {error}",
                            legacy_dir.display(),
                            app_data_dir.display()
                        ));
                        return Ok(());
                    }
                }
            }
            if let Err(error) = std::fs::create_dir_all(&app_data_dir) {
                backend.fail(format!(
                    "Failed to create app data directory {}: {error}",
                    app_data_dir.display()
                ));
                return Ok(());
            }

            // The main window starts hidden and is shown once the frontend is
            // mounted. Position restoration stays in the frontend so stale
            // off-screen coordinates can be ignored before the first show.
            if app.get_webview_window("main").is_none() {
                log_error("setup: main webview window not found");
            }

            let launch = backend_process::binary_path(&app.config().identifier).and_then(|binary| {
                backend_process::launch(app.handle(), binary, app_data_dir)
            });
            if let Err(error) = launch {
                backend.fail(format!("Could not start the local Netrix service: {error}"));
            }
            Ok(())
        })
                .build(context)
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                let state = app.state::<BackendState>();
                if !state.exit.complete.load(Ordering::Acquire) {
                    api.prevent_exit();
                    if state.exit.begin() {
                        finish_app_exit(app.clone(), code.unwrap_or(0));
                    }
                }
            }
        });
}
#[cfg(test)]
mod tests {
    #[test]
    fn repeat_exit_requests_cannot_start_another_shutdown() {
        let exit = super::ExitGate::default();
        assert!(!exit.requested());
        assert!(exit.begin());
        assert!(exit.requested());
        assert!(!exit.begin());
    }

    #[test]
    fn quit_and_telegram_commands_are_main_window_only() {
        let main = include_str!("../capabilities/default.json");
        let terminal = include_str!("../capabilities/detached-terminal.json");
        let map = include_str!("../capabilities/detached-map.json");
        for permission in ["allow-quit-app", "allow-open-telegram-community"] {
            assert!(main.contains(permission));
            assert!(!terminal.contains(permission));
            assert!(!map.contains(permission));
        }
    }

    #[test]
    fn process_exit_preserves_a_setup_failure_but_a_loader_reason_takes_priority() {
        let mut status = BackendStatus::failed("Could not deliver the startup token");
        status.record_termination(Some(1), None, None);
        assert_eq!(
            status.message.as_deref(),
            Some("Could not deliver the startup token")
        );
        status.record_termination(Some(0xC0000135_u32 as i32), None, None);
        assert_eq!(
            status.diagnostic.as_ref().unwrap().code,
            "missing_runtime_library"
        );
        let mut status = BackendStatus::starting();
        status.record_termination(Some(1), None, None);
        assert_eq!(status.diagnostic.as_ref().unwrap().code, "backend_exited");
    }

    #[test]
    fn e2e_rejects_production_or_missing_build_identity_before_startup() {
        let test_id = "com.netrix.e2e.0123456789abcdef0123456789abcdef";
        assert!(super::validate_e2e_identifier("com.netrix.app", Some(test_id)).is_err());
        assert!(super::validate_e2e_identifier(test_id, None).is_err());
        assert!(super::validate_e2e_identifier(test_id, Some(test_id)).is_ok());
        assert!(super::validate_e2e_identifier("com.netrix.app", None).is_ok());
        assert_eq!(super::legacy_app_data_dir(test_id), None);
    }
    use super::*;

    #[test]
    fn terminal_close_permission_cannot_destroy_arbitrary_windows() {
        let main = include_str!("../capabilities/default.json");
        let terminal = include_str!("../capabilities/detached-terminal.json");
        let map = include_str!("../capabilities/detached-map.json");
        assert!(!main.contains("allow-close-terminal-window"));
        assert!(!map.contains("allow-close-terminal-window"));
        assert!(terminal.contains("allow-close-terminal-window"));
        for capability in [main, terminal, map] {
            assert!(!capability.contains("allow-destroy"));
        }
    }

    #[test]
    fn sftp_save_access_commands_are_main_only() {
        let main = include_str!("../capabilities/default.json");
        let terminal = include_str!("../capabilities/detached-terminal.json");
        let map = include_str!("../capabilities/detached-map.json");
        for permission in [
            "allow-watch-sftp-save-access",
            "allow-finish-sftp-save-access",
        ] {
            assert!(main.contains(permission));
            assert!(!terminal.contains(permission));
            assert!(!map.contains(permission));
        }
    }

    #[test]
    fn legacy_app_data_merge_preserves_destination_conflicts() {
        let root =
            std::env::temp_dir().join(format!("netrix-app-data-migration-{}", Uuid::new_v4()));
        let legacy = root.join("Netrix");
        let current = root.join(APP_IDENTIFIER);
        std::fs::create_dir_all(&legacy).expect("create legacy directory");
        std::fs::create_dir_all(&current).expect("create current directory");
        std::fs::write(legacy.join("database.db"), b"legacy-db").expect("write legacy db");
        std::fs::write(legacy.join("tauri_main.log"), b"legacy-log").expect("write legacy log");
        std::fs::write(current.join("tauri_main.log"), b"current-log").expect("write current log");

        let report = migrate_legacy_app_data(&legacy, &current).expect("migrate app data");

        assert_eq!(report.moved_entries, 1);
        assert_eq!(report.conflicts, vec!["tauri_main.log"]);
        assert_eq!(
            std::fs::read(current.join("database.db")).expect("read migrated db"),
            b"legacy-db"
        );
        assert_eq!(
            std::fs::read(current.join("tauri_main.log")).expect("read current log"),
            b"current-log"
        );
        assert_eq!(
            std::fs::read(legacy.join("tauri_main.log")).expect("read retained legacy log"),
            b"legacy-log"
        );

        std::fs::remove_dir_all(&root).expect("remove test app-data directories");
    }

    #[test]
    fn legacy_app_data_merge_does_not_split_database_identity_files() {
        let root =
            std::env::temp_dir().join(format!("netrix-app-data-conflict-{}", Uuid::new_v4()));
        let legacy = root.join("Netrix");
        let current = root.join(APP_IDENTIFIER);
        std::fs::create_dir_all(&legacy).expect("create legacy directory");
        std::fs::create_dir_all(&current).expect("create current directory");
        std::fs::write(legacy.join("database.db"), b"legacy-db").expect("write legacy db");
        std::fs::write(legacy.join("database.db-wal"), b"legacy-wal").expect("write legacy wal");
        std::fs::write(legacy.join(".vault_salt"), b"legacy-salt").expect("write legacy salt");
        std::fs::write(current.join(".secret_key"), b"current-key")
            .expect("write current identity");

        let report = migrate_legacy_app_data(&legacy, &current).expect("inspect app-data conflict");

        assert_eq!(report.moved_entries, 0);
        assert_eq!(
            report.conflicts,
            vec![
                ".secret_key",
                ".vault_salt",
                "database.db",
                "database.db-wal"
            ]
        );
        assert!(report.identity_conflict);
        assert_eq!(
            std::fs::read(current.join(".secret_key")).expect("read current identity"),
            b"current-key"
        );
        assert_eq!(
            std::fs::read(legacy.join("database.db")).expect("read retained legacy db"),
            b"legacy-db"
        );
        assert_eq!(
            std::fs::read(legacy.join("database.db-wal")).expect("read retained legacy wal"),
            b"legacy-wal"
        );
        assert_eq!(
            std::fs::read(legacy.join(".vault_salt")).expect("read retained legacy salt"),
            b"legacy-salt"
        );

        std::fs::remove_dir_all(&root).expect("remove test app-data directories");
    }

    #[test]
    fn legacy_merge_keeps_encrypted_key_and_journal_with_their_workspace() {
        for existing in [".database-key", "database.db-journal"] {
            let root = std::env::temp_dir().join(format!("netrix-cipher-merge-{}", Uuid::new_v4()));
            let legacy = root.join("Netrix");
            let current = root.join(APP_IDENTIFIER);
            std::fs::create_dir_all(&legacy).expect("create legacy directory");
            std::fs::create_dir_all(&current).expect("create current directory");
            std::fs::write(legacy.join("database.db"), b"legacy encrypted database").unwrap();
            std::fs::write(legacy.join(".database-key"), b"legacy wrapped key").unwrap();
            std::fs::write(current.join(existing), b"current workspace identity").unwrap();

            let report = migrate_legacy_app_data(&legacy, &current).unwrap();

            assert!(report.identity_conflict);
            assert_eq!(report.moved_entries, 0);
            assert!(!current.join("database.db").exists());
            assert_eq!(
                std::fs::read(current.join(existing)).unwrap(),
                b"current workspace identity"
            );
            assert_eq!(
                std::fs::read(legacy.join(".database-key")).unwrap(),
                b"legacy wrapped key"
            );
            assert_eq!(
                std::fs::read(legacy.join("database.db")).unwrap(),
                b"legacy encrypted database"
            );
            std::fs::remove_dir_all(&root).expect("remove isolated migration fixture");
        }
    }
}
