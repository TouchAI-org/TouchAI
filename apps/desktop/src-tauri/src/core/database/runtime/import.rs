// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 备份导入执行流程。

use std::{fs, path::PathBuf};

use sqlx::{Sqlite, SqlitePool};

use super::super::{
    contract::{execute_sql_artifact_on_connection, DatabaseContractSource},
    protocol::types::{DatabaseImportMode, DatabaseImportRequest},
};

/// 执行数据导入。
pub(crate) async fn run_import_backup(
    pool: SqlitePool,
    database_path: PathBuf,
    database_contract: DatabaseContractSource,
    request: DatabaseImportRequest,
) -> Result<(), String> {
    let source_path = PathBuf::from(&request.source_path);
    if !source_path.is_file() {
        return Err("导入文件不存在或不是有效数据库文件".to_string());
    }

    let current_database_path =
        fs::canonicalize(&database_path).unwrap_or_else(|_| database_path.clone());
    let canonical_source_path = fs::canonicalize(&source_path)
        .map_err(|error| format!("Failed to resolve import path: {error}"))?;
    if canonical_source_path == current_database_path {
        return Err("不能导入当前正在使用的数据库文件".to_string());
    }

    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&pool)
        .await
        .map_err(|error| format!("Failed to checkpoint sqlite WAL before import: {error}"))?;

    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("Failed to acquire sqlite connection for import: {error}"))?;

    attach_import_source(
        &mut connection,
        canonical_source_path.to_string_lossy().into_owned(),
    )
    .await?;
    let import_result = async {
        validate_import_source(&mut connection).await?;
        ensure_import_required_tables(&mut connection).await?;

        sqlx::query("BEGIN EXCLUSIVE")
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to begin import transaction: {error}"))?;

        if let Err(error) = prepare_import_message_parts(&mut connection).await {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            return Err(error);
        }

        let merge_result = match request.mode {
            DatabaseImportMode::ChatOnly => {
                merge_chat_data(&mut connection, &database_contract).await
            }
            DatabaseImportMode::Full => merge_full_data(&mut connection, &database_contract).await,
        };

        if let Err(error) = merge_result {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
            return Err(error);
        }

        sqlx::query("COMMIT")
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to commit import transaction: {error}"))?;

        Ok(())
    }
    .await;

    let detach_result = detach_import_source(&mut connection).await;
    import_result?;
    detach_result
}

async fn attach_import_source(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
    source_path: String,
) -> Result<(), String> {
    let attach_sql = format!(
        "ATTACH DATABASE '{}' AS imported",
        escape_sqlite_string(&source_path)
    );

    sqlx::raw_sql(&attach_sql)
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to attach import database: {error}"))?;

    Ok(())
}

async fn detach_import_source(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
) -> Result<(), String> {
    sqlx::query("DETACH DATABASE imported")
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to detach import database: {error}"))?;
    Ok(())
}

async fn validate_import_source(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
) -> Result<(), String> {
    let meta_table_exists = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM imported.sqlite_master WHERE type = 'table' AND name = 'touchai_meta'",
    )
    .fetch_one(&mut **connection)
    .await
    .map_err(|error| format!("Failed to inspect import database: {error}"))?;

    if meta_table_exists == 0 {
        return Err("该文件不是 TouchAI 数据库".to_string());
    }

    let app_id = sqlx::query_scalar::<_, String>(
        "SELECT value FROM imported.touchai_meta WHERE key = 'app_id' LIMIT 1",
    )
    .fetch_optional(&mut **connection)
    .await
    .map_err(|error| format!("Failed to validate import database meta: {error}"))?;

    if app_id.as_deref() != Some("touchai") {
        return Err("该文件不是 TouchAI 数据库".to_string());
    }

    Ok(())
}

async fn ensure_import_required_tables(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
) -> Result<(), String> {
    const REQUIRED_TABLES: &[&str] = &[
        "providers",
        "models",
        "sessions",
        "messages",
        "attachments",
        "message_attachments",
        "session_turns",
        "session_turn_attempts",
        "llm_metadata",
        "settings",
        "statistics",
        "touchai_meta",
    ];

    for &table in REQUIRED_TABLES {
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM imported.sqlite_master WHERE type = 'table' AND name = ?",
        )
        .bind(table)
        .fetch_one(&mut **connection)
        .await
        .map_err(|error| format!("Failed to inspect import table '{table}': {error}"))?;

        if exists == 0 {
            return Err(format!("导入数据库缺少必需数据表: {table}"));
        }
    }

    Ok(())
}

/// Normalize current and legacy backups into a temporary parts source without
/// modifying the attached backup. The merge contract only reads this one shape.
async fn prepare_import_message_parts(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
) -> Result<(), String> {
    sqlx::raw_sql(
        "DROP TABLE IF EXISTS temp_import_message_parts;
         CREATE TEMP TABLE temp_import_message_parts (
             id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL,
             type TEXT NOT NULL, content TEXT NOT NULL,
             started_at INTEGER, ended_at INTEGER, sort_order INTEGER NOT NULL,
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL
         );",
    )
    .execute(&mut **connection)
    .await
    .map_err(|error| format!("Failed to prepare import parts: {error}"))?;

    let has_parts = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM imported.sqlite_master WHERE type = 'table' AND name = 'message_parts'",
    )
    .fetch_one(&mut **connection)
    .await
    .map_err(|error| format!("Failed to inspect import parts: {error}"))? > 0;

    if has_parts {
        sqlx::query("INSERT INTO temp_import_message_parts SELECT id, message_id, type, content, started_at, ended_at, sort_order, created_at, updated_at FROM imported.message_parts")
            .execute(&mut **connection)
            .await
            .map_err(|error| format!("Failed to load import parts: {error}"))?;
        return Ok(());
    }

    let has_reasoning = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('messages', 'imported') WHERE name = 'reasoning'",
    )
    .fetch_one(&mut **connection)
    .await
    .map_err(|error| format!("Failed to inspect legacy reasoning: {error}"))?
        > 0;
    if has_reasoning {
        sqlx::raw_sql(
            "INSERT INTO temp_import_message_parts (message_id, type, content, sort_order, created_at, updated_at)
             SELECT id, 'reasoning', reasoning, 0, created_at, updated_at FROM imported.messages WHERE coalesce(reasoning, '') <> '';
             INSERT INTO temp_import_message_parts (message_id, type, content, sort_order, created_at, updated_at)
             SELECT id, 'text', content, CASE WHEN coalesce(reasoning, '') <> '' THEN 1 ELSE 0 END, created_at, updated_at FROM imported.messages WHERE content <> '';",
        )
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to normalize legacy import parts: {error}"))?;
    } else {
        sqlx::query(
            "INSERT INTO temp_import_message_parts (message_id, type, content, sort_order, created_at, updated_at)
             SELECT id, 'text', content, 0, created_at, updated_at FROM imported.messages WHERE content <> ''",
        )
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to normalize legacy import text: {error}"))?;
    }
    Ok(())
}

async fn merge_chat_data(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
    database_contract: &DatabaseContractSource,
) -> Result<(), String> {
    execute_sql_artifact_on_connection(
        connection,
        database_contract,
        &["artifacts", "import", "chat_merge.sql"],
    )
    .await
}

async fn merge_full_data(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
    database_contract: &DatabaseContractSource,
) -> Result<(), String> {
    execute_sql_artifact_on_connection(
        connection,
        database_contract,
        &["artifacts", "import", "full_prelude.sql"],
    )
    .await?;
    merge_chat_data(connection, database_contract).await?;
    execute_sql_artifact_on_connection(
        connection,
        database_contract,
        &["artifacts", "import", "full_postlude.sql"],
    )
    .await?;
    Ok(())
}

fn escape_sqlite_string(value: &str) -> String {
    value.replace('\'', "''")
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn import_connection() -> sqlx::pool::PoolConnection<Sqlite> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let mut connection = pool.acquire().await.unwrap();
        sqlx::query("ATTACH DATABASE ':memory:' AS imported")
            .execute(&mut *connection)
            .await
            .unwrap();
        connection
    }

    #[tokio::test]
    async fn normalizes_legacy_reasoning_and_text_without_changing_source() {
        let mut connection = import_connection().await;
        sqlx::raw_sql(
            "CREATE TABLE imported.messages (id INTEGER PRIMARY KEY, content TEXT, reasoning TEXT, created_at TEXT, updated_at TEXT);
             INSERT INTO imported.messages VALUES (7, 'Answer', 'Plan', 'created', 'updated');",
        )
        .execute(&mut *connection)
        .await
        .unwrap();

        // Repreparing on the same pooled connection must not duplicate parts.
        prepare_import_message_parts(&mut connection).await.unwrap();
        prepare_import_message_parts(&mut connection).await.unwrap();
        let parts = sqlx::query_as::<_, (i64, String, String, i64, String, String)>(
            "SELECT message_id, type, content, sort_order, created_at, updated_at FROM temp_import_message_parts ORDER BY sort_order",
        )
        .fetch_all(&mut *connection)
        .await
        .unwrap();
        assert_eq!(
            parts,
            vec![
                (
                    7,
                    "reasoning".into(),
                    "Plan".into(),
                    0,
                    "created".into(),
                    "updated".into()
                ),
                (
                    7,
                    "text".into(),
                    "Answer".into(),
                    1,
                    "created".into(),
                    "updated".into()
                ),
            ]
        );
        let source = sqlx::query_as::<_, (String, String)>(
            "SELECT content, reasoning FROM imported.messages",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        assert_eq!(source, ("Answer".into(), "Plan".into()));
    }

    #[tokio::test]
    async fn normalizes_legacy_text_without_a_reasoning_column() {
        let mut connection = import_connection().await;
        sqlx::raw_sql(
            "CREATE TABLE imported.messages (id INTEGER PRIMARY KEY, content TEXT, created_at TEXT, updated_at TEXT);
             INSERT INTO imported.messages VALUES (7, 'Answer', 'created', 'updated');",
        )
        .execute(&mut *connection)
        .await
        .unwrap();
        prepare_import_message_parts(&mut connection).await.unwrap();
        let part = sqlx::query_as::<_, (String, String, i64)>(
            "SELECT type, content, sort_order FROM temp_import_message_parts",
        )
        .fetch_one(&mut *connection)
        .await
        .unwrap();
        assert_eq!(part, ("text".into(), "Answer".into(), 0));
    }

    #[tokio::test]
    async fn imports_normalized_parts_with_their_wall_clock_boundaries() {
        let mut connection = import_connection().await;
        sqlx::raw_sql(
            "CREATE TABLE imported.message_parts (
                 id INTEGER PRIMARY KEY, message_id INTEGER, type TEXT, content TEXT,
                 started_at INTEGER, ended_at INTEGER, sort_order INTEGER,
                 created_at TEXT, updated_at TEXT
             );
             INSERT INTO imported.message_parts VALUES (3, 7, 'reasoning', 'Plan', 1000, 3400, 0, 'created', 'updated');
             INSERT INTO imported.message_parts VALUES (4, 7, 'text', 'Answer', NULL, NULL, 1, 'created', 'updated');",
        )
        .execute(&mut *connection)
        .await
        .unwrap();
        prepare_import_message_parts(&mut connection).await.unwrap();
        let parts = sqlx::query_as::<_, (String, String, Option<i64>, Option<i64>)>(
            "SELECT type, content, started_at, ended_at FROM temp_import_message_parts ORDER BY sort_order",
        )
        .fetch_all(&mut *connection)
        .await
        .unwrap();
        assert_eq!(
            parts,
            vec![
                ("reasoning".into(), "Plan".into(), Some(1000), Some(3400)),
                ("text".into(), "Answer".into(), None, None),
            ]
        );
    }
}
