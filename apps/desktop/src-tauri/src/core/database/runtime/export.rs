// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Create a consistent SQLite snapshot for database backup export.

use std::{
    fs,
    path::{Path, PathBuf},
};

use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection, SqlitePool};

use super::analytics_snapshot;

pub(crate) async fn run_export_backup(
    pool: &SqlitePool,
    database_path: &Path,
    target_path: &str,
) -> Result<(), String> {
    let target_path = resolve_target_path(target_path)?;
    let current_path = fs::canonicalize(database_path)
        .map_err(|error| format!("Failed to resolve current database path: {error}"))?;
    if target_path == current_path {
        return Err("不能导出到当前正在使用的数据库文件".to_string());
    }

    let parent = target_path
        .parent()
        .ok_or_else(|| "备份目标路径没有父目录".to_string())?;
    let snapshot_dir = tempfile::tempdir_in(parent)
        .map_err(|error| format!("Failed to create backup workspace: {error}"))?;
    let snapshot_path = snapshot_dir.path().join("touchai.db");

    // VACUUM INTO includes committed WAL pages in one consistent snapshot.
    sqlx::query("VACUUM INTO ?")
        .bind(snapshot_path.to_string_lossy().as_ref())
        .execute(pool)
        .await
        .map_err(|error| format!("Failed to snapshot database: {error}"))?;

    // Consent choice travels with the backup, but analytics identity and queued
    // payloads must never leave the installation.
    let _ = analytics_snapshot::sanitize_analytics_snapshot(&snapshot_path).await?;
    validate_snapshot(&snapshot_path).await?;
    fs::copy(&snapshot_path, &target_path)
        .map_err(|error| format!("Failed to write database backup: {error}"))?;
    Ok(())
}

fn resolve_target_path(target_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(target_path);
    let file_name = path
        .file_name()
        .ok_or_else(|| "备份目标路径必须指向文件".to_string())?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Failed to resolve backup destination: {error}"))?;
    let candidate = parent.join(file_name);
    if candidate.exists() {
        fs::canonicalize(&candidate)
            .map_err(|error| format!("Failed to resolve backup destination: {error}"))
    } else {
        Ok(candidate)
    }
}

async fn validate_snapshot(path: &Path) -> Result<(), String> {
    let mut connection =
        SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(path))
            .await
            .map_err(|error| format!("Failed to open backup snapshot: {error}"))?;
    let result = sqlx::query_scalar::<_, String>("PRAGMA integrity_check")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| format!("Failed to validate backup snapshot: {error}"))?;
    connection
        .close()
        .await
        .map_err(|error| format!("Failed to close backup snapshot: {error}"))?;
    if result != "ok" {
        return Err(format!("Backup snapshot integrity check failed: {result}"));
    }
    Ok(())
}
