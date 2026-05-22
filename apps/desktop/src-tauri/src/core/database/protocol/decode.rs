// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! SQLite 行结果到 JSON 的解码。

use serde_json::{Map as JsonMap, Number as JsonNumber, Value as JsonValue};
use sqlx::{
    sqlite::{SqliteRow, SqliteValueRef},
    Column, Row, TypeInfo, Value, ValueRef,
};

/// 将单行 SQLite 结果转成前端协议使用的 JSON 对象。
pub fn decode_row(row: &SqliteRow) -> Result<JsonMap<String, JsonValue>, String> {
    let mut value = JsonMap::new();

    for (index, column) in row.columns().iter().enumerate() {
        let raw = row
            .try_get_raw(index)
            .map_err(|error| format!("Failed to read column '{}': {error}", column.name()))?;
        let decoded = decode_value(raw)?;
        value.insert(column.name().to_string(), decoded);
    }

    Ok(value)
}

/// 按 SQLite 声明类型解码单个值。
fn decode_value(value: SqliteValueRef<'_>) -> Result<JsonValue, String> {
    if value.is_null() {
        return Ok(JsonValue::Null);
    }

    match value.type_info().name() {
        "TEXT" => value
            .to_owned()
            .try_decode::<String>()
            .map(JsonValue::String)
            .map_err(|error| format!("Failed to decode TEXT value: {error}")),
        "REAL" => value
            .to_owned()
            .try_decode::<f64>()
            .map(|number| {
                JsonValue::Number(
                    JsonNumber::from_f64(number).unwrap_or_else(|| JsonNumber::from(0)),
                )
            })
            .map_err(|error| format!("Failed to decode REAL value: {error}")),
        "INTEGER" | "NUMERIC" => value
            .to_owned()
            .try_decode::<i64>()
            .map(|number| JsonValue::Number(number.into()))
            .map_err(|error| format!("Failed to decode INTEGER value: {error}")),
        "BOOLEAN" => value
            .to_owned()
            .try_decode::<bool>()
            .map(JsonValue::Bool)
            .map_err(|error| format!("Failed to decode BOOLEAN value: {error}")),
        "BLOB" => value
            .to_owned()
            .try_decode::<Vec<u8>>()
            .map(|bytes| {
                JsonValue::Array(
                    bytes
                        .into_iter()
                        .map(|byte| JsonValue::Number(byte.into()))
                        .collect(),
                )
            })
            .map_err(|error| format!("Failed to decode BLOB value: {error}")),
        "NULL" => Ok(JsonValue::Null),
        other => value
            .to_owned()
            .try_decode::<String>()
            .map(JsonValue::String)
            .map_err(|_| format!("Unsupported SQLite datatype '{other}'")),
    }
}
