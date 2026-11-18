//! Owns the sidecar process, including the private stdin write handle.
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(windows)]
use std::os::windows::io::OwnedHandle;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{atomic::Ordering, mpsc};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::{
    backend_diagnostics::StartupReport, log_error, BackendPhase, BackendState, BackendStatus,
};

// Includes up to 15 seconds of workspace lock contention in the sidecar.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const HEALTH_TIMEOUT: Duration = Duration::from_millis(500);
const POLL: Duration = Duration::from_millis(50);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(15);
const KILL_TIMEOUT: Duration = Duration::from_secs(2);
pub const EXIT_TIMEOUT: Duration = Duration::from_secs(19);

pub(super) fn binary_path(identifier: &str) -> io::Result<PathBuf> {
    let name = format!("netrix_backend{}", std::env::consts::EXE_SUFFIX);
    if cfg!(debug_assertions) {
        if identifier.starts_with("com.netrix.e2e.") {
            // The verified E2E manifest points at an isolated build.
            return std::env::var_os("NETRIX_E2E_BACKEND")
                .map(PathBuf::from)
                .filter(|path| path.is_absolute())
                .ok_or_else(|| io::Error::other("Missing absolute E2E backend path"));
        }
        return Ok(Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../backend-rs/target/debug")
            .join(name));
    }
    // NSIS removes the target suffix from externalBin and installs it beside
    // the shell. An absolute path avoids current-directory/PATH lookup.
    Ok(std::env::current_exe()?.with_file_name(name))
}

pub(super) fn launch(
    app: &AppHandle,
    executable: PathBuf,
    app_data_dir: PathBuf,
) -> io::Result<()> {
    let worker = app.clone();
    let (done, exited) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("netrix-sidecar".into())
        .spawn(move || {
            let state = worker.state::<BackendState>();
            if !state.exit.requested() {
                if let Err(error) = supervise(
                    &state,
                    &executable,
                    &app_data_dir,
                    #[cfg(windows)]
                    create_job,
                ) {
                    state.fail_if_starting(format!(
                        "Could not run the local Netrix service: {error}"
                    ));
                }
            }
            let _ = done.send(());
        })?;
    *app.state::<BackendState>()
        .exited
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = Some(exited);
    Ok(())
}

fn supervise(
    state: &BackendState,
    executable: &Path,
    app_data_dir: &Path,
    #[cfg(windows)] create_job: fn() -> io::Result<OwnedHandle>,
) -> io::Result<()> {
    let mut cmd = Command::new(executable);
    cmd.arg("--managed")
        .env(crate::APP_DATA_ENV, app_data_dir)
        .env_remove("NETRIX_DEV")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|error| io::Error::other(format!("{}: {error}", executable.display())))?;
    // The child waits for the first stdin frame before touching its profile.
    #[cfg(windows)]
    let job = match create_job().and_then(|job| assign_job(job, &child)) {
        Ok(job) => Some(job),
        Err(error) => {
            log_error(&format!(
                "Backend Job Object setup failed, using the parent pipe: {error}"
            ));
            None
        }
    };

    let (port_tx, port_rx) = mpsc::sync_channel(1);
    if let Some(stdout) = child.stdout.take() {
        let _ = std::thread::Builder::new()
            .name("netrix-sidecar-port".into())
            .spawn(move || {
                let _ = port_tx.send(read_port(stdout));
            })
            .map_err(|error| {
                state.fail_if_starting(format!(
                    "Could not read the backend listener address: {error}"
                ))
            });
    }
    let (report_tx, report_rx) = mpsc::channel();
    if let Some(stderr) = child.stderr.take() {
        let token = state.api_token.clone();
        let _ = std::thread::Builder::new()
            .name("netrix-sidecar-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).split(b'\n') {
                    let Ok(line) = line else { break };
                    if let Some(report) = StartupReport::from_line(&line) {
                        let _ = report_tx.send(report);
                    }
                    let msg = String::from_utf8_lossy(&line);
                    log_error(&format!(
                        "BACKEND STDERR: {}",
                        msg.trim().replace(&token, "[redacted]")
                    ));
                }
            })
            .map_err(|error| {
                log_error(&format!(
                    "Could not capture backend startup diagnostics: {error}"
                ))
            });
    }

    if !state.exit.requested() && state.is_starting() {
        let written = child
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::other("missing stdin pipe"))
            .and_then(|stdin| writeln!(stdin, "{}", state.api_token));
        if let Err(error) = written {
            state.fail_if_starting(format!(
                "Could not deliver the backend startup token: {error}"
            ));
        }
    }

    let outcome = poll_child(state, &mut child, port_rx);
    let status = match outcome {
        Ok(Some(status)) => Ok(status),
        Ok(None) | Err(_) => {
            if let Err(error) = outcome {
                state.fail_if_starting(format!("Could not check backend process status: {error}"));
                log_error(&format!("Backend process status error: {error}"));
            }
            stop_child(&mut child, SHUTDOWN_TIMEOUT).map(|(status, forced)| {
                if forced {
                    log_error("The shell terminated the backend after graceful shutdown could not be confirmed.");
                }
                status
            })
        }
    };
    // Close the Job while the shell is still alive. This also stops any
    // descendants of a crashed backend before a new instance can start.
    #[cfg(windows)]
    drop(job);
    let status = status.or_else(|error| {
        log_error(&format!("Backend shutdown could not be confirmed: {error}"));
        wait_for_exit(&mut child, KILL_TIMEOUT)?.ok_or(error)
    });
    match status {
        Ok(exit) => {
            if state.exit.requested() && exit.success() {
                log_error("Backend exited normally after shutdown request.");
            } else {
                #[cfg(unix)]
                let signal = std::os::unix::process::ExitStatusExt::signal(&exit);
                #[cfg(not(unix))]
                let signal = None;
                // Give stderr a bounded chance to deliver the allowlisted reason.
                let report = report_rx.recv_timeout(HEALTH_TIMEOUT).ok();
                log_error(&format!(
                    "Backend terminated: code={:?} signal={signal:?}",
                    exit.code()
                ));
                if !state.exit.requested() {
                    state.port.store(0, Ordering::Release);
                    state
                        .status
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .record_termination(exit.code(), signal, report.as_ref());
                }
            }
        }
        Err(error) => {
            state.fail(format!(
                "Could not confirm termination of the local Netrix service: {error}"
            ));
        }
    }
    Ok(())
}

fn read_port(stdout: impl Read) -> io::Result<u16> {
    let mut frame = String::new();
    BufReader::new(stdout.take(64)).read_line(&mut frame)?;
    frame
        .strip_prefix("NETRIX_LISTENING:")
        .and_then(|value| value.strip_suffix('\n'))
        .and_then(|port| port.trim_end_matches('\r').parse::<u16>().ok())
        .filter(|port| *port != 0)
        .ok_or_else(|| io::Error::other("Invalid listener address frame"))
}

fn poll_child(
    state: &BackendState,
    child: &mut Child,
    ports: mpsc::Receiver<io::Result<u16>>,
) -> io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut port = None;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let phase = state.phase();
        if state.exit.requested() || phase == BackendPhase::Failed {
            return Ok(None);
        }
        if phase == BackendPhase::Starting {
            if Instant::now() >= deadline {
                state.fail_if_starting(format!(
                    "Backend did not become ready within {} seconds",
                    READY_TIMEOUT.as_secs()
                ));
                return Ok(None);
            }
            if let (None, Ok(result)) = (port, ports.try_recv()) {
                match result {
                    Ok(value) => port = Some(value),
                    // The loader can close stdout just before try_wait reports
                    // the real exit code. Keep the diagnostic path available.
                    Err(error) => {
                        log_error(&format!("Backend did not announce a listener: {error}"))
                    }
                }
            }
            if let Some(port) = port {
                match backend_health_status(port, &state.api_token) {
                    Ok(Some(200)) => {
                        if let Some(status) = child.try_wait()? {
                            return Ok(Some(status));
                        }
                        if !state.exit.requested() {
                            state.port.store(port, Ordering::Release);
                            *state
                                .status
                                .lock()
                                .unwrap_or_else(|error| error.into_inner()) =
                                BackendStatus::ready();
                        }
                    }
                    Ok(Some(403)) => {
                        state.fail_if_starting(
                            "Backend health check rejected the parent API token".into(),
                        );
                        return Ok(None);
                    }
                    _ => {}
                }
            }
        }
        std::thread::sleep(POLL);
    }
}

fn backend_health_status(port: u16, api_token: &str) -> io::Result<Option<u16>> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT)?;
    stream.set_write_timeout(Some(HEALTH_TIMEOUT))?;
    write!(stream, "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-API-Token: {api_token}\r\nConnection: close\r\n\r\n")?;
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let mut reply = [0u8; 128];
    let mut read = 0;
    while read < reply.len() {
        let timeout = deadline.saturating_duration_since(Instant::now());
        if timeout.is_zero() {
            break;
        }
        stream.set_read_timeout(Some(timeout))?;
        let size = stream.read(&mut reply[read..])?;
        if size == 0 {
            break;
        }
        read += size;
        if let Some(end) = reply[..read].iter().position(|byte| *byte == b'\n') {
            return Ok(std::str::from_utf8(&reply[..end])
                .ok()
                .filter(|line| line.starts_with("HTTP/1.1 "))
                .and_then(|line| line.split_ascii_whitespace().nth(1))
                .and_then(|status| status.parse().ok()));
        }
    }
    Ok(None)
}

fn wait_for_exit(child: &mut Child, timeout: Duration) -> io::Result<Option<ExitStatus>> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        std::thread::sleep(POLL.min(remaining));
    }
}

fn stop_child(child: &mut Child, grace: Duration) -> io::Result<(ExitStatus, bool)> {
    drop(child.stdin.take());
    let graceful = wait_for_exit(child, grace);
    if let Ok(Some(status)) = graceful {
        return Ok((status, false));
    }
    let kill = child.kill();
    // The child may have exited between the last poll and kill().
    if let Some(status) = wait_for_exit(child, KILL_TIMEOUT)? {
        return Ok((status, kill.is_ok()));
    }
    kill?;
    graceful?;
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "Backend did not exit after termination",
    ))
}

#[cfg(windows)]
fn create_job() -> io::Result<OwnedHandle> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::System::JobObjects::*;
    // An unnamed, non-inheritable Job handle stays exclusively in the shell.
    let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    } == 0
    {
        return Err(io::Error::other(format!(
            "SetInformationJobObject: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(job)
}

#[cfg(windows)]
fn assign_job(job: OwnedHandle, child: &Child) -> io::Result<OwnedHandle> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    // Use the CreateProcess handle. A PID lookup can race process exit/reuse.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
        return Err(io::Error::other(format!(
            "AssignProcessToJobObject: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(job)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn listener_frame_must_contain_a_single_nonzero_port() {
        assert_eq!(read_port(&b"NETRIX_LISTENING:50123\n"[..]).unwrap(), 50123);
        for invalid in [
            "NETRIX_LISTENING:0\n",
            "NETRIX_LISTENING:80100\n",
            "NETRIX_LISTENING:1234",
            "token\n",
        ] {
            assert!(read_port(invalid.as_bytes()).is_err());
        }
    }

    #[test]
    fn backend_health_probe_sends_the_api_token() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let request: Vec<_> = BufReader::new(&socket)
                .lines()
                .map(Result::unwrap)
                .take_while(|line| !line.is_empty())
                .collect();
            let valid = request
                .first()
                .is_some_and(|line| line == "GET /health HTTP/1.1")
                && request
                    .iter()
                    .any(|line| line == "X-API-Token: health-test-token");
            let reply = if valid {
                "HTTP/1.1 200 OK"
            } else {
                "HTTP/1.1 403 Forbidden"
            };
            write!(socket, "{reply}\r\nContent-Length: 0\r\n\r\n").unwrap();
        });
        assert_eq!(
            backend_health_status(port, "health-test-token").unwrap(),
            Some(200)
        );
        server.join().unwrap();
    }

    #[test]
    fn deadline_terminates_and_waits_for_a_real_unresponsive_child() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "backend_process::tests::unresponsive_child_fixture",
            ])
            .env("NETRIX_STUBBORN_CHILD_FIXTURE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().unwrap();
        let (exit, forced) = stop_child(&mut child, Duration::from_millis(100)).unwrap();
        assert!(forced);
        assert!(!exit.success());
        assert_eq!(child.try_wait().unwrap(), Some(exit));
        assert!(child.stdin.is_none());
    }

    #[test]
    #[ignore = "subprocess fixture for the deadline test"]
    fn unresponsive_child_fixture() {
        if std::env::var_os("NETRIX_STUBBORN_CHILD_FIXTURE").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            std::thread::sleep(Duration::from_secs(10));
        }
    }
}

#[cfg(all(test, windows))]
mod restart_tests;
