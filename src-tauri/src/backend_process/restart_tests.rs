//! Runs the production Windows supervisor with a Job handle that denies assignment.
use super::*;
use crate::APP_DATA_DIR;
use std::fs;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::CommandExt;
use std::sync::Arc;
use windows_sys::Win32::Foundation::DuplicateHandle;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, CREATE_NO_WINDOW};

const PROFILE_ENV: &str = "NETRIX_RESTART_TEST_PROFILE";
const PHASE_ENV: &str = "NETRIX_RESTART_TEST_PHASE";
const PROFILE_PREFIX: &str = "netrix-restart-without-job-";
const TOKEN: &str = "isolated-restart-test-token";
const PASSWORD: &str = r#"{"master_password":"isolated-restart-test-password"}"#;
const HOST: &str = "restart-test-host";
const MAX_WAIT: Duration = Duration::from_secs(25);

struct Fixture(Child);

impl Fixture {
    fn start(profile: &Path, phase: &str) -> Self {
        Self(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "backend_process::restart_tests::restricted_supervisor_fixture",
                    "--ignored",
                    "--nocapture",
                ])
                .env(PROFILE_ENV, profile)
                .env(PHASE_ENV, phase)
                .env("RUST_LOG", "info")
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }

    fn wait_ready(&mut self, profile: &Path, phase: &str) -> u16 {
        until("authenticated readiness", || {
            assert!(
                self.0.try_wait().unwrap().is_none(),
                "fixture exited during startup"
            );
            fs::read_to_string(profile.join(phase))
                .ok()
                .map(|port| port.parse().unwrap())
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.0.try_wait().is_ok_and(|status| status.is_none()) {
            let _ = self.0.kill();
            let _ = wait_for_exit(&mut self.0, KILL_TIMEOUT);
        }
    }
}

fn until<T>(name: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + MAX_WAIT;
    loop {
        if let Some(value) = check() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {name}");
        std::thread::sleep(POLL);
    }
}

fn http_connection(port: u16) -> TcpStream {
    let stream =
        TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), HEALTH_TIMEOUT)
            .unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(35)))
        .unwrap();
    stream.set_write_timeout(Some(HEALTH_TIMEOUT)).unwrap();
    stream
}

fn request(port: u16, route: &str, body: &str, status: u16) -> String {
    let mut stream = http_connection(port);
    write!(stream, "{route} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-API-Token: {TOKEN}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    assert!(
        reply.starts_with(&format!("HTTP/1.1 {status} ")),
        "{route} returned {reply}"
    );
    reply
}

#[test]
#[ignore = "requires a freshly built Windows debug sidecar; see docs/TESTING.md"]
fn restart_waits_for_the_previous_sidecar_when_job_assignment_is_denied() {
    let profile = std::env::temp_dir().join(format!("{PROFILE_PREFIX}{}", uuid::Uuid::new_v4()));
    fs::create_dir(&profile).unwrap();
    let lock = profile.join(".database-lock");
    let marker = b"persistent lock file";
    fs::write(&lock, marker).unwrap();

    let mut previous = Fixture::start(&profile, "initial-ready");
    let port = previous.wait_ready(&profile, "initial-ready");
    let log = fs::read_to_string(profile.join("tauri_main.log")).unwrap_or_default();
    assert!(
        log.contains("AssignProcessToJobObject:") && log.contains("(os error 5)"),
        "the initial supervisor must receive a Windows Job assignment error"
    );
    request(port, "POST /security/unlock", PASSWORD, 200);
    request(
        port,
        "POST /hosts",
        &format!(
            r#"{{"name":"{HOST}","hostname":"127.0.0.1","connection_type":"telnet","port":23}}"#
        ),
        201,
    );

    // 100 Continue proves Axum accepted the authenticated request and is
    // waiting for its body. Leave the connection open through the old drain.
    let mut stalled = http_connection(port);
    write!(stalled, "POST /hosts HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-API-Token: {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 64\r\nExpect: 100-continue\r\n\r\n").unwrap();
    let mut header = String::new();
    BufReader::new(&mut stalled).read_line(&mut header).unwrap();
    assert_eq!(header, "HTTP/1.1 100 Continue\r\n");

    let began = Instant::now();
    previous.0.kill().unwrap();
    assert!(!wait_for_exit(&mut previous.0, KILL_TIMEOUT)
        .unwrap()
        .unwrap()
        .success());
    let mut restarted = Fixture::start(&profile, "restart-ready");
    until("replacement waiting for the earlier lock owner", || {
        fs::read_to_string(profile.join("backend.log"))
            .ok()
            .filter(|log| log.contains("Waiting for the workspace lock to be released"))
    });
    assert!(!profile.join("restart-ready").exists());
    let new_port = restarted.wait_ready(&profile, "restart-ready");
    drop(stalled);
    let elapsed = began.elapsed();
    if new_port != port {
        assert!(
            backend_health_status(port, TOKEN).is_err(),
            "previous listener survived"
        );
    }
    request(new_port, "POST /security/unlock", PASSWORD, 200);
    assert!(request(new_port, "GET /hosts", "", 200).contains(HOST));
    drop(restarted.0.stdin.take());
    assert!(wait_for_exit(&mut restarted.0, MAX_WAIT)
        .unwrap()
        .unwrap()
        .success());
    assert_eq!(fs::read(&lock).unwrap(), marker);

    let log = fs::read_to_string(profile.join("tauri_main.log")).unwrap();
    let job_failures = log
        .matches(
            "Backend Job Object setup failed, using the parent pipe: AssignProcessToJobObject:",
        )
        .count();
    assert_eq!(job_failures, 2, "{log}");
    println!("Windows denied both real Job assignments. The replacement became ready after {elapsed:.1?} and reopened the workspace with the original lock file.");
    assert_eq!(profile.parent(), Some(std::env::temp_dir().as_path()));
    fs::remove_dir_all(profile).unwrap();
}

#[test]
#[ignore = "subprocess fixture for the restricted Job restart test"]
fn restricted_supervisor_fixture() {
    let profile = PathBuf::from(std::env::var_os(PROFILE_ENV).expect("fixture profile"));
    assert_eq!(profile.parent(), Some(std::env::temp_dir().as_path()));
    assert!(profile
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with(PROFILE_PREFIX));
    let phase = std::env::var(PHASE_ENV).unwrap();
    assert!(matches!(phase.as_str(), "initial-ready" | "restart-ready"));
    APP_DATA_DIR.set(profile.clone()).unwrap();

    let mut state = BackendState::new();
    state.api_token = TOKEN.to_owned();
    let state = Arc::new(state);
    let worker = {
        let state = state.clone();
        let profile = profile.clone();
        std::thread::spawn(move || {
            let sidecar = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../backend-rs/target/debug/netrix_backend.exe");
            supervise(&state, &sidecar, &profile, job_without_assign_access).unwrap();
        })
    };
    let port = until("supervisor to publish readiness", || match state.phase() {
        BackendPhase::Starting if !worker.is_finished() => None,
        BackendPhase::Ready => Some(state.port.load(Ordering::Acquire)),
        _ => panic!("sidecar failed to start in the restricted fixture"),
    });
    fs::write(profile.join(phase), port.to_string()).unwrap();
    io::stdin().lock().read_line(&mut String::new()).unwrap();
    state.exit.begin();
    worker.join().unwrap();
}

fn job_without_assign_access() -> io::Result<OwnedHandle> {
    let job = create_job()?;
    // Windows enforces the missing JOB_OBJECT_ASSIGN_PROCESS right in the
    // production AssignProcessToJobObject call.
    let mut restricted = std::ptr::null_mut();
    let process = unsafe { GetCurrentProcess() };
    if unsafe {
        DuplicateHandle(
            process,
            job.as_raw_handle(),
            process,
            &mut restricted,
            0,
            0,
            0,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedHandle::from_raw_handle(restricted) })
}
