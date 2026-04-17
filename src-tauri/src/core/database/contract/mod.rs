// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库契约与 SQL 工件执行。

mod embedded;
mod seed;

use std::{
    borrow::Cow,
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Pool, Row, Sqlite, SqlitePool,
};

pub(crate) use seed::apply_seed;

#[derive(Clone, Debug)]
pub(crate) enum DatabaseContractSource {
    Embedded,
    Filesystem { root: PathBuf },
}

impl DatabaseContractSource {
    pub(crate) fn embedded() -> Self {
        Self::Embedded
    }

    pub(crate) fn resolve(_app: &tauri::App) -> Result<Self, String> {
        if cfg!(debug_assertions) {
            let project_root = resolve_project_root_from_exe()?;
            return select_database_contract_source(Some(project_root.as_path()), true);
        }

        Ok(Self::embedded())
    }

    pub(crate) fn read_text(&self, segments: &[&str]) -> Result<Cow<'static, str>, String> {
        match self {
            Self::Embedded => embedded::read_text(segments)
                .map(Cow::Borrowed)
                .ok_or_else(|| {
                    format!(
                        "Embedded database asset '{}' is missing",
                        logical_database_asset_path(segments)
                    )
                }),
            Self::Filesystem { root } => {
                let path = segments
                    .iter()
                    .fold(root.clone(), |path, segment| path.join(segment));
                let contents = fs::read_to_string(&path).map_err(|error| {
                    format!(
                        "Failed to read database asset '{}': {error}",
                        path.display()
                    )
                })?;
                Ok(Cow::Owned(contents))
            }
        }
    }
}

/// 解析当前构建应使用的数据库契约来源。
pub(crate) fn resolve_database_contract(
    app: &tauri::App,
) -> Result<DatabaseContractSource, String> {
    DatabaseContractSource::resolve(app)
}

fn select_database_contract_source(
    project_root: Option<&Path>,
    use_project_contract: bool,
) -> Result<DatabaseContractSource, String> {
    if !use_project_contract {
        return Ok(DatabaseContractSource::embedded());
    }

    let path = project_root
        .map(|path| path.join("src").join("database"))
        .ok_or_else(|| "Failed to resolve project database contract directory.".to_string())?;

    if is_database_contract_directory(&path) {
        return Ok(DatabaseContractSource::Filesystem { root: path });
    }

    Err(format!(
        "Failed to resolve project database contract directory. Checked project '{}'.",
        path.display()
    ))
}

fn logical_database_asset_path(segments: &[&str]) -> String {
    segments.join("/")
}

/// 创建应用共享的 SQLite 连接池。
pub(crate) async fn create_sqlite_pool(path: &Path) -> Result<SqlitePool, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create database directory: {error}"))?;
    }

    let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))
        .map_err(|error| format!("Failed to create sqlite connect options: {error}"))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));

    SqlitePoolOptions::new()
        .max_connections(8)
        .min_connections(1)
        .connect_with(options)
        .await
        .map_err(|error| format!("Failed to connect sqlite pool: {error}"))
}

/// 执行 Drizzle 迁移工件。
pub(crate) async fn migrate_database(
    pool: &Pool<Sqlite>,
    database_contract: &DatabaseContractSource,
) -> Result<(), String> {
    ensure_migrations_table(pool).await?;

    let journal = database_contract.read_text(&["drizzle", "meta", "_journal.json"])?;
    let journal_json: serde_json::Value = serde_json::from_str(&journal)
        .map_err(|error| format!("Invalid migration journal: {error}"))?;
    let entries = journal_json
        .get("entries")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Migration journal entries are missing".to_string())?;

    let applied_rows = sqlx::query("SELECT hash FROM migrations")
        .fetch_all(pool)
        .await
        .map_err(|error| format!("Failed to load applied migrations: {error}"))?;
    let applied_hashes = applied_rows
        .into_iter()
        .filter_map(|row| row.try_get::<String, _>("hash").ok())
        .collect::<HashSet<_>>();

    for entry in entries {
        let Some(tag) = entry.get("tag").and_then(|value| value.as_str()) else {
            return Err("Migration journal entry tag is missing".to_string());
        };
        if applied_hashes.contains(tag) {
            continue;
        }

        let migration_file = format!("{tag}.sql");
        let migration_sql = database_contract.read_text(&["drizzle", migration_file.as_str()])?;
        let statements = migration_sql
            .split("--> statement-breakpoint")
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
            .collect::<Vec<_>>();

        let mut connection = pool
            .acquire()
            .await
            .map_err(|error| format!("Failed to acquire migration connection: {error}"))?;

        sqlx::query("BEGIN")
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to begin migration '{tag}': {error}"))?;

        let mut failed: Option<String> = None;
        for statement in statements {
            if let Err(error) = sqlx::raw_sql(statement).execute(&mut *connection).await {
                failed = Some(format!("Failed to execute migration '{tag}': {error}"));
                break;
            }
        }

        if let Some(error) = failed {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            return Err(error);
        }

        sqlx::query("INSERT INTO migrations (hash, created_at) VALUES (?, ?)")
            .bind(tag)
            .bind(now_millis())
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to record migration '{tag}': {error}"))?;

        sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to commit migration '{tag}': {error}"))?;
    }

    Ok(())
}

/// 运行时保护规则来自数据库工件，而不是 Rust 内嵌业务 SQL。
pub(crate) async fn ensure_runtime_guards(
    pool: &Pool<Sqlite>,
    database_contract: &DatabaseContractSource,
) -> Result<(), String> {
    execute_sql_artifact_on_pool(
        pool,
        database_contract,
        &["artifacts", "runtime", "guards.sql"],
    )
    .await
}

fn is_database_contract_directory(path: &Path) -> bool {
    path.join("drizzle").is_dir() && path.join("artifacts").is_dir()
}

fn resolve_project_root_from_exe() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|error| format!("Failed to resolve current exe: {error}"))?
        .parent()
        .ok_or_else(|| "Failed to resolve executable directory".to_string())?
        .to_path_buf();

    exe_dir
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(Path::to_path_buf)
        .ok_or_else(|| "Failed to resolve project database contract directory".to_string())
}

/// 从统一数据库契约来源读取 SQL 工件。
pub(crate) fn read_sql_artifact(
    database_contract: &DatabaseContractSource,
    segments: &[&str],
) -> Result<String, String> {
    database_contract.read_text(segments).map(Cow::into_owned)
}

/// 在连接池上执行一个完整 SQL 工件，适合初始化场景。
pub(crate) async fn execute_sql_artifact_on_pool(
    pool: &Pool<Sqlite>,
    database_contract: &DatabaseContractSource,
    segments: &[&str],
) -> Result<(), String> {
    let sql = read_sql_artifact(database_contract, segments)?;
    sqlx::raw_sql(&sql).execute(pool).await.map_err(|error| {
        format!(
            "Failed to execute database artifact '{:?}': {error}",
            segments
        )
    })?;
    Ok(())
}

/// 在已有连接上执行 SQL 工件，适合导入等需要共享事务上下文的流程。
pub(crate) async fn execute_sql_artifact_on_connection(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
    database_contract: &DatabaseContractSource,
    segments: &[&str],
) -> Result<(), String> {
    let sql = read_sql_artifact(database_contract, segments)?;
    sqlx::raw_sql(&sql)
        .execute(&mut **connection)
        .await
        .map_err(|error| {
            format!(
                "Failed to execute database artifact '{:?}': {error}",
                segments
            )
        })?;
    Ok(())
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

async fn ensure_migrations_table(pool: &Pool<Sqlite>) -> Result<(), String> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )
    .execute(pool)
    .await
    .map_err(|error| format!("Failed to ensure migrations table: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn debug_build_uses_project_database_contract_directory() {
        let workspace = create_temp_workspace("project-contract");
        let project_root = workspace.join("project");

        create_database_contract(&project_root, "-- debug seed");

        let contract = select_database_contract_source(Some(project_root.as_path()), true).unwrap();
        let seed_sql = contract
            .read_text(&["artifacts", "runtime", "seed.sql"])
            .unwrap();

        assert_eq!(seed_sql, "-- debug seed");
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn release_build_embeds_every_runtime_database_asset() {
        let contract = DatabaseContractSource::embedded();

        let journal = contract
            .read_text(&["drizzle", "meta", "_journal.json"])
            .unwrap();
        let journal_json: serde_json::Value = serde_json::from_str(&journal).unwrap();
        let entries = journal_json["entries"].as_array().unwrap();
        assert!(!entries.is_empty());

        for entry in entries {
            let tag = entry["tag"].as_str().unwrap();
            let migration_file = format!("{tag}.sql");
            let migration_sql = contract
                .read_text(&["drizzle", migration_file.as_str()])
                .unwrap();
            assert!(
                !migration_sql.trim().is_empty(),
                "missing migration for {tag}"
            );
        }

        for segments in [
            ["artifacts", "runtime", "guards.sql"],
            ["artifacts", "runtime", "seed.sql"],
            ["artifacts", "import", "chat_merge.sql"],
            ["artifacts", "import", "full_prelude.sql"],
            ["artifacts", "import", "full_postlude.sql"],
        ] {
            let sql = contract.read_text(&segments).unwrap();
            assert!(
                !sql.trim().is_empty(),
                "embedded asset should not be empty: {:?}",
                segments
            );
        }
    }

    fn create_database_contract(root: &Path, seed_sql: &str) {
        create_database_contract_at(root, seed_sql);
    }

    fn create_database_contract_at(root: &Path, seed_sql: &str) {
        fs::create_dir_all(
            root.join("src")
                .join("database")
                .join("drizzle")
                .join("meta"),
        )
        .unwrap();
        fs::create_dir_all(
            root.join("src")
                .join("database")
                .join("artifacts")
                .join("runtime"),
        )
        .unwrap();
        fs::create_dir_all(
            root.join("src")
                .join("database")
                .join("artifacts")
                .join("import"),
        )
        .unwrap();
        fs::write(
            root.join("src")
                .join("database")
                .join("drizzle")
                .join("meta")
                .join("_journal.json"),
            r#"{"entries":[{"tag":"0000_debug"}]}"#,
        )
        .unwrap();
        fs::write(
            root.join("src")
                .join("database")
                .join("drizzle")
                .join("0000_debug.sql"),
            "-- debug migration",
        )
        .unwrap();
        fs::write(
            root.join("src")
                .join("database")
                .join("artifacts")
                .join("runtime")
                .join("seed.sql"),
            seed_sql,
        )
        .unwrap();
    }

    fn create_temp_workspace(label: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("touchai-db-contract-{label}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
