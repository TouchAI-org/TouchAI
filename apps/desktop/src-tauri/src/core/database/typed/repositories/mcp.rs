// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::HashMap;

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqlitePool;

use super::super::operation::{DatabaseOperationError, McpToolDefinition};
use super::super::repository::{
    begin_immediate, fetch_one, fetch_rows, json_object, json_row, run,
};
use super::super::row::{count, delete_by_id, insert_one, update_by_id};

const MCP_SERVER_COLUMNS: &[&str] = &[
    "name",
    "transport_type",
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "headers",
    "enabled",
    "tool_timeout",
    "version",
    "last_error",
    "last_connected_at",
    "created_at",
    "updated_at",
];

const MCP_TOOL_COLUMNS: &[&str] = &[
    "server_id",
    "name",
    "description",
    "input_schema",
    "enabled",
    "created_at",
    "updated_at",
];

async fn acquire(
    pool: &SqlitePool,
) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>, DatabaseOperationError> {
    pool.acquire().await.map_err(DatabaseOperationError::from)
}

pub(super) async fn list_servers(
    pool: &SqlitePool,
    enabled_only: bool,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let sql = if enabled_only {
        "SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name ASC"
    } else {
        "SELECT * FROM mcp_servers ORDER BY name ASC"
    };
    Ok(json_object(
        fetch_rows(&mut connection, sql, Vec::new()).await?,
    ))
}

pub(super) async fn find_server(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM mcp_servers WHERE id = ? LIMIT 1",
        vec![JsonValue::Number(id.into())],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn find_server_by_name(
    pool: &SqlitePool,
    name: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM mcp_servers WHERE name = ? LIMIT 1",
        vec![JsonValue::String(name)],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn create_server(
    pool: &SqlitePool,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = insert_one(&mut connection, "mcp_servers", &data, MCP_SERVER_COLUMNS).await?;
    Ok(JsonValue::Object(row))
}

pub(super) async fn update_server(
    pool: &SqlitePool,
    id: i64,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = update_by_id(
        &mut connection,
        "mcp_servers",
        id,
        &data,
        MCP_SERVER_COLUMNS,
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn delete_server(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    delete_by_id(&mut connection, "mcp_servers", id).await?;
    Ok(JsonValue::Null)
}

pub(super) async fn count_servers(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    Ok(JsonValue::Number(
        count(
            &mut connection,
            "SELECT count(*) AS count FROM mcp_servers",
            Vec::new(),
        )
        .await?
        .into(),
    ))
}

pub(super) async fn list_tools(
    pool: &SqlitePool,
    server_id: Option<i64>,
    enabled_only: bool,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let mut conditions = Vec::new();
    let mut params = Vec::new();
    if let Some(server_id) = server_id {
        conditions.push("server_id = ?");
        params.push(JsonValue::Number(server_id.into()));
    }
    if enabled_only {
        conditions.push("enabled = 1");
    }
    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    let sql = format!("SELECT * FROM mcp_tools{where_clause} ORDER BY name ASC");
    Ok(json_object(
        fetch_rows(&mut connection, &sql, params).await?,
    ))
}

pub(super) async fn find_tool(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM mcp_tools WHERE id = ? LIMIT 1",
        vec![JsonValue::Number(id.into())],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn find_tool_by_server_and_name(
    pool: &SqlitePool,
    server_id: i64,
    name: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM mcp_tools WHERE server_id = ? AND name = ? LIMIT 1",
        vec![JsonValue::Number(server_id.into()), JsonValue::String(name)],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn create_tool(
    pool: &SqlitePool,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = insert_one(&mut connection, "mcp_tools", &data, MCP_TOOL_COLUMNS).await?;
    Ok(JsonValue::Object(row))
}

pub(super) async fn update_tool(
    pool: &SqlitePool,
    id: i64,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = update_by_id(&mut connection, "mcp_tools", id, &data, MCP_TOOL_COLUMNS).await?;
    Ok(json_row(row))
}

pub(super) async fn delete_tool(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    delete_by_id(&mut connection, "mcp_tools", id).await?;
    Ok(JsonValue::Null)
}

pub(super) async fn delete_tools_by_server(
    pool: &SqlitePool,
    server_id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    run(
        &mut connection,
        "DELETE FROM mcp_tools WHERE server_id = ?",
        vec![JsonValue::Number(server_id.into())],
    )
    .await?;
    Ok(JsonValue::Null)
}

pub(super) async fn count_tools(
    pool: &SqlitePool,
    server_id: Option<i64>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let (sql, params) = match server_id {
        Some(server_id) => (
            "SELECT count(*) AS count FROM mcp_tools WHERE server_id = ?",
            vec![JsonValue::Number(server_id.into())],
        ),
        None => ("SELECT count(*) AS count FROM mcp_tools", Vec::new()),
    };
    Ok(JsonValue::Number(
        count(&mut connection, sql, params).await?.into(),
    ))
}

pub(super) async fn sync_tools(
    pool: &SqlitePool,
    server_id: i64,
    tools: Vec<McpToolDefinition>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let existing = fetch_rows(
        &mut *transaction,
        "SELECT name, enabled FROM mcp_tools WHERE server_id = ?",
        vec![JsonValue::Number(server_id.into())],
    )
    .await?;
    let enabled_by_name = existing
        .into_iter()
        .filter_map(|row| {
            let name = row.get("name")?.as_str()?.to_string();
            let enabled = row.get("enabled")?.as_i64()?;
            Some((name, enabled))
        })
        .collect::<HashMap<_, _>>();

    run(
        &mut *transaction,
        "DELETE FROM mcp_tools WHERE server_id = ?",
        vec![JsonValue::Number(server_id.into())],
    )
    .await?;

    for definition in tools {
        let input_schema = serde_json::to_string(&definition.input_schema)
            .map_err(|error| DatabaseOperationError::validation(error.to_string()))?;
        let data = JsonMap::from_iter([
            ("server_id".to_string(), JsonValue::Number(server_id.into())),
            (
                "name".to_string(),
                JsonValue::String(definition.name.clone()),
            ),
            (
                "description".to_string(),
                definition
                    .description
                    .map(JsonValue::String)
                    .unwrap_or(JsonValue::Null),
            ),
            ("input_schema".to_string(), JsonValue::String(input_schema)),
            (
                "enabled".to_string(),
                JsonValue::Number(
                    definition
                        .enabled
                        .or_else(|| enabled_by_name.get(&definition.name).copied())
                        .unwrap_or(1)
                        .into(),
                ),
            ),
        ]);
        insert_one(&mut *transaction, "mcp_tools", &data, MCP_TOOL_COLUMNS).await?;
    }

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}
