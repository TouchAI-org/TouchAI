// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 备份先通过统一迁移升级，再按当前数据库契约合并。

use std::{fs, path::PathBuf};

use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection, SqlitePool};

use super::super::{
    contract::{execute_sql_artifact_on_connection, migrate_database, DatabaseContractSource},
    protocol::types::{DatabaseImportMode, DatabaseImportRequest},
};

/// 原备份只读；所有升级只发生在临时副本，导入不猜测旧字段或中间格式。
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
    let source_path = fs::canonicalize(&source_path)
        .map_err(|error| format!("Failed to resolve import path: {error}"))?;
    let current_path = fs::canonicalize(&database_path).unwrap_or(database_path.clone());
    if source_path == current_path {
        return Err("不能导入当前正在使用的数据库文件".to_string());
    }

    let snapshot =
        prepare_import_database(&source_path, &database_path, &database_contract).await?;
    let snapshot_path = snapshot.path().join("touchai.db");
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("Failed to acquire sqlite connection for import: {error}"))?;
    sqlx::query("ATTACH DATABASE ? AS imported")
        .bind(snapshot_path.to_string_lossy().as_ref())
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Failed to attach import database: {error}"))?;

    let import_result = async {
        sqlx::query("BEGIN EXCLUSIVE")
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to begin import transaction: {error}"))?;
        let merge_result: Result<(), String> = async {
            // Local rowids cannot disambiguate duplicate semantic identities across databases.
            let ambiguous = sqlx::query_scalar::<_, i64>(
                "SELECT EXISTS (
                    SELECT 1 FROM imported.providers GROUP BY name, driver HAVING count(*) > 1
                    UNION ALL
                    SELECT 1 FROM main.providers GROUP BY name, driver HAVING count(*) > 1
                    UNION ALL
                    SELECT 1 FROM imported.models GROUP BY provider_id, model_id HAVING count(*) > 1
                    UNION ALL
                    SELECT 1 FROM main.models GROUP BY provider_id, model_id HAVING count(*) > 1
                )",
            )
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| format!("Failed to validate import identities: {error}"))?;
            if ambiguous != 0 {
                return Err(
                    "数据库存在重复的供应商或模型标识，无法安全导入；请先消除重复项".to_string(),
                );
            }
            if matches!(request.mode, DatabaseImportMode::Full) {
                execute_sql_artifact_on_connection(
                    &mut connection,
                    &database_contract,
                    &["artifacts", "import", "full_prelude.sql"],
                )
                .await?;
            }
            execute_sql_artifact_on_connection(
                &mut connection,
                &database_contract,
                &["artifacts", "import", "chat_merge.sql"],
            )
            .await?;
            sqlx::query("COMMIT")
                .execute(&mut *connection)
                .await
                .map_err(|error| format!("Failed to commit import transaction: {error}"))?;
            Ok(())
        }
        .await;
        if merge_result.is_err() {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
        }
        merge_result
    }
    .await;
    let detach_result = sqlx::query("DETACH DATABASE imported")
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Failed to detach import database: {error}"));
    // Do not return a connection with a still-attached temporary database to the pool.
    if detach_result.is_err() {
        let _ = connection.close().await;
    }
    import_result?;
    detach_result?;
    Ok(())
}

async fn prepare_import_database(
    source_path: &std::path::Path,
    database_path: &std::path::Path,
    database_contract: &DatabaseContractSource,
) -> Result<tempfile::TempDir, String> {
    let snapshot = tempfile::tempdir_in(database_path.parent().ok_or("数据库路径没有父目录")?)
        .map_err(|error| format!("Failed to create import workspace: {error}"))?;
    let snapshot_path = snapshot.path().join("touchai.db");
    let mut source = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(source_path)
            .read_only(true),
    )
    .await
    .map_err(|error| format!("Failed to open import database: {error}"))?;
    let copy_result = async {
        let has_meta = sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'touchai_meta'",
        )
        .fetch_one(&mut source)
        .await
        .map_err(|error| format!("Failed to inspect import database: {error}"))?;
        if has_meta == 0 {
            return Err("该文件不是 TouchAI 数据库".to_string());
        }
        let app_id =
            sqlx::query_scalar::<_, String>("SELECT value FROM touchai_meta WHERE key = 'app_id'")
                .fetch_optional(&mut source)
                .await
                .map_err(|error| format!("Failed to validate import database: {error}"))?;
        if app_id.as_deref() != Some("touchai") {
            return Err("该文件不是 TouchAI 数据库".to_string());
        }
        // SQLite takes a consistent snapshot including committed WAL data.
        sqlx::query("VACUUM INTO ?")
            .bind(snapshot_path.to_string_lossy().as_ref())
            .execute(&mut source)
            .await
            .map_err(|error| format!("Failed to snapshot import database: {error}"))?;
        Ok(())
    }
    .await;
    let close_result = source.close().await;
    copy_result?;
    close_result.map_err(|error| format!("Failed to close import source: {error}"))?;

    let mut upgraded =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&snapshot_path))
            .await
            .map_err(|error| format!("Failed to open import snapshot: {error}"))?;
    let upgrade_result = async {
        migrate_database(&mut upgraded, database_contract).await?;
        if !sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&mut upgraded)
            .await
            .map_err(|error| format!("Failed to validate upgraded database: {error}"))?
            .is_empty()
        {
            return Err("导入数据库存在无效的外键引用".to_string());
        }
        Ok(())
    }
    .await;
    let close_result = upgraded.close().await;
    upgrade_result?;
    close_result.map_err(|error| format!("Failed to close import snapshot: {error}"))?;
    // The imported snapshot never carries another install's analytics identity,
    // consent or queued events into this database. Local analytics state is kept.
    super::analytics_snapshot::sanitize_analytics_snapshot(&snapshot_path).await?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::database::contract::{create_sqlite_pool, migrate_database};

    fn contract() -> DatabaseContractSource {
        DatabaseContractSource::from_root(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("src/database"),
        )
        .unwrap()
    }

    async fn backup(path: &std::path::Path, entry_count: usize) -> SqlitePool {
        let pool = create_sqlite_pool(path).await.unwrap();
        let contract = contract();
        let journal: serde_json::Value = serde_json::from_str(
            &contract
                .read_text(&["drizzle", "meta", "_journal.json"])
                .unwrap(),
        )
        .unwrap();
        sqlx::raw_sql("CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL)")
            .execute(&pool).await.unwrap();
        let mut connection = pool.acquire().await.unwrap();
        for entry in journal["entries"]
            .as_array()
            .unwrap()
            .iter()
            .take(entry_count)
        {
            let tag = entry["tag"].as_str().unwrap();
            let sql = contract
                .read_text(&["drizzle", &format!("{tag}.sql")])
                .unwrap();
            for statement in sql
                .split("--> statement-breakpoint")
                .filter(|s| !s.trim().is_empty())
            {
                sqlx::raw_sql(sqlx::AssertSqlSafe(statement))
                    .execute(&mut *connection)
                    .await
                    .unwrap();
            }
            sqlx::query("INSERT INTO migrations (hash, created_at) VALUES (?, 0)")
                .bind(tag)
                .execute(&mut *connection)
                .await
                .unwrap();
        }
        drop(connection);
        sqlx::query("INSERT INTO touchai_meta (key, value) VALUES ('app_id', 'touchai')")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[tokio::test]
    async fn upgrades_released_backup_before_import_without_modifying_source() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.db");
        let source = backup(&source_path, 4).await;
        sqlx::raw_sql(
            "INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'old-chat', 'Old', 'test');
             INSERT INTO messages (id, session_id, role, content, reasoning) VALUES (1, 1, 'assistant', 'Answer', 'Plan');
             INSERT INTO attachments (id, hash, type, original_name, origin_path) VALUES (1, 'file-hash', 'file', 'test.txt', '/test');
             INSERT INTO message_attachments (message_id, attachment_id, sort_order, origin_path) VALUES (1, 1, 0, '/test');
             INSERT INTO built_in_tool_logs (tool_call_id, tool_id, input, session_id, message_id) VALUES ('call-1', 'bash', '{}', 1, 1);"
        ).execute(&source).await.unwrap();
        let target_path = root.path().join("target.db");
        let target = create_sqlite_pool(&target_path).await.unwrap();
        migrate_database(&mut *target.acquire().await.unwrap(), &contract())
            .await
            .unwrap();
        sqlx::raw_sql("INSERT INTO sessions (id, session_id, title, model) VALUES (99, 'watermark', 'Temp', 'test');
             INSERT INTO messages (id, session_id, role) VALUES (100, 99, 'user');
             DELETE FROM messages WHERE id = 100;
             DELETE FROM sessions WHERE id = 99;")
            .execute(&target).await.unwrap();
        for mode in [DatabaseImportMode::ChatOnly, DatabaseImportMode::Full] {
            run_import_backup(
                target.clone(),
                target_path.clone(),
                contract(),
                DatabaseImportRequest {
                    source_path: source_path.to_string_lossy().into_owned(),
                    mode,
                },
            )
            .await
            .unwrap();
        }
        let parts: Vec<(String, String)> =
            sqlx::query_as("SELECT type, content FROM message_parts ORDER BY sort_order, id")
                .fetch_all(&target)
                .await
                .unwrap();
        assert!(parts.contains(&("text".into(), "Answer".into())));
        assert!(parts.contains(&("reasoning".into(), "Plan".into())));
        assert!(parts.iter().any(|part| part.0 == "tool_call"));
        assert!(parts.iter().any(|part| part.0 == "attachment"));
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM messages")
                .fetch_one(&target)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM message_search_fts WHERE message_search_fts MATCH 'Ans'"
            )
            .fetch_one(&target)
            .await
            .unwrap(),
            1
        );
        assert!(sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&target)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT content FROM messages")
                .fetch_one(&source)
                .await
                .unwrap(),
            "Answer"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM migrations")
                .fetch_one(&source)
                .await
                .unwrap(),
            4
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT id FROM messages")
                .fetch_one(&target)
                .await
                .unwrap(),
            101
        );
        let imported_session = sqlx::query_scalar::<_, i64>("SELECT id FROM sessions")
            .fetch_one(&target)
            .await
            .unwrap();
        let next_id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO messages (session_id, role) VALUES (?, 'user') RETURNING id",
        )
        .bind(imported_session)
        .fetch_one(&target)
        .await
        .unwrap();
        assert_eq!(next_id, 102);
        // The source pool stays open above: data still in its WAL must be included.
        source.close().await;
        target.close().await;
    }

    #[tokio::test]
    async fn rejects_experimental_migration_history_without_changing_target() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.db");
        let source = backup(&source_path, 5).await;
        sqlx::query(
            "INSERT INTO migrations (hash, created_at) VALUES ('0005_experimental_parts', 0)",
        )
        .execute(&source)
        .await
        .unwrap();
        let target_path = root.path().join("target.db");
        let target = create_sqlite_pool(&target_path).await.unwrap();
        migrate_database(&mut *target.acquire().await.unwrap(), &contract())
            .await
            .unwrap();
        let error = run_import_backup(
            target.clone(),
            target_path,
            contract(),
            DatabaseImportRequest {
                source_path: source_path.to_string_lossy().into_owned(),
                mode: DatabaseImportMode::ChatOnly,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("0005_experimental_parts"), "{error}");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions")
                .fetch_one(&target)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM migrations")
                .fetch_one(&source)
                .await
                .unwrap(),
            6
        );
        source.close().await;
        target.close().await;
    }
    #[tokio::test]
    async fn rejects_non_prefix_migration_histories() {
        for invalid_history in [
            "DELETE FROM migrations WHERE id=2",
            "UPDATE migrations SET hash=CASE id WHEN 1 THEN '0001_silent_reasoning' WHEN 2 THEN '0000_lyrical_toad' ELSE hash END",
            "INSERT INTO migrations (hash, created_at) VALUES ('0004_ordinary_solo', 0)",
        ] {
            let root = tempfile::tempdir().unwrap();
            let source_path = root.path().join("source.db");
            let source = backup(&source_path, 5).await;
            sqlx::raw_sql(invalid_history).execute(&source).await.unwrap();
            let error = prepare_import_database(&source_path, &root.path().join("target.db"), &contract())
                .await.unwrap_err();
            assert!(error.contains("不支持的数据库迁移历史"), "{error}");
            // The failed snapshot and its WAL files are removed even on Windows.
            let leftovers = fs::read_dir(root.path()).unwrap()
                .map(|entry| entry.unwrap().path()).filter(|path| path.is_dir()).collect::<Vec<_>>();
            assert!(leftovers.is_empty(), "{invalid_history}: {leftovers:?}");
            source.close().await;
        }
    }

    #[tokio::test]
    async fn failed_full_import_rolls_back_and_detaches_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.db");
        let source = backup(&source_path, 5).await;
        // Valid history but malformed schema: fail after full_prelude has begun writes.
        sqlx::query("DROP TABLE settings")
            .execute(&source)
            .await
            .unwrap();
        let target_path = root.path().join("target.db");
        let target = create_sqlite_pool(&target_path).await.unwrap();
        migrate_database(&mut *target.acquire().await.unwrap(), &contract())
            .await
            .unwrap();
        sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', 'unchanged')")
            .execute(&target)
            .await
            .unwrap();
        let error = run_import_backup(
            target.clone(),
            target_path,
            contract(),
            DatabaseImportRequest {
                source_path: source_path.to_string_lossy().into_owned(),
                mode: DatabaseImportMode::Full,
            },
        )
        .await
        .unwrap_err();
        assert!(error.contains("settings"), "{error}");
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='keep'")
                .fetch_one(&target)
                .await
                .unwrap(),
            "unchanged"
        );
        let attached: Vec<(i64, String, String)> = sqlx::query_as("PRAGMA database_list")
            .fetch_all(&target)
            .await
            .unwrap();
        assert!(attached.iter().all(|(_, name, _)| name != "imported"));
        assert!(fs::read_dir(root.path())
            .unwrap()
            .all(|entry| !entry.unwrap().path().is_dir()));
        source.close().await;
        target.close().await;
    }

    #[tokio::test]
    async fn rejects_ambiguous_import_identities_without_changing_target() {
        for (schema, duplicate) in [
            ("imported", "provider"),
            ("main", "provider"),
            ("imported", "model"),
            ("main", "model"),
        ] {
            let root = tempfile::tempdir().unwrap();
            let source_path = root.path().join("source.db");
            let source = backup(&source_path, 5).await;
            let target_path = root.path().join("target.db");
            let target = create_sqlite_pool(&target_path).await.unwrap();
            migrate_database(&mut *target.acquire().await.unwrap(), &contract())
                .await
                .unwrap();
            for pool in [&source, &target] {
                sqlx::raw_sql(
                    "INSERT INTO providers (id, name, driver, api_endpoint, logo) VALUES (1, 'Shared', 'openai', 'http://test', '');
                     INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Shared', 'shared');
                     INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'keep', 'Unchanged', 'shared');"
                ).execute(pool).await.unwrap();
            }
            sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', 'unchanged')")
                .execute(&target)
                .await
                .unwrap();
            let pool = if schema == "imported" {
                &source
            } else {
                &target
            };
            let sql = if duplicate == "provider" {
                "INSERT INTO providers (name, driver, api_endpoint, logo) VALUES ('Shared', 'openai', 'http://other', '')"
            } else {
                "INSERT INTO models (provider_id, name, model_id) VALUES (1, 'Other', 'shared')"
            };
            sqlx::query(sql).execute(pool).await.unwrap();
            for mode in [DatabaseImportMode::ChatOnly, DatabaseImportMode::Full] {
                let error = run_import_backup(
                    target.clone(),
                    target_path.clone(),
                    contract(),
                    DatabaseImportRequest {
                        source_path: source_path.to_string_lossy().into_owned(),
                        mode,
                    },
                )
                .await
                .unwrap_err();
                assert!(
                    error.contains("重复的供应商或模型标识"),
                    "{schema} {duplicate}: {error}"
                );
                assert_eq!(
                    sqlx::query_scalar::<_, String>(
                        "SELECT title FROM sessions WHERE session_id='keep'"
                    )
                    .fetch_one(&target)
                    .await
                    .unwrap(),
                    "Unchanged"
                );
                assert_eq!(
                    sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key='keep'")
                        .fetch_one(&target)
                        .await
                        .unwrap(),
                    "unchanged"
                );
                let attached: Vec<(i64, String, String)> = sqlx::query_as("PRAGMA database_list")
                    .fetch_all(&target)
                    .await
                    .unwrap();
                assert!(attached.iter().all(|(_, name, _)| name != "imported"));
            }
            source.close().await;
            target.close().await;
        }
    }

    #[tokio::test]
    async fn current_backup_keeps_order_and_timestamps_on_repeated_import() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.db");
        let source = backup(&source_path, 5).await;
        sqlx::raw_sql("INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'current', 'Current', 'test');
             INSERT INTO messages (id, session_id, role) VALUES (1, 1, 'assistant');
             INSERT INTO message_parts (message_id, type, content, started_at, ended_at, sort_order) VALUES
             (1, 'reasoning', 'Plan', 1000, 2000, 0), (1, 'text', 'First', NULL, NULL, 1),
             (1, 'reasoning', 'Review', 3000, 4500, 2), (1, 'text', 'Final', NULL, NULL, 3);")
            .execute(&source).await.unwrap();
        let target_path = root.path().join("target.db");
        let target = create_sqlite_pool(&target_path).await.unwrap();
        migrate_database(&mut *target.acquire().await.unwrap(), &contract())
            .await
            .unwrap();
        for _ in 0..2 {
            run_import_backup(
                target.clone(),
                target_path.clone(),
                contract(),
                DatabaseImportRequest {
                    source_path: source_path.to_string_lossy().into_owned(),
                    mode: DatabaseImportMode::ChatOnly,
                },
            )
            .await
            .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>(
                    "SELECT count(*) FROM sqlite_temp_master WHERE type='table'"
                )
                .fetch_one(&target)
                .await
                .unwrap(),
                0
            );
        }
        let query = "SELECT type, content, started_at, ended_at, sort_order FROM message_parts ORDER BY sort_order";
        type Part = (String, String, Option<i64>, Option<i64>, i64);
        let source_parts: Vec<Part> = sqlx::query_as(query).fetch_all(&source).await.unwrap();
        let target_parts: Vec<Part> = sqlx::query_as(query).fetch_all(&target).await.unwrap();
        assert_eq!(target_parts, source_parts);
        source.close().await;
        target.close().await;
    }

    #[tokio::test]
    async fn rejects_unrelated_database_without_leaking_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("unrelated.db");
        let source = create_sqlite_pool(&source_path).await.unwrap();
        sqlx::query("CREATE TABLE unrelated (id INTEGER)")
            .execute(&source)
            .await
            .unwrap();
        let error =
            prepare_import_database(&source_path, &root.path().join("target.db"), &contract())
                .await
                .unwrap_err();
        assert!(error.contains("不是 TouchAI 数据库"), "{error}");
        assert!(fs::read_dir(root.path())
            .unwrap()
            .all(|entry| !entry.unwrap().path().is_dir()));
        source.close().await;
    }
    #[tokio::test]
    async fn user_keeps_local_analytics_state_and_imports_no_remote_events() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.db");
        // 6 entries cover the full released chain, including the analytics tables.
        let source = backup(&source_path, 6).await;
        sqlx::raw_sql(
            "INSERT INTO analytics_state (id, status, consent_explicit, installation_id, consent_epoch) \
             VALUES (1, 'enabled', 1, 'remote-install', 7);\n             INSERT INTO analytics_outbox (event_id, consent_epoch, schema_version, event_name, payload_json, payload_bytes, enqueued_at, expires_at, next_attempt_at) \
             VALUES ('remote-e1', 7, 1, 'app.started', '{\"a\":1}', 7, 1, 9, 1);\n             INSERT INTO sessions (id, session_id, title, model) VALUES (1, 'imported-chat', 'Imported', 'test');",
        )
        .execute(&source)
        .await
        .unwrap();

        let target_path = root.path().join("target.db");
        let target = create_sqlite_pool(&target_path).await.unwrap();
        migrate_database(&mut *target.acquire().await.unwrap(), &contract())
            .await
            .unwrap();
        sqlx::raw_sql(
            "INSERT INTO analytics_state (id, status, consent_explicit, installation_id, consent_epoch) \
             VALUES (1, 'disabled', 1, 'local-install', 5);\n             INSERT INTO analytics_outbox (event_id, consent_epoch, schema_version, event_name, payload_json, payload_bytes, enqueued_at, expires_at, next_attempt_at) \
             VALUES ('local-e1', 5, 1, 'app.started', '{\"b\":2}', 7, 1, 9, 1);",
        )
        .execute(&target)
        .await
        .unwrap();

        run_import_backup(
            target.clone(),
            target_path,
            contract(),
            DatabaseImportRequest {
                source_path: source_path.to_string_lossy().into_owned(),
                mode: DatabaseImportMode::Full,
            },
        )
        .await
        .unwrap();

        // The local identity, consent and epoch survive; nothing remote is adopted.
        assert_eq!(
            sqlx::query_scalar::<_, String>(
                "SELECT installation_id FROM analytics_state WHERE id = 1"
            )
            .fetch_one(&target)
            .await
            .unwrap(),
            "local-install"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT consent_epoch FROM analytics_state WHERE id = 1")
                .fetch_one(&target)
                .await
                .unwrap(),
            5
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM analytics_outbox")
                .fetch_one(&target)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT event_id FROM analytics_outbox")
                .fetch_one(&target)
                .await
                .unwrap(),
            "local-e1"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sessions WHERE session_id = 'imported-chat'"
            )
            .fetch_one(&target)
            .await
            .unwrap(),
            1
        );
        source.close().await;
        target.close().await;
    }
}
