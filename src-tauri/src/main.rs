#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_window_state::StateFlags;

use tauri_plugin_shell::process::CommandChild;
use uuid::Uuid;

mod backend_diagnostics;
#[cfg(windows)]
mod runtime_probe;
mod sftp_save_access;
mod terminal_drag;
mod terminal_window;
mod vault_keychain;

const APP_DATA_ENV: &str = "NETRIX_DATA_DIR";
const APP_IDENTIFIER: &str = "com.netrix.app";
const LEGACY_APP_DATA_DIR_NAME: &str = "Netrix";
const BACKEND_READY_TIMEOUT: Duration = Duration::from_secs(15);
const BACKEND_READY_INTERVAL: Duration = Duration::from_millis(100);
const BACKEND_HEALTH_IO_TIMEOUT: Duration = Duration::from_millis(500);

static APP_DATA_DIR: OnceLock<PathBuf> = OnceLock::new();
static APP_SCOPE_IDENTIFIER: OnceLock<String> = OnceLock::new();

#[derive(Clone, Serialize)]
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
        Self {
            diagnostic: Some(diagnostic.clone()),
            ..Self::failed(diagnostic.message)
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
fn quit_app(app: AppHandle) {
    app.exit(0);
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

/// Holds the backend process handles and port.
struct BackendState {
    child: Mutex<Option<Child>>, // Used in dev mode (std process)
    sidecar_child: Mutex<Option<CommandChild>>, // Used in prod mode (tauri shell sidecar)
    port: u16,
    api_token: String,
    status: Mutex<BackendStatus>,
    #[cfg(windows)]
    _job: Mutex<Option<JobHandle>>, // Windows Job Object to group processes
}

/// Find a free TCP port by binding to port 0.
fn find_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("Failed to bind to find free port")
        .local_addr()
        .expect("Failed to get local addr")
        .port()
}

// ─── Windows Job Object ─────────────────────────────────────────────
// Groups the backend child process under the main Netrix process so
// Task Manager shows a single "Netrix" entry instead of two.

#[cfg(windows)]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn create_job_object() -> Option<JobHandle> {
    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::System::JobObjects::*;

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() || job == INVALID_HANDLE_VALUE {
            eprintln!("Failed to create Job Object");
            return None;
        }

        // Configure: kill all processes in the job when the handle is closed
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

        let set_ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );

        if set_ok == 0 {
            eprintln!("Failed to set Job Object limits");
            CloseHandle(job);
            return None;
        }

        Some(JobHandle(job))
    }
}

#[cfg(windows)]
fn assign_process_to_job(job: &JobHandle, process_id: u32) {
    use windows_sys::Win32::System::JobObjects::*;
    use windows_sys::Win32::System::Threading::*;

    unsafe {
        let proc_handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id);
        if !proc_handle.is_null() {
            let ok = AssignProcessToJobObject(job.0, proc_handle);
            if ok == 0 {
                eprintln!("Failed to assign process {} to Job Object", process_id);
            }
            windows_sys::Win32::Foundation::CloseHandle(proc_handle);
        } else {
            eprintln!(
                "Failed to open process {} for Job Object assignment",
                process_id
            );
        }
    }
}

#[cfg(windows)]
fn assign_child_to_job(job: &JobHandle, child: &Child) {
    assign_process_to_job(job, child.id());
}

/// Tauri command to get the backend port.
#[tauri::command]
fn get_backend_port(state: State<BackendState>) -> u16 {
    state.port
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

fn update_backend_status(app: &AppHandle, status: BackendStatus) {
    let state: State<BackendState> = app.state();
    if let Ok(mut current) = state.status.lock() {
        *current = status;
    };
}

fn mark_backend_ready(app: &AppHandle) {
    let state: State<BackendState> = app.state();
    if let Ok(mut current) = state.status.lock() {
        if matches!(&current.status, BackendPhase::Starting) {
            *current = BackendStatus::ready();
        }
    };
}

fn mark_backend_failed_if_starting(app: &AppHandle, message: String) {
    let state: State<BackendState> = app.state();
    if let Ok(mut current) = state.status.lock() {
        if matches!(&current.status, BackendPhase::Starting) {
            *current = BackendStatus::failed(message);
        }
    };
}

fn backend_health_status(
    address: &SocketAddr,
    port: u16,
    api_token: &str,
) -> std::io::Result<Option<u16>> {
    let mut stream = TcpStream::connect_timeout(address, BACKEND_READY_INTERVAL)?;
    stream.set_read_timeout(Some(BACKEND_HEALTH_IO_TIMEOUT))?;
    stream.set_write_timeout(Some(BACKEND_HEALTH_IO_TIMEOUT))?;

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-API-Token: {api_token}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;

    let mut status_line = String::new();
    BufReader::new(stream).read_line(&mut status_line)?;
    Ok(status_line
        .split_ascii_whitespace()
        .nth(1)
        .and_then(|status| status.parse::<u16>().ok()))
}

fn spawn_backend_readiness_probe(app: AppHandle, port: u16, api_token: String) {
    std::thread::spawn(move || {
        let address = SocketAddr::from(([127, 0, 0, 1], port));
        let deadline = Instant::now() + BACKEND_READY_TIMEOUT;
        while Instant::now() < deadline {
            match backend_health_status(&address, port, &api_token) {
                Ok(Some(200)) => {
                    mark_backend_ready(&app);
                    return;
                }
                Ok(Some(403)) => {
                    let message = "Backend health check rejected the parent API token".to_string();
                    log_error(&message);
                    mark_backend_failed_if_starting(&app, message);
                    return;
                }
                _ => {}
            }
            std::thread::sleep(BACKEND_READY_INTERVAL);
        }

        let message = format!(
            "Backend did not become ready on localhost port {port} within {} seconds",
            BACKEND_READY_TIMEOUT.as_secs()
        );
        log_error(&message);
        mark_backend_failed_if_starting(&app, message);
    });
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
    // Find a free port before starting Tauri
    let port = find_free_port();
    // Generate a secure unique token for this session
    let api_token = Uuid::new_v4().to_string();

    // Create a Windows Job Object to group backend under Netrix in Task Manager
    #[cfg(windows)]
    let job = create_job_object();

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
        .manage(BackendState {
            child: Mutex::new(None),
            sidecar_child: Mutex::new(None),
            port,
            api_token: api_token.clone(),
            status: Mutex::new(BackendStatus::starting()),
            #[cfg(windows)]
            _job: Mutex::new(job),
        })
        .manage(terminal_drag::DragObservers::default())
        .invoke_handler(tauri::generate_handler![
            get_backend_port,
            get_api_token,
            get_backend_status,
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
            let app_data_dir = match app.path().app_data_dir() {
                Ok(path) => path,
                Err(error) => {
                    let message = format!("Failed to resolve app data directory: {error}");
                    log_error(&message);
                    update_backend_status(app.handle(), BackendStatus::failed(message));
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
                        let message = format!(
                            "Failed to migrate legacy app data from {} to {}: {error}",
                            legacy_dir.display(),
                            app_data_dir.display()
                        );
                        log_error(&message);
                        update_backend_status(app.handle(), BackendStatus::failed(message));
                        return Ok(());
                    }
                }
            }
            if let Err(error) = std::fs::create_dir_all(&app_data_dir) {
                let message = format!(
                    "Failed to create app data directory {}: {error}",
                    app_data_dir.display()
                );
                log_error(&message);
                update_backend_status(app.handle(), BackendStatus::failed(message));
                return Ok(());
            }

            // The main window starts hidden and is shown once the frontend is
            // mounted. Position restoration stays in the frontend so stale
            // off-screen coordinates can be ignored before the first show.
            if app.get_webview_window("main").is_none() {
                log_error("setup: main webview window not found");
            }

            let port_str = port.to_string();
            let tauri_pid = std::process::id().to_string();
            let token_arg = api_token.clone();

            if cfg!(debug_assertions) {
                // Development mode — launch Rust backend binary from backend-rs/target/debug
                let manifest_dir = env!("CARGO_MANIFEST_DIR");
                let project_root = std::path::PathBuf::from(manifest_dir).parent().unwrap().to_path_buf();
                let backend_bin = if app.config().identifier.starts_with("com.netrix.e2e.") {
                    // The verified E2E build manifest supplies its separate sidecar.
                    std::env::var_os("NETRIX_E2E_BACKEND").map(PathBuf::from).filter(|path| path.is_absolute()).unwrap_or_default()
                } else {
                    project_root.join("backend-rs").join("target").join("debug").join("netrix_backend.exe")
                };

                if !backend_bin.exists() {
                    let message = format!(
                        "Backend binary not found at {:?}. Run: cargo build --manifest-path backend-rs/Cargo.toml",
                        backend_bin
                    );
                    log_error(&message);
                    update_backend_status(app.handle(), BackendStatus::failed(message));
                    return Ok(());
                }

                println!("Launching Backend (Dev): {:?} {} {} <stdin_token>", backend_bin, port_str, tauri_pid);

                let mut cmd = Command::new(&backend_bin);
                cmd.arg(&port_str)
                    .arg(&tauri_pid)
                    .env(APP_DATA_ENV, &app_data_dir)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::inherit())
                    .stderr(Stdio::inherit());

                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x08000000;
                    cmd.creation_flags(CREATE_NO_WINDOW);
                }

                match cmd.spawn() {
                    Ok(mut child) => {
                        // Write token to stdin
                        let token_result = if let Some(mut stdin) = child.stdin.take() {
                            stdin.write_all(format!("{}\n", token_arg).as_bytes())
                        } else {
                            Err(std::io::Error::new(
                                std::io::ErrorKind::BrokenPipe,
                                "backend stdin pipe was not created",
                            ))
                        };
                        if let Err(error) = token_result {
                            let message = format!(
                                "Failed to deliver the API token to backend stdin: {error}"
                            );
                            log_error(&message);
                            let _ = child.kill();
                            update_backend_status(app.handle(), BackendStatus::failed(message));
                            return Ok(());
                        }

                        // Assign to Job Object so it groups under Netrix in Task Manager
                        #[cfg(windows)]
                        {
                            let state: State<BackendState> = app.state();
                            if let Ok(guard) = state._job.lock() {
                                if let Some(ref job) = *guard {
                                    assign_child_to_job(job, &child);
                                }
                            };
                        }

                        let state: State<BackendState> = app.state();
                        if let Ok(mut stored_child) = state.child.lock() {
                            *stored_child = Some(child);
                        }
                        spawn_backend_readiness_probe(
                            app.handle().clone(),
                            port,
                            token_arg.clone(),
                        );
                    }
                    Err(error) => {
                        let message = format!("Failed to spawn backend: {error}");
                        log_error(&message);
                        update_backend_status(app.handle(), BackendStatus::failed(message));
                    }
                }
            } else {
                // Production mode - launch via Sidecar
                let shell = app.shell();
                let sidecar_result = shell.sidecar("netrix_backend");

                match sidecar_result {
                    Ok(sidecar_command) => {
                        let sidecar_command = sidecar_command
                            .arg(&port_str)
                            .arg(&tauri_pid)
                            .env(APP_DATA_ENV, &app_data_dir);

                        match sidecar_command.spawn() {
                            Ok((mut rx, mut child)) => {
                                // Drain events even if the loader exits before stdin can be written.
                                let event_app = app.handle().clone();
                                let event_token = token_arg.clone();
                                tauri::async_runtime::spawn(async move {
                                    let mut startup_report = None;
                                    while let Some(event) = rx.recv().await {
                                        match event {
                                            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                                                println!("BACKEND: {}", String::from_utf8_lossy(&line).trim());
                                            }
                                            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                                                if let Some(report) = backend_diagnostics::StartupReport::from_line(&line) {
                                                    startup_report = Some(report);
                                                }
                                                let msg = String::from_utf8_lossy(&line);
                                                log_error(&format!("BACKEND STDERR: {}", msg.trim().replace(&event_token, "[redacted]")));
                                            }
                                            tauri_plugin_shell::process::CommandEvent::Error(err) => {
                                                let message = format!("BACKEND ERROR: {}", err.replace(&event_token, "[redacted]"));
                                                log_error(&message);
                                                let state: State<BackendState> = event_app.state();
                                                if let Ok(mut current) = state.status.lock() {
                                                    if !matches!(current.status, BackendPhase::Failed) {
                                                        *current = BackendStatus::failed(message);
                                                    }
                                                };
                                            }
                                            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                                                log_error(&format!(
                                                    "BACKEND TERMINATED: code={:?} signal={:?}",
                                                    payload.code, payload.signal
                                                ));
                                                let state: State<BackendState> = event_app.state();
                                                if let Ok(mut current) = state.status.lock() {
                                                    current.record_termination(payload.code, payload.signal, startup_report.as_ref());
                                                };
                                            }
                                            _ => {}
                                        }
                                    }
                                });

                                // Write token to sidecar stdin
                                if let Err(error) =
                                    child.write(format!("{}\n", token_arg).as_bytes())
                                {
                                    let message = format!(
                                        "Failed to deliver the API token to sidecar stdin: {error}"
                                    );
                                    log_error(&message);
                                    mark_backend_failed_if_starting(app.handle(), message);
                                    let _ = child.kill();
                                    return Ok(());
                                }

                                // Assign sidecar to Job Object so it groups under Netrix in Task Manager
                                #[cfg(windows)]
                                {
                                    let pid = child.pid();
                                    let state: State<BackendState> = app.state();
                                    if let Ok(guard) = state._job.lock() {
                                        if let Some(ref job) = *guard {
                                            assign_process_to_job(job, pid);
                                        }
                                    };
                                }

                                let state: State<BackendState> = app.state();
                                if let Ok(mut stored_child) = state.sidecar_child.lock() {
                                    *stored_child = Some(child);
                                }
                                spawn_backend_readiness_probe(
                                    app.handle().clone(),
                                    port,
                                    token_arg.clone(),
                                );
                            }
                            Err(error) => {
                                let message = format!("Failed to spawn sidecar: {error}");
                                log_error(&message);
                                update_backend_status(
                                    app.handle(),
                                    BackendStatus::failed(message),
                                );
                            }
                        }
                    }
                    Err(error) => {
                        let message = format!("Failed to create sidecar: {error}");
                        log_error(&message);
                        update_backend_status(app.handle(), BackendStatus::failed(message));
                    }
                }
            }

            Ok(())
        })
        .build(context)
        .expect("error while running tauri application")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Main process exit - Job Object will auto-kill children (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
                std::process::exit(0);
            }
        });
}

#[cfg(test)]
mod tests {
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
    fn backend_health_probe_sends_the_api_token() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind health test listener");
        let address = listener.local_addr().expect("read health listener address");
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health probe");
            let mut request = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).expect("read health header");
                    if line == "\r\n" || line.is_empty() {
                        break;
                    }
                    request.push_str(&line);
                }
            }
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .expect("write health response");
            request
        });

        let status = backend_health_status(&address, address.port(), "health-test-token")
            .expect("probe health endpoint");
        let request = server.join().expect("join health test server");

        assert_eq!(status, Some(200));
        assert!(request.starts_with("GET /health HTTP/1.1\r\n"));
        assert!(request.contains("X-API-Token: health-test-token\r\n"));
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
