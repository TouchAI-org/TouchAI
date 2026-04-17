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
