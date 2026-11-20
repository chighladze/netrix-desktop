//! Fixed-scope remembered Vault password. Only the main webview has these commands.
//! Credentials stay in Windows Credential Manager; callers cannot choose an entry.

use zeroize::Zeroizing;

#[cfg(any(windows, test))]
fn service_name(identifier: &str) -> String {
    format!("{identifier}.vault")
}

#[cfg(windows)]
mod native {
    use keyring::{Entry, Error};
    use std::sync::Mutex;

    static ACCESS: Mutex<()> = Mutex::new(());
    pub fn with_entry<T>(
        identifier: &str,
        operation: impl FnOnce(&Entry) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = ACCESS
            .lock()
            .map_err(|_| "Credential storage is unavailable")?;
        let entry = Entry::new(&super::service_name(identifier), "master")
            .map_err(|_| "Could not open credential storage")?;
        operation(&entry)
    }

    pub fn read(entry: &Entry) -> Result<Option<String>, String> {
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(Error::NoEntry) => Ok(None),
            Err(_) => Err("Could not read remembered Vault password".into()),
        }
    }

    pub fn save(entry: &Entry, password: &str) -> Result<(), String> {
        if password.is_empty() {
            return Err("Cannot remember an empty Vault password".into());
        }
        entry
            .set_password(password)
            .map_err(|_| "Could not save remembered Vault password".into())
    }

    pub fn remove(entry: &Entry) -> Result<(), String> {
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(_) => Err("Could not remove remembered Vault password".into()),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn isolated_windows_credential_roundtrip() {
            let service = format!("com.netrix.app.validation.{}", uuid::Uuid::new_v4());
            let entry = Entry::new(&service, "test-only").unwrap();
            struct Cleanup(Entry);
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    let _ = self.0.delete_credential();
                }
            }
            let entry = Cleanup(entry);
            assert_eq!(read(&entry.0).unwrap(), None);
            assert!(save(&entry.0, "").is_err());
            save(
                &entry.0,
                "isolated-credential-\u{043f}\u{0430}\u{0440}\u{043e}\u{043b}\u{044c}",
            )
            .unwrap();
            assert_eq!(
                read(&entry.0).unwrap().as_deref(),
                Some("isolated-credential-\u{043f}\u{0430}\u{0440}\u{043e}\u{043b}\u{044c}")
            );
            save(&entry.0, "replaced-test-password").unwrap();
            assert_eq!(
                read(&entry.0).unwrap().as_deref(),
                Some("replaced-test-password")
            );
            remove(&entry.0).unwrap();
            remove(&entry.0).unwrap();
            assert_eq!(read(&entry.0).unwrap(), None);
        }
    }
}

#[tauri::command]
pub async fn read_vault_password(_app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let identifier = _app.config().identifier.clone();
        if identifier.starts_with(crate::portable::PREFIX) {
            return Ok(None);
        }
        tauri::async_runtime::spawn_blocking(move || native::with_entry(&identifier, native::read))
            .await
            .map_err(|_| "Credential storage task failed".to_string())?
    }
    #[cfg(not(windows))]
    Err("Remembered Vault passwords are currently supported on Windows only".into())
}

#[tauri::command]
pub async fn save_vault_password(_app: tauri::AppHandle, password: String) -> Result<(), String> {
    let password = Zeroizing::new(password);
    #[cfg(windows)]
    {
        let identifier = _app.config().identifier.clone();
        if identifier.starts_with(crate::portable::PREFIX) {
            return Err("Enter the Vault password manually in Netrix Portable".into());
        }
        tauri::async_runtime::spawn_blocking(move || {
            native::with_entry(&identifier, |entry| native::save(entry, &password))
        })
        .await
        .map_err(|_| "Credential storage task failed".to_string())?
    }
    #[cfg(not(windows))]
    {
        drop(password);
        Err("Remembered Vault passwords are currently supported on Windows only".into())
    }
}

#[tauri::command]
pub async fn remove_vault_password(_app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        let identifier = _app.config().identifier.clone();
        if identifier.starts_with(crate::portable::PREFIX) {
            return Ok(());
        }
        tauri::async_runtime::spawn_blocking(move || {
            native::with_entry(&identifier, native::remove)
        })
        .await
        .map_err(|_| "Credential storage task failed".to_string())?
    }
    #[cfg(not(windows))]
    Err("Remembered Vault passwords are currently supported on Windows only".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn app_identifiers_have_separate_credential_namespaces() {
        assert_eq!(
            super::service_name("com.netrix.app"),
            "com.netrix.app.vault"
        );
        assert_ne!(
            super::service_name("com.netrix.e2e.test"),
            super::service_name("com.netrix.app")
        );
    }
    #[test]
    fn remembered_password_commands_belong_only_to_the_main_capability() {
        let main: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = main["permissions"].as_array().unwrap();
        assert_eq!(main["windows"], serde_json::json!(["main"]));
        for permission in [
            "allow-read-vault-password",
            "allow-save-vault-password",
            "allow-remove-vault-password",
        ] {
            assert!(permissions.contains(&serde_json::json!(permission)));
            for source in [
                include_str!("../capabilities/detached-terminal.json"),
                include_str!("../capabilities/detached-map.json"),
            ] {
                assert!(!source.contains(permission));
            }
        }
    }
}
