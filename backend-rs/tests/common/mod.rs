//! Install one isolated identity per integration-test process, before LazyLock.
//! Every fixture that can reach SETTINGS must call this before constructing state.
use std::{path::PathBuf, sync::OnceLock};

pub fn init() -> &'static PathBuf {
    static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
    DIRECTORY.get_or_init(|| {
        let directory =
            std::env::temp_dir().join(format!("netrix-integration-tests-{}", uuid::Uuid::new_v4()));
        std::env::remove_var("NETRIX_DEV");
        std::env::set_var("NETRIX_DATA_DIR", &directory);
        let settings = netrix_backend::config::SETTINGS
            .initialize()
            .expect("isolated test settings");
        assert_eq!(
            settings.app_data_dir, directory,
            "SETTINGS was accessed before the test fixture"
        );
        directory
    })
}

#[test]
fn default_test_settings_use_a_temporary_identity() {
    let directory = init();
    assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
    assert!(directory
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("netrix-integration-tests-"));
    assert!(directory.join(".vault_salt").is_file());
    assert!(directory.join(".secret_key").is_file());
}
