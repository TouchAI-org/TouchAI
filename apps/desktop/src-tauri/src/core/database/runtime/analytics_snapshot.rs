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

use crate::core::analytics::{sanitize_exported_state, RestoredConsent, ANALYTICS_STATE_SETTING};

/// Removes analytics identity, consent epoch and pending-update metadata from a
/// database snapshot.
///
/// The consent status and explicit-choice marker survive alongside policy_version
/// and a refreshed updated_at. Keeping the choice prevents a restore from silently
/// re-enabling sharing. Legacy analytics tables are removed as well, because
/// delivery is process-local and must never travel through a backup.
/// `journal_mode=DELETE` checkpoints the WAL, and `VACUUM` compacts the snapshot.
pub(crate) async fn sanitize_analytics_snapshot(
    path: &Path,
) -> Result<Option<RestoredConsent>, String> {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(path)
            .journal_mode(SqliteJournalMode::Delete),
    )
    .await
    .map_err(|error| format!("Failed to open analytics snapshot: {error}"))?;

    let result: Result<Option<RestoredConsent>, String> = async {
        let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(ANALYTICS_STATE_SETTING)
            .fetch_optional(&mut connection)
            .await
            .map_err(|error| format!("Failed to read analytics snapshot state: {error}"))?;
        let restored_consent = match value {
            Some(value) => match sanitize_exported_state(&value) {
                Ok((scrubbed, consent)) => {
                    sqlx::query(
                        "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?",
                    )
                    .bind(scrubbed)
                    .bind(ANALYTICS_STATE_SETTING)
                    .execute(&mut connection)
                    .await
                    .map_err(|error| {
                        format!("Failed to scrub analytics snapshot state: {error}")
                    })?;
                    Some(consent)
                }
                Err(_) => {
                    // Malformed analytics metadata is local-only and cannot be
                    // represented safely in an export.
                    sqlx::query("DELETE FROM settings WHERE key = ?")
                        .bind(ANALYTICS_STATE_SETTING)
                        .execute(&mut connection)
                        .await
                        .map_err(|error| {
                            format!("Failed to remove malformed analytics state: {error}")
                        })?;
                    None
                }
            },
            None => None,
        };
        // These tables existed only in the earlier persisted-queue design. They
        // may still be present in a development backup, so never carry them.
        sqlx::query("DROP TABLE IF EXISTS analytics_outbox")
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Failed to remove legacy analytics outbox: {error}"))?;
        sqlx::query("DROP TABLE IF EXISTS analytics_state")
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Failed to remove legacy analytics state: {error}"))?;
        sqlx::query("VACUUM")
            .execute(&mut connection)
            .await
            .map_err(|error| format!("Failed to compact analytics snapshot: {error}"))?;
        Ok(restored_consent)
    }
    .await;

    let close = connection.close().await;
    let restored_consent = result?;
    close.map_err(|error| format!("Failed to close analytics snapshot: {error}"))?;
    Ok(restored_consent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::database::{contract::create_sqlite_pool, DatabaseRuntime};
    use serde_json::{json, Value};

    async fn seed_state(pool: &sqlx::SqlitePool, explicit: bool) {
        let state = json!({
            "policyVersion": 7,
            "status": "disabled",
            "consentExplicit": if explicit { 1 } else { 0 },
            "installationId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
            "consentEpoch": 4,
            "observationStartedDay": "2026-01-01",
            "firstSuccessDay": "2026-01-02",
            "lastObservedAppVersion": "1.2.2",
            "pendingUpdateJson": "{\"toVersion\":\"2.0.0\"}",
            "deploymentKey": "https://analytics.invalid/send|project",
            "updatedAtMs": 1
        });
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind(ANALYTICS_STATE_SETTING)
        .bind(state.to_string())
        .execute(pool)
        .await
        .expect("seed analytics state");
    }

    async fn exported_snapshot(root: &Path, explicit: bool) -> std::path::PathBuf {
        let snapshot = root.join("snap.db");
        let runtime = DatabaseRuntime::initialize_for_tests(root)
            .await
            .expect("database runtime");
        let pool = runtime.pool();
        seed_state(pool, explicit).await;
        sqlx::raw_sql(
            "CREATE TABLE analytics_outbox (event_id TEXT PRIMARY KEY, payload_json TEXT); \
             INSERT INTO analytics_outbox (event_id, payload_json) VALUES ('legacy', '{\"a\":1}'); \
             CREATE TABLE analytics_state (id INTEGER PRIMARY KEY, status TEXT); \
             INSERT INTO analytics_state (id, status) VALUES (1, 'disabled');",
        )
        .execute(pool)
        .await
        .expect("seed legacy analytics tables");
        sqlx::query("INSERT INTO settings (key, value) VALUES ('keep', '1')")
            .execute(pool)
            .await
            .expect("seed settings");
        sqlx::query("VACUUM INTO ?")
            .bind(snapshot.to_string_lossy().as_ref())
            .execute(pool)
            .await
            .expect("snapshot");
        snapshot
    }

    #[tokio::test]
    async fn user_gets_an_exported_snapshot_that_keeps_an_explicit_opt_out_and_no_identity() {
        let root = tempfile::tempdir().expect("temp dir");
        let snapshot = exported_snapshot(root.path(), true).await;

        let consent = sanitize_analytics_snapshot(&snapshot)
            .await
            .expect("sanitize");

        assert_eq!(
            consent,
            Some(RestoredConsent {
                status: "disabled".to_string(),
                explicit: true,
            })
        );

        let sanitized = create_sqlite_pool(&snapshot).await.expect("open snapshot");
        let value: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
            .bind(ANALYTICS_STATE_SETTING)
            .fetch_one(&sanitized)
            .await
            .expect("scrubbed state");
        let scrubbed: Value = serde_json::from_str(&value).expect("state json");
        assert_eq!(scrubbed["status"], "disabled");
        assert_eq!(scrubbed["consentExplicit"], 1);
        assert_eq!(scrubbed["policyVersion"], 7);
        assert_eq!(scrubbed["installationId"], Value::Null);
        assert_eq!(scrubbed["consentEpoch"], 0);
        assert_eq!(scrubbed["observationStartedDay"], Value::Null);
        assert_eq!(scrubbed["firstSuccessDay"], Value::Null);
        assert_eq!(scrubbed["lastObservedAppVersion"], Value::Null);
        assert_eq!(scrubbed["pendingUpdateJson"], Value::Null);
        assert_eq!(scrubbed["deploymentKey"], "");
        assert_ne!(scrubbed["updatedAtMs"], 1);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
                 AND name IN ('analytics_outbox', 'analytics_state')"
            )
            .fetch_one(&sanitized)
            .await
            .unwrap(),
            0,
            "legacy queues and state tables never travel through a backup"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT value FROM settings WHERE key = 'keep'")
                .fetch_one(&sanitized)
                .await
                .unwrap(),
            "1"
        );
        sanitized.close().await;
    }

    #[tokio::test]
    async fn user_gets_a_derived_default_carried_without_becoming_an_explicit_choice() {
        let root = tempfile::tempdir().expect("temp dir");
        let snapshot = exported_snapshot(root.path(), false).await;

        let consent = sanitize_analytics_snapshot(&snapshot)
            .await
            .expect("sanitize");

        assert_eq!(
            consent,
            Some(RestoredConsent {
                status: "disabled".to_string(),
                explicit: false,
            }),
            "a deployment default must not become the user's explicit choice"
        );
    }
}
