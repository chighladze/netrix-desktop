/// Database layer - SQLx connection pool and versioned migrations.
use sqlx::{Pool, Sqlite, Transaction};
use tracing::{info, warn};

pub type Db = Pool<Sqlite>;

/// Migration entry - every SQL file in `migrations/` must appear here.
#[derive(Clone, Copy)]
struct Migration {
    version: u32,
    name: &'static str,
    file_name: &'static str,
    sql: &'static str,
}

macro_rules! migration {
    ($version:literal, $name:literal, $file_name:literal) => {
        Migration {
            version: $version,
            name: $name,
            file_name: $file_name,
            sql: include_str!(concat!("../migrations/", $file_name)),
        }
    };
}

const MIGRATIONS: &[Migration] = &[
    migration!(1, "initial_schema", "001_initial_schema.sql"),
    migration!(2, "add_group_index", "002_add_group_index.sql"),
    migration!(3, "add_host_capabilities", "003_add_host_capabilities.sql"),
    migration!(
        4,
        "add_local_shell_fields",
        "004_add_local_shell_fields.sql"
    ),
    migration!(5, "ssh_tunnels", "005_ssh_tunnels.sql"),
    migration!(6, "host_revisions", "006_host_revisions.sql"),
    migration!(7, "terminal_colors", "007_terminal_colors.sql"),
    migration!(8, "terminal_appearance", "008_terminal_appearance.sql"),
];

const LOCAL_HOST_COLUMNS: &[(&str, &str)] = &[
    (
        "local_command",
        "ALTER TABLE hosts ADD COLUMN local_command TEXT",
    ),
    ("local_args", "ALTER TABLE hosts ADD COLUMN local_args TEXT"),
    ("local_cwd", "ALTER TABLE hosts ADD COLUMN local_cwd TEXT"),
];

async fn ensure_migrations_table(pool: &Db) -> anyhow::Result<()> {
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS _migrations (
            version     INTEGER PRIMARY KEY,
            name        TEXT    NOT NULL,
            applied_at  TEXT    DEFAULT (datetime('now'))
        )"#,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Run embedded versioned migrations.
///
/// Each migration script and its `_migrations` marker commit atomically.
pub(crate) async fn run_migrations(pool: &Db) -> anyhow::Result<()> {
    ensure_migrations_table(pool).await?;

    for migration in MIGRATIONS {
        let applied: Option<(i64,)> =
            sqlx::query_as("SELECT version FROM _migrations WHERE version = ?")
                .bind(migration.version as i64)
                .fetch_optional(pool)
                .await?;

        if applied.is_some() {
            continue;
        }

        info!(
            "[Migration] Applying v{}: {} ({})",
            migration.version, migration.name, migration.file_name
        );
        apply_unapplied_migration(pool, migration).await?;
        info!("[Migration] v{} applied successfully", migration.version);
    }

    // Older builds could write a marker after only part of migration 004.
    // Keep this narrowly-scoped compatibility repair transactional too.
    ensure_hosts_columns(pool).await?;

    info!(
        "Database schema up to date (latest: v{}).",
        MIGRATIONS
            .last()
            .map(|migration| migration.version)
            .unwrap_or(0)
    );
    Ok(())
}

/// Apply both the SQL and its bookkeeping marker in one SQLite transaction.
/// `raw_sql` is intentional: migration files are trusted embedded input and
/// can contain multiple statements whose semicolons application code must not
/// attempt to parse.
async fn apply_unapplied_migration(pool: &Db, migration: &Migration) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    if let Err(error) = apply_migration_sql(&mut tx, migration).await {
        tx.rollback().await.ok();
        return Err(anyhow::anyhow!(
            "Migration v{} failed: {}",
            migration.version,
            error
        ));
    }

    if let Err(error) = sqlx::query("INSERT INTO _migrations (version, name) VALUES (?, ?)")
        .bind(migration.version as i64)
        .bind(migration.name)
        .execute(&mut *tx)
        .await
    {
        tx.rollback().await.ok();
        return Err(anyhow::anyhow!(
            "Migration v{} bookkeeping failed: {}",
            migration.version,
            error
        ));
    }

    tx.commit().await?;
    Ok(())
}

async fn apply_migration_sql(
    tx: &mut Transaction<'_, Sqlite>,
    migration: &Migration,
) -> Result<(), sqlx::Error> {
    // Old runners committed each ALTER separately. Repair the two historical
    // ALTER migrations if a crash left schema changes without a marker.
    if migration.version == 2 && host_column_exists(tx, "group_index").await? {
        sqlx::raw_sql(
            r#"CREATE INDEX IF NOT EXISTS idx_hosts_group_index
               ON hosts("group", group_index)"#,
        )
        .execute(&mut **tx)
        .await?;
        return Ok(());
    }

    if migration.version == 4 {
        let existing = host_column_names(tx).await?;
        if LOCAL_HOST_COLUMNS
            .iter()
            .any(|(column, _)| existing.contains(*column))
        {
            ensure_host_columns(tx, LOCAL_HOST_COLUMNS).await?;
            return Ok(());
        }
    }

    sqlx::raw_sql(migration.sql).execute(&mut **tx).await?;
    Ok(())
}

async fn host_column_names(
    tx: &mut Transaction<'_, Sqlite>,
) -> Result<std::collections::HashSet<String>, sqlx::Error> {
    let rows: Vec<(i64, String, String, i64, Option<String>, i64)> =
        sqlx::query_as("PRAGMA table_info(hosts)")
            .fetch_all(&mut **tx)
            .await?;
    Ok(rows.into_iter().map(|row| row.1).collect())
}

async fn host_column_exists(
    tx: &mut Transaction<'_, Sqlite>,
    column: &str,
) -> Result<bool, sqlx::Error> {
    Ok(host_column_names(tx).await?.contains(column))
}

async fn ensure_host_columns(
    tx: &mut Transaction<'_, Sqlite>,
    expected: &[(&str, &str)],
) -> Result<(), sqlx::Error> {
    let existing = host_column_names(tx).await?;
    for (column, statement) in expected {
        if existing.contains(*column) {
            continue;
        }
        sqlx::raw_sql(statement).execute(&mut **tx).await?;
    }
    Ok(())
}

/// Ensure every column referenced by the `Host` model exists. This only
/// repairs the known historical partial-migration state.
async fn ensure_hosts_columns(pool: &Db) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    let existing = host_column_names(&mut tx).await?;
    for (column, _) in LOCAL_HOST_COLUMNS {
        if !existing.contains(*column) {
            warn!(
                "[Migration] Repairing hosts schema: missing column `{}`",
                column
            );
        }
    }
    ensure_host_columns(&mut tx, LOCAL_HOST_COLUMNS).await?;
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::collections::BTreeSet;
    use std::ffi::OsStr;

    #[test]
    fn every_sql_migration_is_registered_once() {
        let migration_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
        let files_on_disk: BTreeSet<String> = std::fs::read_dir(migration_dir)
            .expect("read migrations directory")
            .map(|entry| entry.expect("read migration entry").path())
            .filter(|path| path.extension() == Some(OsStr::new("sql")))
            .map(|path| {
                path.file_name()
                    .expect("migration file name")
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        let registered: BTreeSet<String> = MIGRATIONS
            .iter()
            .map(|migration| migration.file_name.to_owned())
            .collect();

        assert_eq!(
            registered.len(),
            MIGRATIONS.len(),
            "duplicate registry entry"
        );
        assert_eq!(registered, files_on_disk, "migration registry drift");

        let mut previous_version = 0;
        for migration in MIGRATIONS {
            assert!(
                migration.version > previous_version,
                "versions must increase"
            );
            assert_eq!(
                migration.file_name,
                format!("{:03}_{}.sql", migration.version, migration.name)
            );
            previous_version = migration.version;
        }
    }

    #[tokio::test]
    async fn registered_migrations_apply_from_scratch_and_are_idempotent() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect test database");

        run_migrations(&pool).await.expect("apply migrations");
        run_migrations(&pool).await.expect("recheck migrations");

        let marker_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM _migrations")
            .fetch_one(&pool)
            .await
            .expect("count migration markers");
        assert_eq!(marker_count.0, MIGRATIONS.len() as i64);

        let columns: BTreeSet<String> = sqlx::query_as::<
            _,
            (i64, String, String, i64, Option<String>, i64),
        >("PRAGMA table_info(hosts)")
        .fetch_all(&pool)
        .await
        .expect("read hosts columns")
        .into_iter()
        .map(|row| row.1)
        .collect();
        for expected in [
            "group_index",
            "local_command",
            "local_args",
            "local_cwd",
            "revision",
            "terminal_background",
            "terminal_appearance",
            "terminal_foreground",
        ] {
            assert!(columns.contains(expected), "missing hosts.{expected}");
        }
    }

    #[tokio::test]
    async fn terminal_appearance_upgrade_preserves_existing_hosts() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("test database");
        ensure_migrations_table(&pool)
            .await
            .expect("migration table");
        for migration in MIGRATIONS.iter().filter(|migration| migration.version < 8) {
            apply_unapplied_migration(&pool, migration)
                .await
                .expect("legacy schema");
        }
        sqlx::query("INSERT INTO hosts(name,hostname,terminal_theme,terminal_background) VALUES('existing','example.test','nord','#112233')")
            .execute(&pool).await.expect("legacy host");
        run_migrations(&pool).await.expect("upgrade colors");
        run_migrations(&pool).await.expect("repeat upgrade");
        let row: (String, Option<String>, Option<String>, Option<String>) = sqlx::query_as(
            "SELECT name,terminal_theme,terminal_background,terminal_appearance FROM hosts",
        )
        .fetch_one(&pool)
        .await
        .expect("read existing host");
        assert_eq!(
            row,
            (
                "existing".into(),
                Some("nord".into()),
                Some("#112233".into()),
                None
            )
        );
    }

    #[tokio::test]
    async fn failed_migration_rolls_back_schema_and_marker() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect test database");
        ensure_migrations_table(&pool)
            .await
            .expect("create migration table");

        let migration = Migration {
            version: 999,
            name: "atomic_failure_probe",
            file_name: "999_atomic_failure_probe.sql",
            sql: "CREATE TABLE atomic_probe (id INTEGER); THIS IS NOT VALID SQL;",
        };
        let error = apply_unapplied_migration(&pool, &migration)
            .await
            .expect_err("migration should fail");
        assert!(error.to_string().contains("Migration v999 failed"));

        let schema_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'atomic_probe'",
        )
        .fetch_one(&pool)
        .await
        .expect("inspect schema");
        let marker_count: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM _migrations WHERE version = 999")
                .fetch_one(&pool)
                .await
                .expect("inspect migration marker");

        assert_eq!(schema_count.0, 0);
        assert_eq!(marker_count.0, 0);
    }
}
