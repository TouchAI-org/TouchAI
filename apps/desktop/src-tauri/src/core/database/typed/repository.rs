// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqliteConnection;

use super::operation::DatabaseOperationError;

pub(crate) async fn fetch_rows(
    connection: &mut SqliteConnection,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<Vec<JsonMap<String, JsonValue>>, DatabaseOperationError> {
    let query = crate::core::database::runtime::build_query(sql, params)?;
    let rows = query
        .fetch_all(&mut *connection)
        .await
        .map_err(DatabaseOperationError::from)?;
    rows.iter()
        .map(crate::core::database::protocol::decode::decode_row)
        .collect::<Result<Vec<_>, _>>()
        .map_err(DatabaseOperationError::unavailable)
}

pub(crate) async fn fetch_one(
    connection: &mut SqliteConnection,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<Option<JsonMap<String, JsonValue>>, DatabaseOperationError> {
    Ok(fetch_rows(connection, sql, params)
        .await?
        .into_iter()
        .next())
}

pub(crate) async fn run(
    connection: &mut SqliteConnection,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<u64, DatabaseOperationError> {
    let query = crate::core::database::runtime::build_query(sql, params)?;
    let result = query
        .execute(&mut *connection)
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(result.rows_affected())
}

pub(crate) fn json_object(rows: Vec<JsonMap<String, JsonValue>>) -> JsonValue {
    JsonValue::Array(rows.into_iter().map(JsonValue::Object).collect())
}

pub(crate) fn json_row(row: Option<JsonMap<String, JsonValue>>) -> JsonValue {
    row.map(JsonValue::Object).unwrap_or(JsonValue::Null)
}
