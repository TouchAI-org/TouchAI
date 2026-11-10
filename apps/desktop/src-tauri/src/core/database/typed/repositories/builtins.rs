// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqlitePool;

use super::super::operation::DatabaseOperationError;
use super::super::repository::{
    begin_immediate, fetch_one, fetch_rows, json_object, json_row, run,
};
use super::super::row::{count, insert_one, update_by_id};

const BUILTIN_TOOL_COLUMNS: &[&str] = &[
    "tool_id",
    "display_name",
    "description",
    "enabled",
    "risk_level",
    "config_json",
    "last_used_at",
    "created_at",
    "updated_at",
];

async fn acquire(
    pool: &SqlitePool,
) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>, DatabaseOperationError> {
    pool.acquire().await.map_err(DatabaseOperationError::from)
}

pub(super) async fn list(
    pool: &SqlitePool,
    enabled_only: bool,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let sql = if enabled_only {
        "SELECT * FROM built_in_tools WHERE enabled = 1 ORDER BY display_name ASC"
    } else {
        "SELECT * FROM built_in_tools ORDER BY enabled DESC, display_name ASC"
    };
    Ok(json_object(
        fetch_rows(&mut connection, sql, Vec::new()).await?,
    ))
}

pub(super) async fn find_by_id(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM built_in_tools WHERE id = ? LIMIT 1",
        vec![JsonValue::Number(id.into())],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn find_by_tool_id(
    pool: &SqlitePool,
    tool_id: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM built_in_tools WHERE tool_id = ? LIMIT 1",
        vec![JsonValue::String(tool_id)],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn create(
    pool: &SqlitePool,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = insert_one(
        &mut connection,
        "built_in_tools",
        &data,
        BUILTIN_TOOL_COLUMNS,
    )
    .await?;
    Ok(JsonValue::Object(row))
}

pub(super) async fn update(
    pool: &SqlitePool,
    id: i64,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = update_by_id(
        &mut connection,
        "built_in_tools",
        id,
        &data,
        BUILTIN_TOOL_COLUMNS,
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn update_many(
    pool: &SqlitePool,
    ids: Vec<i64>,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    if ids.is_empty() {
        return Ok(JsonValue::Array(Vec::new()));
    }

    let mut transaction = begin_immediate(pool).await?;
    let mut updated = Vec::with_capacity(ids.len());
    for id in ids {
        let row = update_by_id(
            &mut *transaction,
            "built_in_tools",
            id,
            &data,
            BUILTIN_TOOL_COLUMNS,
        )
        .await?
        .ok_or_else(|| {
            // Keep the tool id out of the log; the stable code is the caller contract.
            log::debug!(target: "database", "Built-in tool was not found during bulk update");
            DatabaseOperationError::with_code("built-in-tool-not-found", "Built-in tool not found")
        })?;
        updated.push(JsonValue::Object(row));
    }
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Array(updated))
}

pub(super) async fn touch(
    pool: &SqlitePool,
    tool_id: String,
    last_used_at: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    run(
        &mut connection,
        "UPDATE built_in_tools SET last_used_at = ? WHERE tool_id = ?",
        vec![JsonValue::String(last_used_at), JsonValue::String(tool_id)],
    )
    .await?;
    Ok(JsonValue::Null)
}

pub(super) async fn count_enabled(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    Ok(JsonValue::Number(
        count(
            &mut connection,
            "SELECT count(*) AS count FROM built_in_tools WHERE enabled = 1",
            Vec::new(),
        )
        .await?
        .into(),
    ))
}
