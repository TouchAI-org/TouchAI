// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库契约与 SQL 工件执行。

mod seed;

use std::{
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
use tauri::Manager;

pub(crate) use seed::apply_seed;

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
    migration_dir: &Path,
) -> Result<(), String> {
    ensure_migrations_table(pool).await?;

    let journal_path = migration_dir.join("meta").join("_journal.json");
    let journal = fs::read_to_string(&journal_path).map_err(|error| {
        format!(
            "Failed to read migration journal '{}': {error}",
            journal_path.display()
        )
    })?;
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

        let migration_path = migration_dir.join(format!("{tag}.sql"));
        let migration_sql = fs::read_to_string(&migration_path).map_err(|error| {
            format!(
                "Failed to read migration file '{}': {error}",
                migration_path.display()
            )
        })?;
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
    artifacts_dir: &Path,
) -> Result<(), String> {
    execute_sql_artifact_on_pool(pool, artifacts_dir, &["runtime", "guards.sql"]).await
}

/// 解析数据库目录。
pub(crate) fn resolve_database_contract_directory(app: &tauri::App) -> Result<PathBuf, String> {
    let resource_root = match app.path().resource_dir() {
        Ok(path) => Some(path),
        Err(error) if cfg!(debug_assertions) => None,
        Err(error) => return Err(format!("Failed to resolve resource dir: {error}")),
    };
    let project_root = if cfg!(debug_assertions) {
        Some(resolve_project_root_from_exe()?)
    } else {
        None
    };

    select_database_contract_directory(
        resource_root.as_deref(),
        project_root.as_deref(),
        cfg!(debug_assertions),
    )
}

fn select_database_contract_directory(
    resource_root: Option<&Path>,
    project_root: Option<&Path>,
    allow_project_fallback: bool,
) -> Result<PathBuf, String> {
    let resource_dir = resource_root.map(|path| path.join("src").join("database"));
    if let Some(path) = resource_dir.as_ref().filter(|path| path.exists()) {
        return Ok(path.clone());
    }

    let project_dir = project_root.map(|path| path.join("src").join("database"));
    if allow_project_fallback {
        if let Some(path) = project_dir.as_ref().filter(|path| path.exists()) {
            return Ok(path.clone());
        }
    }

    let mut attempts = Vec::new();
    if let Some(path) = resource_dir {
        attempts.push(format!("resource '{}'", path.display()));
    }
    if let Some(path) = project_dir {
        attempts.push(format!("project '{}'", path.display()));
    }
    if attempts.is_empty() {
        attempts.push("no candidate directories".to_string());
    }

    Err(format!(
        "Failed to resolve database contract directory. Checked {}.",
        attempts.join(" and ")
    ))
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

/// 从统一数据库目录读取 SQL 工件。
pub(crate) fn read_sql_artifact(
    database_contract_dir: &Path,
    segments: &[&str],
) -> Result<String, String> {
    let path = segments
        .iter()
        .fold(database_contract_dir.to_path_buf(), |path, segment| {
            path.join(segment)
        });

    fs::read_to_string(&path).map_err(|error| {
        format!(
            "Failed to read database artifact '{}': {error}",
            path.display()
        )
    })
}

/// 在连接池上执行一个完整 SQL 工件，适合初始化场景。
pub(crate) async fn execute_sql_artifact_on_pool(
    pool: &Pool<Sqlite>,
    database_contract_dir: &Path,
    segments: &[&str],
) -> Result<(), String> {
    let sql = read_sql_artifact(database_contract_dir, segments)?;
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
    database_contract_dir: &Path,
    segments: &[&str],
) -> Result<(), String> {
    let sql = read_sql_artifact(database_contract_dir, segments)?;
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
    fn prefers_packaged_resource_directory_in_debug_builds() {
        let workspace = create_temp_workspace("resource-first");
        let resource_root = workspace.join("resource");
        let project_root = workspace.join("project");

        create_database_contract(&resource_root);
        create_database_contract(&project_root);

        let resolved = select_database_contract_directory(
            Some(resource_root.as_path()),
            Some(project_root.as_path()),
            true,
        )
        .unwrap();

        assert_eq!(resolved, resource_root.join("src").join("database"));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn falls_back_to_project_directory_when_debug_resource_is_missing() {
        let workspace = create_temp_workspace("project-fallback");
        let resource_root = workspace.join("resource");
        let project_root = workspace.join("project");

        create_database_contract(&project_root);

        let resolved = select_database_contract_directory(
            Some(resource_root.as_path()),
            Some(project_root.as_path()),
            true,
        )
        .unwrap();

        assert_eq!(resolved, project_root.join("src").join("database"));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn release_build_requires_packaged_resource_directory() {
        let workspace = create_temp_workspace("resource-required");
        let resource_root = workspace.join("resource");
        let project_root = workspace.join("project");

        create_database_contract(&project_root);

        let error = select_database_contract_directory(
            Some(resource_root.as_path()),
            Some(project_root.as_path()),
            false,
        )
        .unwrap_err();

        assert!(error.contains("resource"));
        let _ = fs::remove_dir_all(workspace);
    }

    fn create_database_contract(root: &Path) {
        fs::create_dir_all(
            root.join("src")
                .join("database")
                .join("drizzle")
                .join("meta"),
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
