// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 通用查询执行与参数绑定。

use serde_json::Value as JsonValue;
use sqlx::{sqlite::SqliteArguments, Sqlite};

use super::super::protocol::{
    decode::decode_row,
    types::{DatabaseQueryMethod, DatabaseQueryRequest, DatabaseQueryResponse},
};

/// 普通 `database_query` 入口不允许直接发送事务控制语句，
/// 事务必须经过专门的 tx 命令，以便运行时托管连接生命周期。
pub(crate) fn reject_top_level_transaction_sql(sql: &str) -> Result<(), String> {
    let normalized = sql.trim().to_ascii_lowercase();
    if normalized.starts_with("begin")
        || normalized.starts_with("commit")
        || normalized.starts_with("rollback")
        || normalized.starts_with("savepoint")
        || normalized.starts_with("release savepoint")
        || normalized.starts_with("rollback to savepoint")
    {
        return Err("Top-level database_query 不允许直接发送事务控制 SQL".to_string());
    }

    Ok(())
}

pub(crate) async fn execute_request<'c, E>(
    executor: E,
    request: DatabaseQueryRequest,
) -> Result<DatabaseQueryResponse, String>
where
    E: sqlx::Executor<'c, Database = Sqlite>,
{
    match request.method {
        DatabaseQueryMethod::Run => execute_run(executor, request).await,
        DatabaseQueryMethod::All | DatabaseQueryMethod::Get | DatabaseQueryMethod::Values => {
            execute_select(executor, request).await
        }
    }
}

async fn execute_run<'c, E>(
    executor: E,
    request: DatabaseQueryRequest,
) -> Result<DatabaseQueryResponse, String>
where
    E: sqlx::Executor<'c, Database = Sqlite>,
{
    let query = build_query(&request.sql, request.params)?;
    let result = query
        .execute(executor)
        .await
        .map_err(|error| format!("Failed to execute sqlite statement: {error}"))?;

    Ok(DatabaseQueryResponse {
        rows: Vec::new(),
        rows_affected: result.rows_affected(),
        last_insert_id: Some(result.last_insert_rowid()),
    })
}

async fn execute_select<'c, E>(
    executor: E,
    request: DatabaseQueryRequest,
) -> Result<DatabaseQueryResponse, String>
where
    E: sqlx::Executor<'c, Database = Sqlite>,
{
    let query = build_query(&request.sql, request.params)?;
    let rows = query
        .fetch_all(executor)
        .await
        .map_err(|error| format!("Failed to query sqlite rows: {error}"))?;

    let decoded_rows = rows.iter().map(decode_row).collect::<Result<Vec<_>, _>>()?;

    Ok(DatabaseQueryResponse {
        rows: decoded_rows,
        rows_affected: 0,
        last_insert_id: None,
    })
}

/// 将前端 JSON 参数绑定为 sqlx query。
///
/// 这是前后端数据库协议的唯一参数桥接层，保持类型规则集中。
fn build_query<'q>(
    sql: &'q str,
    params: Vec<JsonValue>,
) -> Result<sqlx::query::Query<'q, Sqlite, SqliteArguments<'q>>, String> {
    let mut query = sqlx::query(sql);

    for param in params {
        query = match param {
            JsonValue::Null => query.bind(Option::<String>::None),
            JsonValue::Bool(value) => query.bind(value),
            JsonValue::Number(value) => {
                if let Some(integer) = value.as_i64() {
                    query.bind(integer)
                } else if let Some(float) = value.as_f64() {
                    query.bind(float)
                } else {
                    return Err("Unsupported JSON number for sqlite bind".to_string());
                }
            }
            JsonValue::String(value) => query.bind(value),
            JsonValue::Array(values) => {
                let bytes = values
                    .into_iter()
                    .map(|value| {
                        value
                            .as_u64()
                            .and_then(|number| u8::try_from(number).ok())
                            .ok_or_else(|| "BLOB bind only supports byte arrays".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                query.bind(bytes)
            }
            JsonValue::Object(_) => {
                return Err("Object bind is not supported for sqlite runtime".to_string());
            }
        };
    }

    Ok(query)
}
