//! Bounded, non-secret startup reasons for the desktop shell. Raw errors stay
//! in local diagnostics; they must never become pre-unlock frontend DTOs.
use netrix_backend::database_encryption::WorkspaceBusy;
use std::io::ErrorKind;

pub const PREFIX: &str = "NETRIX_STARTUP_FAILURE:";

#[derive(Clone, Copy)]
pub enum Stage {
    DataDirectory,
    Workspace,
    Listener,
}

fn code(stage: Stage, error: &anyhow::Error) -> &'static str {
    if matches!(stage, Stage::Workspace) {
        if error.is::<WorkspaceBusy>() {
            return "workspace_busy";
        }
        for cause in error.chain() {
            match cause.to_string().as_str() {
                "The database key file is missing; restore .database-key from the matching backup" => {
                    return "workspace_key_missing";
                }
                "The encrypted database is missing; restore the matching workspace backup" => {
                    return "workspace_database_missing";
                }
                "Invalid database key file; restore its original backup"
                | "Unsupported database key format" => return "workspace_key_invalid",
                _ => {}
            }
        }
    }
    for cause in error.chain() {
        if let Some(error) = cause.downcast_ref::<std::io::Error>() {
            match error.kind() {
                ErrorKind::PermissionDenied if matches!(stage, Stage::Listener) => {
                    return "listener_denied";
                }
                ErrorKind::PermissionDenied => return "workspace_access_denied",
                ErrorKind::AddrInUse if matches!(stage, Stage::Listener) => {
                    return "local_port_in_use";
                }
                _ => {}
            }
        }
    }
    match stage {
        Stage::DataDirectory => "data_directory_unavailable",
        Stage::Workspace => "workspace_unavailable",
        Stage::Listener => "listener_unavailable",
    }
}

fn record(stage: Stage, error: &anyhow::Error) -> String {
    let os_error = error
        .chain()
        .filter_map(|cause| cause.downcast_ref::<std::io::Error>())
        .find_map(std::io::Error::raw_os_error);
    format!(
        "{PREFIX}{}",
        serde_json::json!({"code": code(stage, error), "os_error": os_error})
    )
}

pub fn report(stage: Stage, error: impl Into<anyhow::Error>) -> anyhow::Error {
    let error = error.into();
    eprintln!("{}", record(stage, &error));
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_causes_without_exposing_error_text() {
        let error = anyhow::Error::new(std::io::Error::new(
            ErrorKind::PermissionDenied,
            "private-token-and-workspace-path",
        ))
        .context("private-context");
        assert_eq!(code(Stage::Workspace, &error), "workspace_access_denied");
        assert_eq!(code(Stage::Listener, &error), "listener_denied");
        let line = record(Stage::Workspace, &error);
        assert!(!line.contains("private"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(line.strip_prefix(PREFIX).unwrap()).unwrap(),
            serde_json::json!({"code": "workspace_access_denied", "os_error": null})
        );
    }

    #[test]
    fn distinguishes_workspace_recovery_from_port_conflicts() {
        let key = anyhow::anyhow!(
            "The database key file is missing; restore .database-key from the matching backup"
        );
        assert_eq!(code(Stage::Workspace, &key), "workspace_key_missing");
        let port = anyhow::Error::new(std::io::Error::from(ErrorKind::AddrInUse));
        assert_eq!(code(Stage::Listener, &port), "local_port_in_use");
        assert_eq!(
            code(Stage::DataDirectory, &port),
            "data_directory_unavailable"
        );
    }

    #[test]
    fn unknown_errors_expose_only_the_stage_and_optional_os_code() {
        let error = anyhow::anyhow!("unknown failure with a private secret");
        assert_eq!(code(Stage::Workspace, &error), "workspace_unavailable");
        assert!(!record(Stage::Workspace, &error).contains("private"));
        let error = anyhow::Error::new(std::io::Error::from_raw_os_error(1234));
        assert!(record(Stage::DataDirectory, &error).contains("\"os_error\":1234"));
    }
}
