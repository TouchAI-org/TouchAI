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

use crate::core::analytics::{RestoredConsent, DEPLOYMENT_KEY_SETTING};

/// Removes analytics identity, consent epoch, pending-update metadata and queued
/// payloads from a database snapshot.
///
/// The consent status and explicit-choice marker survive alongside policy_version
/// and a refreshed updated_at. Keeping the choice prevents a restore from silently
/// re-enabling sharing. `journal_mode=DELETE` checkpoints the WAL, and `VACUUM`
/// removes scrubbed payloads from free pages.
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
        let mut restored_consent = None;
        for table in ["analytics_outbox", "analytics_state"] {
            if !snapshot_table_exists(&mut connection, table).await? {
                continue;
            }
            if table == "analytics_state" {
                restored_consent = scrub_snapshot_state(&mut connection).await?;
            } else {
                sqlx::query(sqlx::AssertSqlSafe(format!("DELETE FROM {table}")))
                    .execute(&mut connection)
                    .await
                    .map_err(|error| format!("Failed to scrub snapshot table {table}: {error}"))?;
            }
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
        Ok(restored_consent)
    }
    .await;

    let close = connection.close().await;
    let restored_consent = result?;
    close.map_err(|error| format!("Failed to close analytics snapshot: {error}"))?;
    Ok(restored_consent)
}

/// Keeps status, consent_explicit and policy_version; refreshes updated_at and
/// clears installation identity, epoch, observation days, observed version and
/// pending-update metadata.
async fn scrub_snapshot_state(
    connection: &mut SqliteConnection,
) -> Result<Option<RestoredConsent>, String> {
    let state: Option<(String, i64)> =
        sqlx::query_as("SELECT status, consent_explicit FROM analytics_state WHERE id = 1")
            .fetch_optional(&mut *connection)
            .await
            .map_err(|error| format!("Failed to read analytics snapshot state: {error}"))?;
    sqlx::query(
        "UPDATE analytics_state SET installation_id = NULL, consent_epoch = 0, \
         observation_started_day = NULL, first_success_day = NULL, \
         last_observed_app_version = NULL, pending_update_json = NULL, \
         updated_at = datetime('now') WHERE id = 1",
    )
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("Failed to scrub analytics snapshot state: {error}"))?;
    Ok(state.map(|(status, consent_explicit)| RestoredConsent {
        status,
        explicit: consent_explicit == 1,
    }))
}

async fn snapshot_table_exists(
    connection: &mut SqliteConnection,
    table: &str,
) -> Result<bool, String> {
    let present: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind(table)
            .fetch_one(&mut *connection)
            .await
            .map_err(|error| format!("Failed to inspect snapshot table {table}: {error}"))?;
    Ok(present != 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::database::DatabaseRuntime;

    use crate::core::database::contract::create_sqlite_pool;

    async fn exported_snapshot(root: &Path) -> std::path::PathBuf {
        let snapshot = root.join("snap.db");
        let runtime = DatabaseRuntime::initialize_for_tests(root)
            .await
            .expect("database runtime");
        let pool = runtime.pool();
        sqlx::query(
            "INSERT INTO analytics_state (id, status, consent_explicit, installation_id, \
             consent_epoch, observation_started_day, first_success_day, \
             last_observed_app_version, pending_update_json, policy_version, updated_at) \
             VALUES (1, 'disabled', 1, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', 4, \
             '2026-01-01', '2026-01-02', '1.2.2', '{\"toVersion\":\"2.0.0\"}', 7, '2001-01-01 00:00:00')",
        )
        .execute(pool)
        .await
        .expect("seed state");
        sqlx::query(
            "INSERT INTO analytics_outbox (event_id, consent_epoch, schema_version, event_name, \
             payload_json, payload_bytes, enqueued_at, expires_at, next_attempt_at) \
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
        let snapshot = exported_snapshot(root.path()).await;

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
        let (status, explicit, installation, epoch): (String, i64, Option<String>, i64) =
            sqlx::query_as(
                "SELECT status, consent_explicit, installation_id, consent_epoch \
                 FROM analytics_state WHERE id = 1",
            )
            .fetch_one(&sanitized)
            .await
            .expect("scrubbed state");
        assert_eq!(status, "disabled");
        assert_eq!(explicit, 1);
        assert!(installation.is_none(), "identity is never exported");
        assert_eq!(epoch, 0, "the consent epoch is never exported");
        let (policy, refreshed): (i64, String) =
            sqlx::query_as("SELECT policy_version, updated_at FROM analytics_state WHERE id = 1")
                .fetch_one(&sanitized)
                .await
                .expect("remaining consent metadata");
        assert_eq!(policy, 7, "the non-identifying policy version survives");
        assert_ne!(
            refreshed, "2001-01-01 00:00:00",
            "the original row timestamp is not exported"
        );
        let scrubbed: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = sqlx::query_as(
            "SELECT observation_started_day, first_success_day, \
                 last_observed_app_version, pending_update_json FROM analytics_state WHERE id = 1",
        )
        .fetch_one(&sanitized)
        .await
        .expect("scrubbed columns");
        assert_eq!(scrubbed, (None, None, None, None));
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
        sanitized.close().await;
    }

    #[tokio::test]
    async fn user_gets_a_derived_default_carried_without_becoming_an_explicit_choice() {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        sqlx::query(
            "INSERT INTO analytics_state (id, status, consent_explicit, installation_id) \
             VALUES (1, 'enabled', 0, 'local-install')",
        )
        .execute(runtime.pool())
        .await
        .expect("seed state");
        let snapshot = root.path().join("snap.db");
        sqlx::query("VACUUM INTO ?")
            .bind(snapshot.to_string_lossy().as_ref())
            .execute(runtime.pool())
            .await
            .expect("snapshot");

        let consent = sanitize_analytics_snapshot(&snapshot)
            .await
            .expect("sanitize");

        assert_eq!(
            consent,
            Some(RestoredConsent {
                status: "enabled".to_string(),
                explicit: false,
            }),
            "a deployment default must not become the user's explicit choice"
        );
    }
}
