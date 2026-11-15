/// Unit tests for the Vault module — encrypt/decrypt round-trip,
/// key derivation, and vault lifecycle.
mod common;
#[cfg(test)]
mod vault_tests {
    use netrix_backend::vault;
    use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn sqlite_sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
        let mut path: OsString = database_path.as_os_str().to_owned();
        path.push(suffix);
        PathBuf::from(path)
    }

    fn file_contains(path: &Path, needle: &[u8]) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|window| window == needle))
            .unwrap_or(false)
    }

    #[test]
    fn test_derive_key_deterministic() {
        crate::common::init();
        let key1 = vault::derive_key("test-password").expect("derive_key should succeed");
        let key2 = vault::derive_key("test-password").expect("derive_key should succeed");
        assert_eq!(key1, key2, "Same password must produce the same key");
    }

    #[test]
    fn test_derive_key_different_passwords() {
        crate::common::init();
        let key1 = vault::derive_key("password-a").expect("derive");
        let key2 = vault::derive_key("password-b").expect("derive");
        assert_ne!(
            key1, key2,
            "Different passwords must produce different keys"
        );
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        crate::common::init();
        let key = vault::derive_key("my-secret").expect("derive");
        let plaintext = b"Hello Netrix Vault!";

        let ciphertext = vault::encrypt(plaintext, &key).expect("encrypt");
        assert_ne!(
            &ciphertext[12..],
            plaintext,
            "Ciphertext must differ from plaintext"
        );
        assert!(
            ciphertext.len() > 12 + plaintext.len(),
            "Ciphertext must be larger (nonce + tag)"
        );

        let decrypted = vault::decrypt(&ciphertext, &key).expect("decrypt");
        assert_eq!(decrypted, plaintext, "Decrypted text must match original");
    }

    #[test]
    fn test_encrypt_produces_different_ciphertexts() {
        crate::common::init();
        let key = vault::derive_key("test").expect("derive");
        let plaintext = b"same-data";

        let ct1 = vault::encrypt(plaintext, &key).expect("encrypt 1");
        let ct2 = vault::encrypt(plaintext, &key).expect("encrypt 2");
        assert_ne!(ct1, ct2, "Repeated encryption must use different nonces");
    }

    #[test]
    fn test_decrypt_with_wrong_key_fails() {
        crate::common::init();
        let key1 = vault::derive_key("correct-password").expect("derive");
        let key2 = vault::derive_key("wrong-password").expect("derive");
        let plaintext = b"secret data";

        let ciphertext = vault::encrypt(plaintext, &key1).expect("encrypt");
        let result = vault::decrypt(&ciphertext, &key2);
        assert!(result.is_err(), "Decryption with wrong key must fail");
    }

    #[test]
    fn test_decrypt_tampered_ciphertext_fails() {
        crate::common::init();
        let key = vault::derive_key("test").expect("derive");
        let plaintext = b"sensitive";

        let mut ciphertext = vault::encrypt(plaintext, &key).expect("encrypt");
        // Flip a byte in the ciphertext portion.
        if ciphertext.len() > 15 {
            ciphertext[15] ^= 0xFF;
        }

        let result = vault::decrypt(&ciphertext, &key);
        assert!(result.is_err(), "Tampered ciphertext must fail decryption");
    }

    #[test]
    fn test_decrypt_short_payload_fails() {
        crate::common::init();
        let key = vault::derive_key("test").expect("derive");
        let short = vec![0u8; 5]; // Less than 12-byte nonce.
        let result = vault::decrypt(&short, &key);
        assert!(result.is_err(), "Payload shorter than nonce must fail");
    }

    #[test]
    fn test_encrypt_empty_plaintext() {
        crate::common::init();
        let key = vault::derive_key("test").expect("derive");
        let ciphertext = vault::encrypt(b"", &key).expect("encrypt empty");
        let decrypted = vault::decrypt(&ciphertext, &key).expect("decrypt empty");
        assert!(
            decrypted.is_empty(),
            "Decrypted empty plaintext must be empty"
        );
    }

    #[test]
    fn test_encrypt_large_plaintext() {
        crate::common::init();
        let key = vault::derive_key("test").expect("derive");
        let large = vec![0xAB_u8; 100_000];
        let ciphertext = vault::encrypt(&large, &key).expect("encrypt large");
        let decrypted = vault::decrypt(&ciphertext, &key).expect("decrypt large");
        assert_eq!(decrypted, large, "Large plaintext round-trip must succeed");
    }

    #[tokio::test]
    async fn test_legacy_upgrade_scrubs_database_and_wal_plaintext() {
        crate::common::init();
        let database_path =
            std::env::temp_dir().join(format!("netrix-legacy-upgrade-{}.db", uuid::Uuid::new_v4()));
        let wal_path = sqlite_sidecar_path(&database_path, "-wal");
        let shm_path = sqlite_sidecar_path(&database_path, "-shm");
        let options = SqliteConnectOptions::new()
            .filename(&database_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .pragma("wal_autocheckpoint", "0")
            .pragma("secure_delete", "ON");
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("connect legacy database");

        sqlx::raw_sql(include_str!("../migrations/001_initial_schema.sql"))
            .execute(&pool)
            .await
            .expect("create legacy schema");

        let marker = format!(
            "legacy-plaintext-marker-{}-{}",
            uuid::Uuid::new_v4(),
            "x".repeat(1024)
        );
        sqlx::query(
            r#"INSERT INTO hosts
               (name, hostname, port, username, connection_type, password, private_key)
               VALUES (?, ?, ?, ?, ?, ?, ?)"#,
        )
        .bind("legacy-disk-host")
        .bind("legacy.example")
        .bind(22_i64)
        .bind("admin")
        .bind("ssh")
        .bind(&marker)
        .bind(&marker)
        .execute(&pool)
        .await
        .expect("insert legacy plaintext");

        assert!(
            file_contains(&database_path, marker.as_bytes())
                || file_contains(&wal_path, marker.as_bytes()),
            "test setup must persist the plaintext marker before upgrade"
        );

        let state = vault::new_vault();
        let outcome = vault::unlock(&state, &pool, "LegacyDiskUpgrade123!")
            .await
            .expect("unlock and migrate legacy credentials");
        assert_eq!(outcome.migrated_legacy_hosts, 1);

        let migrated: (Option<i64>, Option<String>, Option<String>) =
            sqlx::query_as("SELECT credential_id, password, private_key FROM hosts WHERE name = ?")
                .bind("legacy-disk-host")
                .fetch_one(&pool)
                .await
                .expect("read migrated host");
        assert!(migrated.0.is_some());
        assert_eq!(migrated.1, None);
        assert_eq!(migrated.2, None);

        pool.close().await;

        for path in [&database_path, &wal_path, &shm_path] {
            assert!(
                !file_contains(path, marker.as_bytes()),
                "legacy plaintext remained in {}",
                path.display()
            );
        }

        for path in [&database_path, &wal_path, &shm_path] {
            if path.exists() {
                std::fs::remove_file(path).expect("remove temporary SQLite file");
            }
        }
    }
}
