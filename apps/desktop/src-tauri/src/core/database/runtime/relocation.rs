use serde_json::Value;
use sqlx::{sqlite::SqliteConnectOptions, Connection, SqliteConnection};
use std::path::Path;

fn moved_path(value: &str, source: &Path, target: &Path) -> Option<String> {
    let normalized = normalize_path(value);
    let source = normalize_path(&source.to_string_lossy());
    let source = source.trim_end_matches('/');
    let prefix = format!("{source}/");
    let matches = if cfg!(windows) {
        normalized
            .to_lowercase()
            .starts_with(&prefix.to_lowercase())
    } else {
        normalized.starts_with(&prefix)
    };
    if !matches {
        return None;
    }
    let relative = normalized.get(prefix.len()..)?;
    if !crate::core::storage::location::DIRECTORIES.contains(&relative.split('/').next()?)
        || relative.split('/').any(|part| part == "..")
    {
        return None;
    }
    Some(target.join(relative).to_string_lossy().into_owned())
}

fn normalize_path(value: &str) -> String {
    let value = value.replace('\\', "/");
    if let Some(unc) = value.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else {
        value.strip_prefix("//?/").unwrap_or(&value).to_string()
    }
}

fn remap_json(
    value: &mut Value,
    source: &Path,
    target: &Path,
    path_fields_only: bool,
    path_field: bool,
) -> bool {
    match value {
        Value::String(text) if !path_fields_only || path_field => {
            if let Some(next) = moved_path(text, source, target) {
                *text = next;
                true
            } else {
                false
            }
        }
        Value::Array(values) => values.iter_mut().fold(false, |changed, value| {
            remap_json(value, source, target, path_fields_only, path_field) || changed
        }),
        Value::Object(values) => values.iter_mut().fold(false, |changed, (key, value)| {
            let path_field = matches!(
                key.as_str(),
                "path"
                    | "sourcePath"
                    | "source_path"
                    | "originPath"
                    | "origin_path"
                    | "filePath"
                    | "file_path"
            );
            remap_json(value, source, target, path_fields_only, path_field) || changed
        }),
        _ => false,
    }
}

pub(crate) async fn remap(database: &Path, source: &Path, target: &Path) -> Result<(), String> {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(database)
            .create_if_missing(false),
    )
    .await
    .map_err(|_| "storage_io_failed")?;
    let result = async {
        let integrity: String = sqlx::query_scalar("PRAGMA integrity_check").fetch_one(&mut connection).await.map_err(|_| "storage_io_failed")?;
        if integrity != "ok" { return Err("storage_io_failed".into()); }
        let mut transaction = connection.begin().await.map_err(|_| "storage_io_failed")?;
        for (table, column) in [
            ("attachments", "origin_path"), ("message_parts", "data"),
            ("session_turns", "prompt_snapshot_json"), ("session_turn_attempts", "checkpoint_json"),
            ("session_turn_attempts", "delivery_manifest_json"), ("settings", "value"),
            ("touchai_meta", "value"), ("built_in_tools", "config_json"),
            ("mcp_servers", "command"), ("mcp_servers", "args"), ("mcp_servers", "env"),
            ("mcp_servers", "cwd"), ("providers", "config_json"),
        ] {
            let query = format!("SELECT id, CASE WHEN length(CAST({column} AS BLOB)) <= 4194304 THEN {column} END FROM {table} WHERE id > ? AND {column} IS NOT NULL ORDER BY id LIMIT 64");
            let update = format!("UPDATE {table} SET {column} = ? WHERE id = ?");
            let mut cursor = 0_i64;
            loop {
                let rows: Vec<(i64, Option<String>)> = sqlx::query_as(sqlx::AssertSqlSafe(query.as_str())).bind(cursor).fetch_all(&mut *transaction).await.map_err(|_| "storage_io_failed")?;
                if rows.is_empty() { break; }
                for (id, raw) in rows {
                    cursor = id;
                    let raw = raw.ok_or("storage_scan_incomplete")?;
                    let path_fields_only = matches!(table, "message_parts" | "session_turns" | "session_turn_attempts");
                    let next = if !path_fields_only && moved_path(&raw, source, target).is_some() { moved_path(&raw, source, target) }
                    else if let Ok(mut value) = serde_json::from_str::<Value>(&raw) {
                        remap_json(&mut value, source, target, path_fields_only, false).then(|| value.to_string())
                    } else { None };
                    if let Some(next) = next {
                        sqlx::query(sqlx::AssertSqlSafe(update.as_str())).bind(next).bind(id).execute(&mut *transaction).await.map_err(|_| "storage_io_failed")?;
                    }
                }
            }
        }
        transaction.commit().await.map_err(|_| "storage_io_failed")?;
        let checkpoint: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)").fetch_one(&mut connection).await.map_err(|_| "storage_io_failed")?;
        if checkpoint.0 != 0 { return Err("storage_busy".into()); }
        Ok(())
    }.await;
    connection.close().await.map_err(|_| "storage_io_failed")?;
    result
}
