fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_backend_port",
            "get_api_token",
            "get_backend_status",
            "get_problem_report_diagnostics",
            "open_problem_report",
            "read_vault_password",
            "save_vault_password",
            "remove_vault_password",
            "quit_app",
            "close_terminal_window",
            "wait_terminal_drag_release",
            "cancel_terminal_drag",
            "terminal_dock_target",
            "open_terminal_window",
            "watch_sftp_save_access",
            "finish_sftp_save_access",
        ]),
    ))
    .expect("failed to build Tauri application metadata");
}
