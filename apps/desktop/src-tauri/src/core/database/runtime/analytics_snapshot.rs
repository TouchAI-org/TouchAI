// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Offline analytics scrubbing for export/import snapshots.
//!
//! Export and import both operate on a temporary, offline copy of the database.
//! These connections are short-lived and closed before the snapshot moves on;
//! they are not a second application pool and never touch the live file.

use std::path::Path;

use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode},
    Connection, SqliteConnection,
};

const ANALYTICS_TABLES: [&str; 2] = ["analytics_outbox", "analytics_state"];

use crate::core::analytics::DEPLOYMENT_KEY_SETTING;

/// Removes analytics identity, consent and queued payloads from a database
/// snapshot. `journal_mode=DELETE` checkpoints any WAL into the main file, and
/// `VACUUM` rewrites the file so no scrubbed payload survives in free pages.
pub(crate) async fn sanitize_analytics_snapshot(path: &Path) -> Result<(), String> {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .journal_mode(SqliteJournalMode::Delete),
    )
    .await
    .map_err(|error| format!("Failed to open analytics snapshot: {error}"))?;

    let result: Result<(), String> = async {
        for table in ANALYTICS_TABLES {
            let present: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?",
            )
            .bind(table)
            .fetch_one(&mut connection)
            .await
            .map_err(|error| format!("Failed to inspect snapshot table {table}: {error}"))?;
            if present == 0 {
                continue;
            }
            sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table}")))
                .execute(&mut connection)
                .await
                .map_err(|error| format!("Failed to scrub snapshot table {table}: {error}"))?;
        }
        // The deployment binding is local state too: drop it so an exported
        // snapshot never carries another install's analytics target.
        sqlx::query("DELETE FROM settings WHERE key = ?")
            .bind(DEPLOYMENT_KEY_SETTING)
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Failed to scrub analytics deployment key: {error}"))?;
        sqlx::query("VACUUM")
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Failed to compact analytics snapshot: {error}"))?;
        Ok(())
    }
    .await;

    let close = connection.close().await;
    result?;
    close.map_err(|error| format!("Failed to close analytics snapshot: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::database::DatabaseRuntime;

    use crate::core::database::contract::create_sqlite_pool;

    #[tokio::test]
    async fn user_gets_a_sanitized_snapshot_without_analytics_identity_or_payloads() {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        let pool = runtime.pool();

        sqlx::query(
            "INSERT INTO analytics_state (id, status, consent_explicit, installation_id, consent_epoch) \
             VALUES (1, 'enabled', 1, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 4)",
        )
        .execute(pool)
        .await
        .expect("seed state");
        sqlx::query(
            "INSERT INTO analytics_outbox (event_id, consent_epoch, schema_version, event_name, payload_json, payload_bytes, enqueued_at, expires_at, next_attempt_at) \
             VALUES ('e1', 4, 1, 'app.started', '{\"a\":1}', 7, 1, 9, 1)",
        )
        .execute(pool)
        .await
        .expect("seed outbox");
        sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', '1')")
            .execute(pool)
            .await
            .expect("seed settings");
        sqlx::query("INSERT INTO settings (key, value) VALUES (?, 'https://x/send|abc')")
            .bind(DEPLOYMENT_KEY_SETTING)
            .execute(pool)
            .await
            .expect("seed deployment key");

        let snapshot = root.path().join("snap.db");
        sqlx::query("VACUUM INTO ?")
            .bind(snapshot.to_string_lossy().as_ref())
            .execute(pool)
            .await
            .expect("snapshot");
        sanitize_analytics_snapshot(&snapshot)
            .await
            .expect("sanitize");

        let sanitized = create_sqlite_pool(&snapshot).await.expect("open snapshot");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM analytics_state")
                .fetch_one(&sanitized)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM analytics_outbox")
                .fetch_one(&sanitized)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'keep'")
                .fetch_one(&sanitized)
                .await
                .unwrap(),
            "1"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM settings WHERE key = 'analytics.deploymentKey'"
            )
            .fetch_one(&sanitized)
            .await
            .unwrap(),
            0,
            "the exported snapshot must not carry the analytics deployment binding"
        );
    }
}
