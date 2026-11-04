// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sqlx::SqlitePool;

use super::super::operation::DatabaseOperationError;
use super::super::repository::{fetch_one, fetch_rows, json_object, json_row, run};

async fn acquire(
    pool: &SqlitePool,
) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>, DatabaseOperationError> {
    pool.acquire().await.map_err(DatabaseOperationError::from)
}

pub(super) async fn find_setting(
    pool: &SqlitePool,
    key: String,
) -> Result<JsonValue, DatabaseOperationError> {
    if key.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Setting key is required",
        ));
    }
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM settings WHERE key = ? LIMIT 1",
        vec![JsonValue::String(key)],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn get_setting(
    pool: &SqlitePool,
    key: String,
) -> Result<JsonValue, DatabaseOperationError> {
    if key.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Setting key is required",
        ));
    }
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT value FROM settings WHERE key = ? LIMIT 1",
        vec![JsonValue::String(key)],
    )
    .await?;
    Ok(row
        .and_then(|row| row.get("value").cloned())
        .unwrap_or(JsonValue::Null))
}

pub(super) async fn get_settings(
    pool: &SqlitePool,
    keys: Vec<String>,
) -> Result<JsonValue, DatabaseOperationError> {
    if keys.iter().any(|key| key.is_empty()) {
        return Err(DatabaseOperationError::validation(
            "Setting keys must not be empty",
        ));
    }
    if keys.is_empty() {
        return Ok(JsonValue::Object(JsonMap::new()));
    }

    let placeholders = std::iter::repeat_n("?", keys.len())
        .collect::<Vec<_>>()
        .join(", ");
    let mut connection = acquire(pool).await?;
    let rows = fetch_rows(
        &mut connection,
        &format!("SELECT key, value FROM settings WHERE key IN ({placeholders})"),
        keys.iter()
            .cloned()
            .map(JsonValue::String)
            .collect::<Vec<_>>(),
    )
    .await?;
    let mut values = JsonMap::new();
    for row in rows {
        if let (Some(JsonValue::String(key)), Some(value)) =
            (row.get("key").cloned(), row.get("value").cloned())
        {
            values.insert(key, value);
        }
    }

    Ok(JsonValue::Object(
        keys.into_iter()
            .map(|key| {
                let value = values.remove(&key).unwrap_or(JsonValue::Null);
                (key, value)
            })
            .collect(),
    ))
}

pub(super) async fn set_setting(
    pool: &SqlitePool,
    key: String,
    value: String,
) -> Result<JsonValue, DatabaseOperationError> {
    if key.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Setting key is required",
        ));
    }
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
         RETURNING *",
        vec![JsonValue::String(key), JsonValue::String(value)],
    )
    .await?;
    row.map(JsonValue::Object)
        .ok_or_else(|| DatabaseOperationError::unavailable("Setting write returned no row"))
}

pub(super) async fn get_statistic(
    pool: &SqlitePool,
    key: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT value FROM statistics WHERE key = ? LIMIT 1",
        vec![JsonValue::String(key)],
    )
    .await?;
    Ok(row
        .and_then(|row| row.get("value").cloned())
        .unwrap_or(JsonValue::Null))
}

pub(super) async fn set_statistic(
    pool: &SqlitePool,
    key: String,
    value: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    run(
        &mut connection,
        "INSERT INTO statistics (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        vec![JsonValue::String(key), JsonValue::String(value)],
    )
    .await?;
    Ok(json!(true))
}

pub(super) async fn get_meta(
    pool: &SqlitePool,
    key: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT value FROM touchai_meta WHERE key = ? LIMIT 1",
        vec![JsonValue::String(key)],
    )
    .await?;
    Ok(row
        .and_then(|row| row.get("value").cloned())
        .unwrap_or(JsonValue::Null))
}

pub(super) async fn set_meta(
    pool: &SqlitePool,
    key: String,
    value: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    run(
        &mut connection,
        "INSERT INTO touchai_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        vec![JsonValue::String(key), JsonValue::String(value)],
    )
    .await?;
    Ok(JsonValue::Null)
}

pub(super) async fn delete_meta(
    pool: &SqlitePool,
    key: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    run(
        &mut connection,
        "DELETE FROM touchai_meta WHERE key = ?",
        vec![JsonValue::String(key)],
    )
    .await?;
    Ok(JsonValue::Null)
}

pub(super) async fn find_quick_search(
    pool: &SqlitePool,
    query_norm: String,
    limit: u32,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let rows = fetch_rows(
        &mut connection,
        "SELECT path_norm, click_count, query_norm
         FROM quick_search_click_stats
         WHERE query_norm = ?
         ORDER BY click_count DESC, updated_at DESC
         LIMIT ?",
        vec![
            JsonValue::String(query_norm),
            JsonValue::Number(limit.into()),
        ],
    )
    .await?;
    Ok(json_object(rows))
}

pub(super) async fn upsert_quick_search(
    pool: &SqlitePool,
    query_norm: String,
    path_norm: String,
    max_click_count: u32,
) -> Result<JsonValue, DatabaseOperationError> {
    if query_norm.is_empty() || path_norm.is_empty() {
        return Ok(JsonValue::Null);
    }
    let mut connection = acquire(pool).await?;
    run(
        &mut connection,
        "INSERT INTO quick_search_click_stats (query_norm, path_norm, click_count)
         VALUES (?, ?, 1)
         ON CONFLICT(query_norm, path_norm) DO UPDATE SET
           click_count = CASE
             WHEN quick_search_click_stats.click_count >= ? THEN ?
             ELSE quick_search_click_stats.click_count + 1
           END,
           updated_at = datetime('now')",
        vec![
            JsonValue::String(query_norm),
            JsonValue::String(path_norm),
            JsonValue::Number(max_click_count.into()),
            JsonValue::Number(max_click_count.into()),
        ],
    )
    .await?;
    Ok(JsonValue::Null)
}
