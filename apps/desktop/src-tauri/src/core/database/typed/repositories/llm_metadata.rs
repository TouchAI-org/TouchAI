// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sqlx::{Sqlite, SqlitePool, Transaction};

use super::super::model_id;
use super::super::operation::DatabaseOperationError;
use super::super::repository::{begin_immediate, fetch_one, fetch_rows, json_row, run};
use super::super::row::{count, insert_many_ignore};
use super::models;

const LLM_METADATA_COLUMNS: &[&str] = &[
    "model_id",
    "name",
    "attachment",
    "modalities",
    "open_weights",
    "reasoning",
    "reasoning_options",
    "release_date",
    "temperature",
    "tool_call",
    "knowledge",
    "limit",
    "input_cost_per_million",
    "output_cost_per_million",
    "cache_read_cost_per_million",
    "cache_write_cost_per_million",
    "reasoning_cost_per_million",
    "cost_currency",
    "cost_tiers",
    "created_at",
    "updated_at",
];

const LLM_ALIAS_COLUMNS: &[&str] = &["alias", "model_id"];

const ISO_FORMAT: &[time::format_description::FormatItem<'static>] = time::macros::format_description!(
    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
);

async fn acquire(
    pool: &SqlitePool,
) -> Result<sqlx::pool::PoolConnection<Sqlite>, DatabaseOperationError> {
    pool.acquire().await.map_err(DatabaseOperationError::from)
}

fn now_iso() -> Result<String, DatabaseOperationError> {
    time::OffsetDateTime::now_utc()
        .format(ISO_FORMAT)
        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))
}

fn text<'a>(row: &'a JsonMap<String, JsonValue>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(JsonValue::as_str)
}

pub(super) async fn find(
    pool: &SqlitePool,
    model_id: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM llm_metadata WHERE model_id = ? LIMIT 1",
        vec![JsonValue::String(model_id)],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn insert(
    pool: &SqlitePool,
    data: Vec<JsonMap<String, JsonValue>>,
) -> Result<JsonValue, DatabaseOperationError> {
    if data.is_empty() {
        return Ok(JsonValue::Null);
    }
    let mut transaction = begin_immediate(pool).await?;
    insert_many_ignore(
        &mut transaction,
        "llm_metadata",
        &data,
        LLM_METADATA_COLUMNS,
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

pub(super) async fn clear(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    run(
        &mut *transaction,
        "DELETE FROM llm_metadata_aliases",
        Vec::new(),
    )
    .await?;
    run(&mut *transaction, "DELETE FROM llm_metadata", Vec::new()).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

pub(super) async fn is_empty(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    Ok(JsonValue::Bool(
        count(
            &mut connection,
            "SELECT count(*) AS count FROM llm_metadata",
            Vec::new(),
        )
        .await?
            == 0,
    ))
}

pub(super) async fn alias_is_empty(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    Ok(JsonValue::Bool(
        count(
            &mut connection,
            "SELECT count(*) AS count FROM llm_metadata_aliases",
            Vec::new(),
        )
        .await?
            == 0,
    ))
}

fn number_text(value: Option<&JsonValue>) -> String {
    value
        .filter(|value| !value.is_null())
        .map(JsonValue::to_string)
        .unwrap_or_default()
}

fn parse_tiers(raw: Option<&str>) -> Vec<JsonValue> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let Ok(JsonValue::Array(tiers)) = serde_json::from_str::<JsonValue>(raw) else {
        return Vec::new();
    };

    let mut parsed = tiers
        .into_iter()
        .filter_map(|tier| {
            let above = tier.get("above").and_then(JsonValue::as_f64)?;
            if above <= 0.0 {
                return None;
            }
            Some((
                above,
                json!({
                    "above": above,
                    "inputPerMillion": number_text(tier.get("input")),
                    "outputPerMillion": number_text(tier.get("output")),
                    "cacheReadPerMillion": number_text(tier.get("cacheRead")),
                    "cacheWritePerMillion": number_text(tier.get("cacheWrite")),
                    "reasoningPerMillion": number_text(tier.get("reasoning")),
                }),
            ))
        })
        .collect::<Vec<_>>();
    parsed.sort_by(|left, right| left.0.total_cmp(&right.0));
    parsed.into_iter().map(|(_, value)| value).collect()
}

pub(super) async fn find_pricing(
    pool: &SqlitePool,
    raw_model_id: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let candidates = model_id::expand(&raw_model_id);
    if candidates.is_empty() {
        return Ok(JsonValue::Null);
    }
    let candidate_values = candidates
        .iter()
        .map(|candidate| candidate.value.clone())
        .collect::<Vec<_>>();
    let candidate_set = candidate_values.iter().cloned().collect::<HashSet<_>>();

    let mut connection = acquire(pool).await?;
    let aliases = fetch_rows(
        &mut connection,
        "SELECT alias, model_id FROM llm_metadata_aliases",
        Vec::new(),
    )
    .await?;
    let mut alias_lookup = Vec::new();
    for row in &aliases {
        let Some(alias) = text(row, "alias") else {
            continue;
        };
        if !candidate_set.contains(alias) {
            continue;
        }
        if let Some(model_id) = text(row, "model_id") {
            alias_lookup.push(model_id.to_string());
        }
    }

    let mut lookup_order = candidate_values;
    for model_id in alias_lookup {
        if !lookup_order.contains(&model_id) {
            lookup_order.push(model_id);
        }
    }
    let rank = lookup_order
        .iter()
        .enumerate()
        .map(|(index, value)| (value.clone(), index))
        .collect::<HashMap<_, _>>();

    let placeholders = std::iter::repeat_n("?", lookup_order.len())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT model_id, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_write_cost_per_million,
                reasoning_cost_per_million, cost_currency, cost_tiers
         FROM llm_metadata WHERE model_id IN ({placeholders})"
    );
    let rows = fetch_rows(
        &mut connection,
        &sql,
        lookup_order.into_iter().map(JsonValue::String).collect(),
    )
    .await?;
    let mut priced = rows
        .into_iter()
        .filter(|row| {
            !row.get("input_cost_per_million")
                .is_none_or(JsonValue::is_null)
                && !row
                    .get("output_cost_per_million")
                    .is_none_or(JsonValue::is_null)
        })
        .collect::<Vec<_>>();
    priced.sort_by_key(|row| {
        rank.get(text(row, "model_id").unwrap_or_default())
            .copied()
            .unwrap_or(usize::MAX)
    });

    let Some(best) = priced.into_iter().next() else {
        return Ok(JsonValue::Null);
    };
    let output = number_text(best.get("output_cost_per_million"));
    let reasoning = best
        .get("reasoning_cost_per_million")
        .filter(|value| !value.is_null())
        .map(JsonValue::to_string)
        .unwrap_or_else(|| output.clone());
    Ok(json!({
        "modelId": text(&best, "model_id").unwrap_or_default(),
        "inputPerMillion": number_text(best.get("input_cost_per_million")),
        "outputPerMillion": output,
        "cacheReadPerMillion": best
            .get("cache_read_cost_per_million")
            .filter(|value| !value.is_null())
            .map(JsonValue::to_string)
            .unwrap_or_else(|| "0".to_string()),
        "cacheWritePerMillion": best
            .get("cache_write_cost_per_million")
            .filter(|value| !value.is_null())
            .map(JsonValue::to_string)
            .unwrap_or_else(|| "0".to_string()),
        "reasoningPerMillion": reasoning,
        "currency": text(&best, "cost_currency").unwrap_or("USD"),
        "tiers": parse_tiers(text(&best, "cost_tiers")),
    }))
}

pub(super) async fn count_priced(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    Ok(JsonValue::Number(
        count(
            &mut connection,
            "SELECT count(*) AS count FROM llm_metadata
             WHERE input_cost_per_million IS NOT NULL
               AND output_cost_per_million IS NOT NULL",
            Vec::new(),
        )
        .await?
        .into(),
    ))
}

async fn upsert_statistic(
    transaction: &mut Transaction<'_, Sqlite>,
    key: &str,
    value: &str,
) -> Result<(), DatabaseOperationError> {
    run(
        &mut **transaction,
        "INSERT INTO statistics (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        vec![
            JsonValue::String(key.to_string()),
            JsonValue::String(value.to_string()),
        ],
    )
    .await?;
    Ok(())
}

pub(super) async fn replace(
    pool: &SqlitePool,
    metadata: Vec<JsonMap<String, JsonValue>>,
    aliases: Vec<JsonMap<String, JsonValue>>,
    mark_updated_at: bool,
    source_etag: Option<String>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    run(
        &mut *transaction,
        "DELETE FROM llm_metadata_aliases",
        Vec::new(),
    )
    .await?;
    run(&mut *transaction, "DELETE FROM llm_metadata", Vec::new()).await?;
    insert_many_ignore(
        &mut transaction,
        "llm_metadata",
        &metadata,
        LLM_METADATA_COLUMNS,
    )
    .await?;
    insert_many_ignore(
        &mut transaction,
        "llm_metadata_aliases",
        &aliases,
        LLM_ALIAS_COLUMNS,
    )
    .await?;
    models::sync_metadata_on(&mut transaction).await?;

    if mark_updated_at {
        let now = now_iso()?;
        upsert_statistic(&mut transaction, "model_metadata_last_updated_at", &now).await?;
        upsert_statistic(&mut transaction, "model_metadata_last_checked_at", &now).await?;
        if let Some(etag) = source_etag {
            upsert_statistic(&mut transaction, "model_metadata_source_etag", &etag).await?;
        }
    }

    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

pub(super) async fn mark_checked(
    pool: &SqlitePool,
    checked_at: String,
    etag: Option<String>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    upsert_statistic(
        &mut transaction,
        "model_metadata_last_checked_at",
        &checked_at,
    )
    .await?;
    if let Some(etag) = etag {
        upsert_statistic(&mut transaction, "model_metadata_source_etag", &etag).await?;
    }
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}
