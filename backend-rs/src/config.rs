/// Netrix Backend — Application configuration.
///
/// Settings are resolved from environment variables, the app data directory,
/// and auto-generated secrets that are persisted per installation.
use std::fs;
use std::io::{self, Write};
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use rand::RngCore;

#[cfg(not(test))]
const APP_DATA_ENV: &str = "NETRIX_DATA_DIR";
#[cfg(all(windows, not(test)))]
const APP_IDENTIFIER: &str = "com.netrix.app";

// ─── App Data Directory ─────────────────────────────────────────────

#[cfg(not(test))]
fn resolve_app_data_dir() -> io::Result<PathBuf> {
    // Production: use system app data dir.
    // Development: use `./data` next to the binary.
    #[cfg(windows)]
    let base = {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| dirs_next())
    };

    #[cfg(not(windows))]
    let base = {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                PathBuf::from(home).join(".local/share")
            })
    };

    // Check if running from a dev environment (not a bundled binary).
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()));

    let data_dir = if std::env::var("NETRIX_DEV").is_ok() {
        // Development mode — use local data folder.
        exe_dir.unwrap_or_else(|| PathBuf::from(".")).join("data")
    } else if let Some(configured) =
        std::env::var_os(APP_DATA_ENV).filter(|value| !value.is_empty())
    {
        // Tauri resolves this from its bundle identifier and passes it to the
        // sidecar, keeping backend data aligned with installer uninstall data.
        PathBuf::from(configured)
    } else {
        #[cfg(windows)]
        {
            base.join(APP_IDENTIFIER)
        }
        #[cfg(not(windows))]
        {
            base.join("Netrix")
        }
    };

    fs::create_dir_all(&data_dir)?;
    Ok(data_dir)
}

// Unit tests must be safe even when cargo is invoked directly, with inherited
// production or development environment variables. Integration fixtures install
// their own process profile before first accessing SETTINGS (tests/common).
#[cfg(test)]
fn resolve_app_data_dir() -> io::Result<PathBuf> {
    let directory =
        std::env::temp_dir().join(format!("netrix-unit-tests-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&directory)?;
    Ok(directory)
}

#[cfg(all(windows, not(test)))]
fn dirs_next() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:\\".into());
    PathBuf::from(home).join("AppData").join("Roaming")
}

fn get_or_create_secret(data_dir: &Path, filename: &str, byte_len: usize) -> io::Result<String> {
    let secret_path = data_dir.join(filename);
    match fs::read_to_string(&secret_path) {
        Ok(content) => {
            let value = content.trim();
            if hex::decode(value).is_ok_and(|bytes| bytes.len() == byte_len) {
                return Ok(value.to_string());
            }
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Invalid {filename}; restore the original app data backup"),
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if filename == ".vault_salt" && data_dir.join("database.db").exists() {
        return Err(io::Error::new(io::ErrorKind::NotFound, "Vault salt is missing beside an existing database; restore the matching .vault_salt backup"));
    }
    let mut buf = vec![0u8; byte_len];
    rand::thread_rng().fill_bytes(&mut buf);
    let hex_str = hex::encode(&buf);
    let temporary = data_dir.join(format!(".{filename}.{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(hex_str.as_bytes())?;
        file.sync_all()?;
        drop(file);
        // Publish only a complete file, and never overwrite an existing identity.
        match fs::hard_link(&temporary, &secret_path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return get_or_create_secret(data_dir, filename, byte_len);
            }
            Err(error) => return Err(error),
        }
        #[cfg(unix)]
        fs::File::open(data_dir)?.sync_all()?;
        Ok(hex_str)
    })();
    let _ = fs::remove_file(temporary);
    result
}

// ─── Settings ───────────────────────────────────────────────────────

pub struct SettingsProvider(LazyLock<io::Result<Settings>>);
pub static SETTINGS: SettingsProvider = SettingsProvider(LazyLock::new(Settings::new));

impl SettingsProvider {
    pub fn initialize(&self) -> io::Result<&Settings> {
        self.0
            .as_ref()
            .map_err(|error| io::Error::new(error.kind(), error.to_string()))
    }
}

impl Deref for SettingsProvider {
    type Target = Settings;
    fn deref(&self) -> &Self::Target {
        self.initialize()
            .unwrap_or_else(|error| panic!("Cannot initialize Netrix data: {error}"))
    }
}

#[allow(dead_code)]
pub struct Settings {
    pub project_name: String,
    pub app_data_dir: PathBuf,
    pub database_path: PathBuf,
    pub database_url: String,

    // Security
    pub secret_key: String,
    pub algorithm: String,
    pub access_token_expire_minutes: u32,

    // Vault / Crypto (Argon2id)
    pub vault_salt: Vec<u8>,
    pub argon2_time_cost: u32,
    pub argon2_memory_cost: u32,
    pub argon2_parallelism: u32,

    // SSH
    pub ssh_known_hosts_policy: String,
}

impl Settings {
    fn new() -> io::Result<Self> {
        let app_data_dir = resolve_app_data_dir()?;
        let database_path = app_data_dir.join("database.db");
        let database_url = format!("sqlite:{}?mode=rwc", database_path.display());

        let secret_key = get_or_create_secret(&app_data_dir, ".secret_key", 64)?;
        let vault_salt_hex = get_or_create_secret(&app_data_dir, ".vault_salt", 32)?;
        let vault_salt = hex::decode(&vault_salt_hex)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;

        let ssh_policy =
            std::env::var("SSH_KNOWN_HOSTS_POLICY").unwrap_or_else(|_| "strict".into());

        Ok(Self {
            project_name: "Netrix".into(),
            app_data_dir,
            database_path,
            database_url,
            secret_key,
            algorithm: "HS256".into(),
            access_token_expire_minutes: 30,
            vault_salt,
            argon2_time_cost: 3,
            argon2_memory_cost: 65536,
            argon2_parallelism: 4,
            ssh_known_hosts_policy: ssh_policy,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_test_settings_use_a_temporary_identity() {
        let directory = &SETTINGS.app_data_dir;
        assert_eq!(directory.parent(), Some(std::env::temp_dir().as_path()));
        assert!(directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("netrix-unit-tests-"));
        assert!(directory.join(".vault_salt").is_file());
        assert!(directory.join(".secret_key").is_file());
    }
    #[test]
    fn identity_is_stable_and_corrupt_or_missing_salt_is_never_replaced() {
        let dir = std::env::temp_dir().join(format!("netrix-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let salt = get_or_create_secret(&dir, ".vault_salt", 32).unwrap();
        assert_eq!(get_or_create_secret(&dir, ".vault_salt", 32).unwrap(), salt);
        fs::write(dir.join(".vault_salt"), "damaged").unwrap();
        assert!(get_or_create_secret(&dir, ".vault_salt", 32).is_err());
        assert_eq!(
            fs::read_to_string(dir.join(".vault_salt")).unwrap(),
            "damaged"
        );
        fs::remove_file(dir.join(".vault_salt")).unwrap();
        fs::write(dir.join("database.db"), b"existing database").unwrap();
        assert!(get_or_create_secret(&dir, ".vault_salt", 32).is_err());
        assert!(!dir.join(".vault_salt").exists());
        assert_eq!(dir.parent(), Some(std::env::temp_dir().as_path()));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn identity_write_errors_are_propagated() {
        let missing = std::env::temp_dir().join(format!("netrix-missing-{}", uuid::Uuid::new_v4()));
        assert!(get_or_create_secret(&missing, ".vault_salt", 32).is_err());
    }
}
