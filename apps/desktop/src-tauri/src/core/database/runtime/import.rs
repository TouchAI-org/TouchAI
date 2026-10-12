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

async fn import_table_exists(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
    table: &str,
) -> Result<bool, String> {
    sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM imported.sqlite_master WHERE type = 'table' AND name = ?",
    )
    .bind(table)
    .fetch_one(&mut **connection)
    .await
    .map(|count| count > 0)
    .map_err(|error| format!("Failed to inspect import table '{table}': {error}"))
}

async fn ensure_import_required_tables(
    connection: &mut sqlx::pool::PoolConnection<Sqlite>,
) -> Result<(), String> {
    // These tables exist in every supported backup generation. Tables removed by
    // the message-parts migration are intentionally optional and normalized below.
    const REQUIRED_TABLES: &[&str] = &[
        "providers",
        "models",
        "sessions",
        "messages",
        "attachments",
        "session_turns",
        "session_turn_attempts",
        "llm_metadata",
        "settings",
        "statistics",
        "touchai_meta",
    ];

    for &table in REQUIRED_TABLES {
        if !import_table_exists(connection, table).await? {
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
             type TEXT NOT NULL, content TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
             tool_call_id TEXT, tool_kind TEXT, attachment_id INTEGER,
             started_at INTEGER, ended_at INTEGER, sort_order INTEGER NOT NULL,
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL
         );
         DROP TABLE IF EXISTS temp_import_synthetic_sessions;
         CREATE TEMP TABLE temp_import_synthetic_sessions (
             id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, title TEXT NOT NULL,
             model TEXT NOT NULL, provider_id INTEGER, last_message_preview TEXT,
             last_message_at TEXT, message_count INTEGER NOT NULL, pinned_at TEXT,
             archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
         );
         DROP TABLE IF EXISTS temp_import_synthetic_messages;
         CREATE TEMP TABLE temp_import_synthetic_messages (
             id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL,
             created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
             tool_kind TEXT NOT NULL, legacy_id INTEGER NOT NULL
         );
         DROP TABLE IF EXISTS temp_import_legacy_tool_sources;
         CREATE TEMP TABLE temp_import_legacy_tool_sources (
             tool_kind TEXT NOT NULL, legacy_id INTEGER NOT NULL, message_id INTEGER,
             session_id INTEGER, tool_call_id TEXT NOT NULL, created_at TEXT NOT NULL,
             data TEXT NOT NULL,
             PRIMARY KEY (tool_kind, legacy_id)
         );",
    )
    .execute(&mut **connection)
    .await
    .map_err(|error| format!("Failed to prepare import parts: {error}"))?;

    let has_parts = import_table_exists(connection, "message_parts").await?;
    if has_parts {
        let has_part_metadata = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM pragma_table_info('message_parts', 'imported')
             WHERE name IN ('data', 'tool_call_id', 'tool_kind', 'attachment_id')",
        )
        .fetch_one(&mut **connection)
        .await
        .map_err(|error| format!("Failed to inspect import part metadata: {error}"))?
            == 4;
        if has_part_metadata {
            sqlx::query(
                "INSERT INTO temp_import_message_parts
                 (id, message_id, type, content, data, tool_call_id, tool_kind, attachment_id,
                  started_at, ended_at, sort_order, created_at, updated_at)
                 SELECT id, message_id, type, content, data, tool_call_id, tool_kind, attachment_id,
                        started_at, ended_at, sort_order, created_at, updated_at
                 FROM imported.message_parts",
            )
            .execute(&mut **connection)
            .await
            .map_err(|error| format!("Failed to load import parts: {error}"))?;
        } else {
            sqlx::query(
                "INSERT INTO temp_import_message_parts
                 (id, message_id, type, content, started_at, ended_at, sort_order, created_at, updated_at)
                 SELECT id, message_id, type, content, started_at, ended_at, sort_order, created_at, updated_at
                 FROM imported.message_parts",
            )
            .execute(&mut **connection)
            .await
            .map_err(|error| format!("Failed to load legacy import parts: {error}"))?;
        }
    } else {
        let has_reasoning = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM pragma_table_info('messages', 'imported') WHERE name = 'reasoning'",
        )
        .fetch_one(&mut **connection)
        .await
        .map_err(|error| format!("Failed to inspect legacy reasoning: {error}"))?
            > 0;
        if has_reasoning {
            sqlx::raw_sql(
                "INSERT INTO temp_import_message_parts
                 (message_id, type, content, sort_order, created_at, updated_at)
                 SELECT id, 'reasoning', reasoning, 0, created_at, updated_at
                 FROM imported.messages WHERE coalesce(reasoning, '') <> '';
                 INSERT INTO temp_import_message_parts
                 (message_id, type, content, sort_order, created_at, updated_at)
                 SELECT id, 'text', content,
                        CASE WHEN coalesce(reasoning, '') <> '' THEN 1 ELSE 0 END,
                        created_at, updated_at
                 FROM imported.messages WHERE content <> '';",
            )
            .execute(&mut **connection)
            .await
            .map_err(|error| format!("Failed to normalize legacy import parts: {error}"))?;
        } else {
            sqlx::query(
                "INSERT INTO temp_import_message_parts
                 (message_id, type, content, sort_order, created_at, updated_at)
                 SELECT id, 'text', content, 0, created_at, updated_at
                 FROM imported.messages WHERE content <> ''",
            )
            .execute(&mut **connection)
            .await
            .map_err(|error| format!("Failed to normalize legacy import text: {error}"))?;
        }
    }

    let has_mcp_logs = import_table_exists(connection, "mcp_tool_logs").await?;
    if has_mcp_logs {
        sqlx::query(
            "INSERT INTO temp_import_legacy_tool_sources
             (tool_kind, legacy_id, message_id, session_id, tool_call_id, created_at, data)
             SELECT 'mcp', id, message_id, session_id, tool_call_id, created_at,
                    json_object(
                        'server_id', server_id, 'tool_name', tool_name,
                        'iteration', iteration, 'input', input, 'output', output,
                        'status', status, 'duration_ms', duration_ms,
                        'error_message', error_message
                    )
             FROM imported.mcp_tool_logs",
        )
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to normalize MCP tool logs: {error}"))?;
    }

    let has_builtin_logs = import_table_exists(connection, "built_in_tool_logs").await?;
    if has_builtin_logs {
        sqlx::query(
            "INSERT INTO temp_import_legacy_tool_sources
             (tool_kind, legacy_id, message_id, session_id, tool_call_id, created_at, data)
             SELECT 'builtin', id, message_id, session_id, tool_call_id, created_at,
                    json_object(
                        'tool_id', tool_id, 'iteration', iteration,
                        'input', input, 'output', output, 'status', status,
                        'approval_state', approval_state,
                        'approval_summary', approval_summary,
                        'duration_ms', duration_ms, 'error_message', error_message,
                        'conversation_semantic_json', conversation_semantic_json
                    )
             FROM imported.built_in_tool_logs",
        )
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to normalize built-in tool logs: {error}"))?;
    }

    let has_legacy_refs = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pragma_table_info('messages', 'imported')
         WHERE name IN ('role', 'tool_log_id', 'tool_log_kind')",
    )
    .fetch_one(&mut **connection)
    .await
    .map_err(|error| format!("Failed to inspect legacy tool references: {error}"))?
        == 3;
    if has_legacy_refs {
        sqlx::raw_sql(
            "UPDATE temp_import_legacy_tool_sources
             SET message_id = (
                 SELECT MIN(messages.id) FROM imported.messages AS messages
                 WHERE messages.role <> 'tool_result'
                   AND messages.tool_log_id = temp_import_legacy_tool_sources.legacy_id
                   AND messages.tool_log_kind = temp_import_legacy_tool_sources.tool_kind
             ) WHERE message_id IS NULL;
             DROP TABLE IF EXISTS temp_import_legacy_tool_results;
             CREATE TEMP TABLE temp_import_legacy_tool_results AS
             SELECT messages.id AS message_id,
                    CASE WHEN COUNT(sources.legacy_id) = 1 THEN MAX(sources.tool_call_id) END AS tool_call_id,
                    CASE WHEN COUNT(sources.legacy_id) = 1 THEN MAX(sources.tool_kind) END AS tool_kind
             FROM imported.messages AS messages
             LEFT JOIN temp_import_legacy_tool_sources AS sources
               ON sources.legacy_id = messages.tool_log_id
              AND (sources.tool_kind = messages.tool_log_kind OR messages.tool_log_kind IS NULL)
             WHERE messages.role = 'tool_result'
             GROUP BY messages.id;
             UPDATE temp_import_message_parts
             SET type = 'tool_result',
                 tool_call_id = (SELECT tool_call_id FROM temp_import_legacy_tool_results WHERE message_id = temp_import_message_parts.message_id),
                 tool_kind = (SELECT tool_kind FROM temp_import_legacy_tool_results WHERE message_id = temp_import_message_parts.message_id)
             WHERE type = 'text' AND message_id IN (SELECT message_id FROM temp_import_legacy_tool_results);
             INSERT INTO temp_import_message_parts
             (message_id, type, content, tool_call_id, tool_kind, sort_order, created_at, updated_at)
             SELECT results.message_id, 'tool_result', '', results.tool_call_id, results.tool_kind,
                    coalesce((SELECT max(sort_order) + 1 FROM temp_import_message_parts WHERE message_id = results.message_id), 0),
                    messages.created_at, messages.updated_at
             FROM temp_import_legacy_tool_results AS results
             JOIN imported.messages AS messages ON messages.id = results.message_id
             WHERE NOT EXISTS (SELECT 1 FROM temp_import_message_parts WHERE message_id = results.message_id AND type = 'tool_result');
             DROP TABLE temp_import_legacy_tool_results;",
        )
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to normalize legacy tool results: {error}"))?;
    }

    // A legacy log can outlive its message after a crash. Keep it visible by
    // giving it a synthetic message; null session IDs go to one import archive.
    sqlx::raw_sql(
        "INSERT INTO temp_import_synthetic_sessions
         (id, session_id, title, model, provider_id, last_message_preview,
          last_message_at, message_count, pinned_at, archived_at, created_at, updated_at)
         SELECT -1, '__import-orphan-tools__', 'Imported tool activity', 'migration',
                NULL, NULL, NULL, 0, NULL, datetime('now'), datetime('now'), datetime('now')
         WHERE EXISTS (
             SELECT 1 FROM temp_import_legacy_tool_sources WHERE message_id IS NULL AND session_id IS NULL
         );
         INSERT INTO temp_import_synthetic_messages
         (id, session_id, role, created_at, updated_at, tool_kind, legacy_id)
         SELECT
             -ROW_NUMBER() OVER (ORDER BY tool_kind, legacy_id),
             coalesce(session_id, -1), 'tool_call', created_at, created_at,
             tool_kind, legacy_id
         FROM temp_import_legacy_tool_sources
         WHERE message_id IS NULL;
         INSERT INTO temp_import_message_parts
         (message_id, type, content, data, tool_call_id, tool_kind,
          sort_order, created_at, updated_at)
         SELECT
             coalesce(source.message_id, synthetic.id), 'tool_call', '', source.data,
             source.tool_call_id, source.tool_kind,
             coalesce((
                 SELECT max(existing.sort_order) + 1
                 FROM temp_import_message_parts AS existing
                 WHERE existing.message_id = coalesce(source.message_id, synthetic.id)
             ), 0) + row_number() OVER (
                 PARTITION BY coalesce(source.message_id, synthetic.id)
                 ORDER BY source.created_at, source.tool_kind, source.legacy_id
             ) - 1,
             source.created_at, source.created_at
         FROM temp_import_legacy_tool_sources AS source
         LEFT JOIN temp_import_synthetic_messages AS synthetic
           ON synthetic.tool_kind = source.tool_kind AND synthetic.legacy_id = source.legacy_id
         WHERE NOT EXISTS (
             SELECT 1 FROM temp_import_message_parts AS existing
             WHERE existing.message_id = coalesce(source.message_id, synthetic.id)
               AND existing.type = 'tool_call'
               AND existing.tool_call_id = source.tool_call_id
               AND existing.tool_kind = source.tool_kind
         );",
    )
    .execute(&mut **connection)
    .await
    .map_err(|error| format!("Failed to normalize legacy tool logs: {error}"))?;

    let has_legacy_attachments = import_table_exists(connection, "message_attachments").await?;
    if has_legacy_attachments {
        sqlx::query(
            "INSERT INTO temp_import_message_parts
             (message_id, type, content, data, attachment_id, sort_order, created_at, updated_at)
             SELECT source.message_id, 'attachment', '',
                    json_object('originPath', source.origin_path), source.attachment_id,
                    coalesce((SELECT max(existing.sort_order) + 1
                              FROM temp_import_message_parts AS existing
                              WHERE existing.message_id = source.message_id), 0)
                    + row_number() OVER (
                        PARTITION BY source.message_id
                        ORDER BY source.sort_order, source.id
                    ) - 1,
                    source.created_at, source.created_at
             FROM imported.message_attachments AS source
             WHERE NOT EXISTS (
                 SELECT 1 FROM temp_import_message_parts AS existing
                 WHERE existing.message_id = source.message_id
                   AND existing.type = 'attachment'
                   AND existing.attachment_id = source.attachment_id
             )",
        )
        .execute(&mut **connection)
        .await
        .map_err(|error| format!("Failed to normalize legacy import attachments: {error}"))?;
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
    async fn normalizes_legacy_tool_results_with_call_identity_including_empty_results() {
        let mut connection = import_connection().await;
        sqlx::raw_sql(
            "CREATE TABLE imported.messages (
                 id INTEGER PRIMARY KEY, role TEXT, content TEXT, tool_log_id INTEGER,
                 tool_log_kind TEXT, created_at TEXT, updated_at TEXT
             );
             INSERT INTO imported.messages VALUES
                 (1, 'tool_call', '', 1, 'mcp', 'created', 'updated'),
                 (2, 'tool_result', 'Result', 1, 'mcp', 'created', 'updated'),
                 (3, 'tool_call', '', 2, 'mcp', 'created', 'updated'),
                 (4, 'tool_result', '', 2, NULL, 'created', 'updated');
             CREATE TABLE imported.mcp_tool_logs (
                 id INTEGER PRIMARY KEY, message_id INTEGER, session_id INTEGER,
                 tool_call_id TEXT, created_at TEXT, server_id INTEGER, tool_name TEXT,
                 iteration INTEGER, input TEXT, output TEXT, status TEXT,
                 duration_ms INTEGER, error_message TEXT
             );
             INSERT INTO imported.mcp_tool_logs VALUES
                 (1, 1, 1, 'call-1', 'created', 1, 'tool', 0, '{}', 'Result', 'completed', 42, NULL),
                 (2, NULL, 1, 'call-2', 'created', 1, 'tool', 0, '{}', '', 'completed', 42, NULL);",
        )
        .execute(&mut *connection).await.unwrap();
        prepare_import_message_parts(&mut connection).await.unwrap();
        let parts = sqlx::query_as::<_, (i64, String, Option<String>, Option<String>)>(
            "SELECT message_id, content, tool_call_id, tool_kind FROM temp_import_message_parts
             WHERE type = 'tool_result' ORDER BY message_id",
        )
        .fetch_all(&mut *connection)
        .await
        .unwrap();
        assert_eq!(
            parts,
            vec![
                (
                    2,
                    "Result".into(),
                    Some("call-1".into()),
                    Some("mcp".into())
                ),
                (4, "".into(), Some("call-2".into()), Some("mcp".into())),
            ]
        );
        let call_parent = sqlx::query_scalar::<_, i64>(
            "SELECT message_id FROM temp_import_message_parts WHERE type = 'tool_call' AND tool_call_id = 'call-2'",
        ).fetch_one(&mut *connection).await.unwrap();
        assert_eq!(call_parent, 3);
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
