use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn failed_startup_emits_a_safe_reason_from_the_real_binary() {
    let directory =
        std::env::temp_dir().join(format!("netrix-startup-error-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let blocked = directory.join("not-a-directory");
    std::fs::write(&blocked, "fixture").unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_netrix_backend"));
    command
        .env_remove("NETRIX_DEV")
        .env("NETRIX_DATA_DIR", &blocked)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut timed_out = false;
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            timed_out = true;
            child.kill().unwrap();
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    std::fs::remove_dir_all(&directory).unwrap();
    assert!(!timed_out, "the failing startup must exit promptly");
    assert_eq!(output.status.code(), Some(1));
    let stderr = String::from_utf8(output.stderr).unwrap();
    let record = stderr
        .lines()
        .find_map(|line| line.strip_prefix("NETRIX_STARTUP_FAILURE:"))
        .unwrap();
    let record: serde_json::Value = serde_json::from_str(record).unwrap();
    assert_eq!(record["code"], "data_directory_unavailable");
    assert_eq!(record.as_object().unwrap().len(), 2);
    assert!(!record.to_string().contains("not-a-directory"));
}
