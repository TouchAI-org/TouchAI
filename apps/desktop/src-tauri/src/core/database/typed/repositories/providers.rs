// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::cmp::Ordering;

use serde_json::{Map as JsonMap, Value as JsonValue};
use sqlx::SqlitePool;

use super::super::operation::DatabaseOperationError;
use super::super::repository::{fetch_one, fetch_rows, json_object, json_row};
use super::super::row::{delete_by_id, insert_one, update_by_id};

const PROVIDER_COLUMNS: &[&str] = &[
    "name",
    "driver",
    "api_endpoint",
    "api_key",
    "config_json",
    "logo",
    "enabled",
    "is_builtin",
    "created_at",
    "updated_at",
];

const BUILTIN_DISPLAY_ORDER: &[&str] = &[
    "OpenAI",
    "Anthropic",
    "Gemini",
    "Xiaomi MiMo",
    "DeepSeek",
    "火山引擎",
    "Grok",
    "腾讯混元",
    "MiniMax",
    "月之暗面",
    "阿里云百炼",
    "智谱",
];

async fn acquire(
    pool: &SqlitePool,
) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>, DatabaseOperationError> {
    pool.acquire().await.map_err(DatabaseOperationError::from)
}

fn integer(row: &JsonMap<String, JsonValue>, key: &str) -> i64 {
    row.get(key).and_then(JsonValue::as_i64).unwrap_or_default()
}

fn string<'a>(row: &'a JsonMap<String, JsonValue>, key: &str) -> &'a str {
    row.get(key).and_then(JsonValue::as_str).unwrap_or_default()
}

fn display_order(provider: &JsonMap<String, JsonValue>) -> i64 {
    if integer(provider, "is_builtin") != 1 {
        return i64::MAX;
    }

    BUILTIN_DISPLAY_ORDER
        .iter()
        .position(|name| *name == string(provider, "name"))
        .map(|index| index as i64)
        .unwrap_or(i64::MAX - 1)
}

fn compare_provider(
    left: &JsonMap<String, JsonValue>,
    right: &JsonMap<String, JsonValue>,
    default_provider_id: Option<i64>,
) -> Ordering {
    let left_enabled = integer(left, "enabled");
    let right_enabled = integer(right, "enabled");
    if left_enabled != right_enabled {
        return right_enabled.cmp(&left_enabled);
    }

    if left_enabled == 1 {
        let left_default = i64::from(default_provider_id == Some(integer(left, "id")));
        let right_default = i64::from(default_provider_id == Some(integer(right, "id")));
        if left_default != right_default {
            return right_default.cmp(&left_default);
        }
    }

    if left_enabled == 1 {
        let builtin_order = integer(left, "is_builtin").cmp(&integer(right, "is_builtin"));
        if builtin_order != Ordering::Equal {
            return builtin_order;
        }
    }

    display_order(left)
        .cmp(&display_order(right))
        .then_with(|| integer(left, "id").cmp(&integer(right, "id")))
}

pub(super) async fn list(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let mut providers = fetch_rows(&mut connection, "SELECT * FROM providers", Vec::new()).await?;
    let models = fetch_rows(&mut connection, "SELECT * FROM models", Vec::new()).await?;
    let default_provider_id = models
        .iter()
        .find(|model| integer(model, "is_default") == 1)
        .map(|model| integer(model, "provider_id"));

    providers.sort_by(|left, right| compare_provider(left, right, default_provider_id));
    Ok(json_object(providers))
}

pub(super) async fn find(pool: &SqlitePool, id: i64) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM providers WHERE id = ? LIMIT 1",
        vec![JsonValue::Number(id.into())],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn create(
    pool: &SqlitePool,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = insert_one(&mut connection, "providers", &data, PROVIDER_COLUMNS).await?;
    Ok(JsonValue::Object(row))
}

pub(super) async fn update(
    pool: &SqlitePool,
    id: i64,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = update_by_id(&mut connection, "providers", id, &data, PROVIDER_COLUMNS).await?;
    Ok(json_row(row))
}

pub(super) async fn delete(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    delete_by_id(&mut connection, "providers", id).await?;
    Ok(JsonValue::Bool(true))
}
