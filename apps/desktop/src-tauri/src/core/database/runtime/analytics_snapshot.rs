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

    let result = async {
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
