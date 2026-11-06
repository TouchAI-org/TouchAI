// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Safe row helpers for typed repositories.
//!
//! SQL is assembled only from static table/column allow-lists. Callers may
//! provide values, but never column names or SQL text.

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqliteConnection;

use super::operation::DatabaseOperationError;
use super::repository::{fetch_one, run};

fn selected_columns<'a>(
    data: &JsonMap<String, JsonValue>,
    allowed: &'a [&'a str],
) -> Result<Vec<&'a str>, DatabaseOperationError> {
    let mut columns = Vec::new();
    for key in data.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(DatabaseOperationError::validation(format!(
                "Unsupported column '{key}'"
            )));
        }
    }

    for column in allowed {
        if data.contains_key(*column) {
            columns.push(*column);
        }
    }

    Ok(columns)
}

fn values_for(data: &JsonMap<String, JsonValue>, columns: &[&str]) -> Vec<JsonValue> {
    columns
        .iter()
        .map(|column| data.get(*column).cloned().unwrap_or(JsonValue::Null))
        .collect()
}

pub(crate) async fn insert_one(
    connection: &mut SqliteConnection,
    table: &str,
    data: &JsonMap<String, JsonValue>,
    allowed: &[&str],
) -> Result<JsonMap<String, JsonValue>, DatabaseOperationError> {
    let columns = selected_columns(data, allowed)?;
    if columns.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Insert payload must contain at least one column",
        ));
    }

    let quoted = columns
        .iter()
        .map(|column| format!("\"{column}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = std::iter::repeat_n("?", columns.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("INSERT INTO {table} ({quoted}) VALUES ({placeholders}) RETURNING *");
    fetch_one(connection, &sql, values_for(data, &columns))
        .await?
        .ok_or_else(|| DatabaseOperationError::unavailable("Insert returned no row"))
}

pub(crate) async fn insert_many_ignore(
    connection: &mut SqliteConnection,
    table: &str,
    rows: &[JsonMap<String, JsonValue>],
    allowed: &[&str],
) -> Result<(), DatabaseOperationError> {
    for row in rows {
        let columns = selected_columns(row, allowed)?;
        if columns.is_empty() {
            return Err(DatabaseOperationError::validation(
                "Insert payload must contain at least one column",
            ));
        }
        let quoted = columns
            .iter()
            .map(|column| format!("\"{column}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = std::iter::repeat_n("?", columns.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!("INSERT OR IGNORE INTO {table} ({quoted}) VALUES ({placeholders})");
        run(connection, &sql, values_for(row, &columns)).await?;
    }
    Ok(())
}

pub(crate) async fn update_by_id(
    connection: &mut SqliteConnection,
    table: &str,
    id: i64,
    data: &JsonMap<String, JsonValue>,
    allowed: &[&str],
) -> Result<Option<JsonMap<String, JsonValue>>, DatabaseOperationError> {
    let columns = selected_columns(data, allowed)?;
    if columns.is_empty() {
        return Err(DatabaseOperationError::validation(
            "Update payload must contain at least one column",
        ));
    }

    let assignments = columns
        .iter()
        .map(|column| format!("\"{column}\" = ?"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("UPDATE {table} SET {assignments} WHERE id = ? RETURNING *");
    let mut params = values_for(data, &columns);
    params.push(JsonValue::Number(id.into()));
    fetch_one(connection, &sql, params).await
}

pub(crate) async fn delete_by_id(
    connection: &mut SqliteConnection,
    table: &str,
    id: i64,
) -> Result<bool, DatabaseOperationError> {
    let affected = run(
        connection,
        &format!("DELETE FROM {table} WHERE id = ?"),
        vec![JsonValue::Number(id.into())],
    )
    .await?;
    Ok(affected > 0)
}

pub(crate) async fn count(
    connection: &mut SqliteConnection,
    sql: &str,
    params: Vec<JsonValue>,
) -> Result<i64, DatabaseOperationError> {
    let row = fetch_one(connection, sql, params).await?;
    Ok(row
        .and_then(|value| value.get("count").cloned())
        .and_then(|value| value.as_i64())
        .unwrap_or(0))
}
