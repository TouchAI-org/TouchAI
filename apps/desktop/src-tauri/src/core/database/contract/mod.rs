// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库契约与 SQL 工件执行。

mod embedded;
mod seed;

use std::{
    borrow::Cow,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous},
    Pool, Sqlite, SqlitePool,
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

    pub(crate) fn from_root(root: PathBuf) -> Result<Self, String> {
        if is_database_contract_directory(&root) {
            return Ok(Self::Filesystem { root });
        }

        Err(format!(
            "Failed to resolve database contract directory. Checked '{}'.",
            root.display()
        ))
    }

    pub(crate) fn resolve(_app: &tauri::App) -> Result<Self, String> {
        if cfg!(debug_assertions) {
            return Self::from_root(resolve_project_database_contract_root()?);
        }

        Ok(Self::embedded())
    }

    pub(crate) fn read_text(&self, segments: &[&str]) -> Result<Cow<'static, str>, String> {
        match self {
            Self::Embedded => embedded::read_text(segments)
                .map(Cow::Owned)
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
    connection: &mut sqlx::SqliteConnection,
    database_contract: &DatabaseContractSource,
) -> Result<(), String> {
    ensure_migrations_table(connection).await?;

    let journal = database_contract.read_text(&["drizzle", "meta", "_journal.json"])?;
    let journal_json: serde_json::Value = serde_json::from_str(&journal)
        .map_err(|error| format!("Invalid migration journal: {error}"))?;
    let entries = journal_json
        .get("entries")
        .and_then(|value| value.as_array())
        .ok_or_else(|| "Migration journal entries are missing".to_string())?;

    let applied_tags = sqlx::query_scalar::<_, String>("SELECT hash FROM migrations ORDER BY id")
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| format!("Failed to load applied migrations: {error}"))?;
    // Only the declared migration chain is supported. Experimental/future histories
    // must not be guessed from columns or silently treated as a released schema.
    for (index, applied_tag) in applied_tags.iter().enumerate() {
        if entries
            .get(index)
            .and_then(|entry| entry.get("tag"))
            .and_then(|tag| tag.as_str())
            != Some(applied_tag.as_str())
        {
            return Err(format!(
                "不支持的数据库迁移历史：{applied_tag}。请使用对应版本处理该数据库。"
            ));
        }
    }

    for entry in entries.iter().skip(applied_tags.len()) {
        let Some(tag) = entry.get("tag").and_then(|value| value.as_str()) else {
            return Err("Migration journal entry tag is missing".to_string());
        };
        let migration_file = format!("{tag}.sql");
        let migration_sql = database_contract.read_text(&["drizzle", migration_file.as_str()])?;
        let statements = migration_sql
            .split("--> statement-breakpoint")
            .map(str::trim)
            .filter(|statement| !statement.is_empty())
            .collect::<Vec<_>>();

        let mut transaction = sqlx::Connection::begin(&mut *connection)
            .await
            .map_err(|error| format!("Failed to begin migration '{tag}': {error}"))?;

        for statement in statements {
            sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("Failed to execute migration '{tag}': {error}"))?;
        }

        sqlx::query("INSERT INTO migrations (hash, created_at) VALUES (?, ?)")
            .bind(tag)
            .bind(now_millis())
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to record migration '{tag}': {error}"))?;

        transaction
            .commit()
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

fn resolve_project_database_contract_root() -> Result<PathBuf, String> {
    Ok(resolve_project_root()?.join("src").join("database"))
}

fn resolve_project_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
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
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(pool)
        .await
        .map_err(|error| {
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
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
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

async fn ensure_migrations_table(connection: &mut sqlx::SqliteConnection) -> Result<(), String> {
    sqlx::raw_sql(
        "CREATE TABLE IF NOT EXISTS migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )
    .execute(connection)
    .await
    .map_err(|error| format!("Failed to ensure migrations table: {error}"))?;
    Ok(())
}
