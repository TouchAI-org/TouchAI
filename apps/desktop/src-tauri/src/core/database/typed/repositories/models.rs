// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sqlx::{Sqlite, SqlitePool, Transaction};

use super::super::model_id;
use super::super::operation::{CatalogModel, DatabaseOperationError, UpstreamMetadataEntry};
use super::super::repository::{
    begin_immediate, fetch_one, fetch_rows, json_object, json_row, run,
};
use super::super::row::{delete_by_id, insert_one, update_by_id};

const MODEL_COLUMNS: &[&str] = &[
    "provider_id",
    "name",
    "model_id",
    "is_default",
    "last_used_at",
    "attachment",
    "modalities",
    "open_weights",
    "reasoning",
    "reasoning_options",
    "release_date",
    "temperature",
    "tool_call",
    "knowledge",
    "context_limit",
    "output_limit",
    "is_custom_metadata",
    "upstream_metadata",
    "created_at",
    "updated_at",
];

const MODEL_WITH_PROVIDER_SELECT: &str = "
    SELECT
        models.id,
        models.created_at,
        models.updated_at,
        models.provider_id,
        models.model_id,
        models.name,
        models.is_default,
        models.last_used_at,
        models.attachment,
        models.modalities,
        models.open_weights,
        models.reasoning,
        models.reasoning_options,
        models.release_date,
        models.temperature,
        models.tool_call,
        models.knowledge,
        models.context_limit,
        models.output_limit,
        models.is_custom_metadata,
        models.upstream_metadata,
        providers.name AS provider_name,
        providers.driver AS provider_driver,
        providers.api_endpoint AS api_endpoint,
        providers.api_key AS api_key,
        providers.config_json AS provider_config_json,
        providers.enabled AS provider_enabled,
        providers.logo AS provider_logo
    FROM models
    INNER JOIN providers ON providers.id = models.provider_id
";

async fn acquire(
    pool: &SqlitePool,
) -> Result<sqlx::pool::PoolConnection<Sqlite>, DatabaseOperationError> {
    pool.acquire().await.map_err(DatabaseOperationError::from)
}

fn integer(row: &JsonMap<String, JsonValue>, key: &str) -> i64 {
    row.get(key).and_then(JsonValue::as_i64).unwrap_or_default()
}

fn optional_text<'a>(row: &'a JsonMap<String, JsonValue>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(JsonValue::as_str)
}

pub(super) async fn list_with_provider(
    pool: &SqlitePool,
    provider_id: Option<i64>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let (sql, params) = match provider_id {
        Some(provider_id) => (
            format!(
                "{MODEL_WITH_PROVIDER_SELECT} WHERE models.provider_id = ? \
                 ORDER BY models.is_default DESC, models.id"
            ),
            vec![JsonValue::Number(provider_id.into())],
        ),
        None => (
            format!("{MODEL_WITH_PROVIDER_SELECT} ORDER BY models.is_default DESC, models.id"),
            Vec::new(),
        ),
    };
    Ok(json_object(
        fetch_rows(&mut connection, &sql, params).await?,
    ))
}

pub(super) async fn find_default_with_provider(
    pool: &SqlitePool,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        &format!(
            "{MODEL_WITH_PROVIDER_SELECT} \
             WHERE models.is_default = 1 AND providers.enabled = 1 \
             ORDER BY models.id LIMIT 1"
        ),
        Vec::new(),
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn find_by_provider_and_model_id(
    pool: &SqlitePool,
    provider_id: i64,
    model_id: String,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        &format!(
            "{MODEL_WITH_PROVIDER_SELECT} \
             WHERE models.provider_id = ? AND models.model_id = ? LIMIT 1"
        ),
        vec![
            JsonValue::Number(provider_id.into()),
            JsonValue::String(model_id),
        ],
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn find_default(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = fetch_one(
        &mut connection,
        "SELECT * FROM models WHERE is_default = 1 LIMIT 1",
        Vec::new(),
    )
    .await?;
    Ok(json_row(row))
}

pub(super) async fn create(
    pool: &SqlitePool,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = insert_one(&mut connection, "models", &data, MODEL_COLUMNS).await?;
    Ok(JsonValue::Object(row))
}

pub(super) async fn update(
    pool: &SqlitePool,
    id: i64,
    data: JsonMap<String, JsonValue>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    let row = update_by_id(&mut connection, "models", id, &data, MODEL_COLUMNS).await?;
    Ok(json_row(row))
}

pub(super) async fn delete(
    pool: &SqlitePool,
    id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = acquire(pool).await?;
    delete_by_id(&mut connection, "models", id).await?;
    Ok(JsonValue::Bool(true))
}

pub(super) async fn set_default(
    pool: &SqlitePool,
    model_id: i64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let target = fetch_one(
        &mut *transaction,
        "SELECT models.id, providers.enabled, providers.name AS provider_name
         FROM models
         INNER JOIN providers ON providers.id = models.provider_id
         WHERE models.id = ? LIMIT 1",
        vec![JsonValue::Number(model_id.into())],
    )
    .await?
    .ok_or_else(|| DatabaseOperationError::with_code("model-not-found", "Model not found"))?;

    if integer(&target, "enabled") == 0 {
        return Err(DatabaseOperationError::with_code(
            "provider-disabled",
            optional_text(&target, "provider_name").unwrap_or_default(),
        ));
    }

    run(
        &mut *transaction,
        "UPDATE models SET is_default = 0 WHERE is_default = 1",
        Vec::new(),
    )
    .await?;
    run(
        &mut *transaction,
        "UPDATE models SET is_default = 1 WHERE id = ?",
        vec![JsonValue::Number(model_id.into())],
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

async fn record_upstream_metadata_on(
    transaction: &mut Transaction<'_, Sqlite>,
    provider_id: i64,
    entries: &[UpstreamMetadataEntry],
) -> Result<(), DatabaseOperationError> {
    if entries.is_empty() {
        return Ok(());
    }
    let payload = serde_json::to_string(entries)
        .map_err(|error| DatabaseOperationError::validation(error.to_string()))?;
    run(
        &mut **transaction,
        "WITH upstream_model_metadata AS (
            SELECT
                json_extract(entry.value, '$.model_id') AS model_id,
                json_extract(entry.value, '$.metadata') AS metadata
            FROM json_each(?) AS entry
        )
        UPDATE models
        SET
            upstream_metadata = json_patch(
                COALESCE(upstream_metadata, '{}'),
                COALESCE((
                    SELECT upstream_model_metadata.metadata
                    FROM upstream_model_metadata
                    WHERE upstream_model_metadata.model_id = models.model_id
                ), '{}')
            ),
            updated_at = datetime('now')
        WHERE provider_id = ?
          AND is_custom_metadata = 0
          AND EXISTS (
            SELECT 1
            FROM upstream_model_metadata
            WHERE upstream_model_metadata.model_id = models.model_id
          )",
        vec![
            JsonValue::String(payload),
            JsonValue::Number(provider_id.into()),
        ],
    )
    .await?;
    Ok(())
}

pub(super) async fn record_upstream_metadata(
    pool: &SqlitePool,
    provider_id: i64,
    entries: Vec<UpstreamMetadataEntry>,
) -> Result<JsonValue, DatabaseOperationError> {
    if entries.is_empty() {
        return Ok(JsonValue::Null);
    }
    let mut transaction = begin_immediate(pool).await?;
    record_upstream_metadata_on(&mut transaction, provider_id, &entries).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

pub(super) async fn persist_catalog(
    pool: &SqlitePool,
    provider_id: i64,
    models: Vec<CatalogModel>,
    entries: Vec<UpstreamMetadataEntry>,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let existing = fetch_rows(
        &mut *transaction,
        "SELECT model_id FROM models WHERE provider_id = ?",
        vec![JsonValue::Number(provider_id.into())],
    )
    .await?;
    let existing_ids = existing
        .iter()
        .filter_map(|row| row.get("model_id").and_then(JsonValue::as_str))
        .collect::<HashSet<_>>();

    let mut added_count = 0usize;
    for model in models {
        if existing_ids.contains(model.model_id.as_str()) {
            continue;
        }
        let data = JsonMap::from_iter([
            (
                "provider_id".to_string(),
                JsonValue::Number(provider_id.into()),
            ),
            ("name".to_string(), JsonValue::String(model.name)),
            ("model_id".to_string(), JsonValue::String(model.model_id)),
            ("is_default".to_string(), JsonValue::Number(0.into())),
        ]);
        insert_one(&mut *transaction, "models", &data, MODEL_COLUMNS).await?;
        added_count += 1;
    }

    record_upstream_metadata_on(&mut transaction, provider_id, &entries).await?;
    sync_metadata_on(&mut transaction).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(json!({ "addedCount": added_count }))
}

pub(super) async fn sync_metadata(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    sync_metadata_on(&mut transaction).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

#[derive(Debug, Clone)]
struct MetadataRecord {
    model_id: String,
    attachment: i64,
    modalities: String,
    open_weights: i64,
    reasoning: i64,
    reasoning_options: Option<String>,
    release_date: Option<String>,
    temperature: i64,
    tool_call: i64,
    knowledge: Option<String>,
    context_limit: Option<i64>,
    output_limit: Option<i64>,
}

#[derive(Debug, Clone)]
struct RankedMatch {
    depth: usize,
    metadata: MetadataRecord,
}

fn metadata_richness(record: &MetadataRecord) -> i64 {
    record.attachment
        + record.open_weights
        + record.reasoning
        + record.temperature
        + record.tool_call
        + i64::from(!record.modalities.is_empty())
}

fn is_better_match(candidate: &RankedMatch, current: &RankedMatch) -> bool {
    if candidate.depth != current.depth {
        return candidate.depth < current.depth;
    }

    let candidate_score = metadata_richness(&candidate.metadata);
    let current_score = metadata_richness(&current.metadata);
    if candidate_score != current_score {
        return candidate_score > current_score;
    }

    let candidate_len = candidate.metadata.model_id.len();
    let current_len = current.metadata.model_id.len();
    if candidate_len != current_len {
        return candidate_len > current_len;
    }

    candidate.metadata.model_id < current.metadata.model_id
}

fn parse_model_limit(limit: Option<&str>) -> (Option<i64>, Option<i64>) {
    let Some(limit) = limit else {
        return (None, None);
    };
    let Ok(parsed) = serde_json::from_str::<JsonValue>(limit) else {
        return (None, None);
    };
    let context = parsed.get("context").and_then(JsonValue::as_i64);
    let output = parsed.get("output").and_then(JsonValue::as_i64);
    (context, output)
}

fn metadata_record(row: &JsonMap<String, JsonValue>) -> MetadataRecord {
    let (context_limit, output_limit) = parse_model_limit(optional_text(row, "limit"));
    MetadataRecord {
        model_id: optional_text(row, "model_id")
            .unwrap_or_default()
            .to_string(),
        attachment: integer(row, "attachment"),
        modalities: optional_text(row, "modalities")
            .unwrap_or_default()
            .to_string(),
        open_weights: integer(row, "open_weights"),
        reasoning: integer(row, "reasoning"),
        reasoning_options: optional_text(row, "reasoning_options").map(str::to_string),
        release_date: optional_text(row, "release_date").map(str::to_string),
        temperature: integer(row, "temperature"),
        tool_call: integer(row, "tool_call"),
        knowledge: optional_text(row, "knowledge").map(str::to_string),
        context_limit,
        output_limit,
    }
}

fn parse_upstream_metadata(value: Option<&str>) -> Option<JsonMap<String, JsonValue>> {
    let value = value?;
    let parsed = serde_json::from_str::<JsonValue>(value).ok()?;
    parsed.as_object().cloned()
}

fn resolve_update_row(
    target: &JsonMap<String, JsonValue>,
    metadata: Option<&MetadataRecord>,
) -> Option<JsonMap<String, JsonValue>> {
    let upstream = parse_upstream_metadata(optional_text(target, "upstream_metadata"));
    if upstream.is_none() && metadata.is_none() {
        return None;
    }

    let upstream_reasoning = upstream
        .as_ref()
        .and_then(|value| value.get("reasoning"))
        .and_then(JsonValue::as_i64);
    let clear_reasoning_options = upstream_reasoning == Some(0);

    let get_upstream = |key: &str| {
        upstream
            .as_ref()
            .and_then(|value| value.get(key))
            .cloned()
            .unwrap_or(JsonValue::Null)
    };
    let metadata_value = |getter: fn(&MetadataRecord) -> Option<JsonValue>| {
        metadata.and_then(getter).unwrap_or(JsonValue::Null)
    };
    let first_non_null = |upstream_value: JsonValue, fallback: JsonValue| {
        if upstream_value.is_null() {
            fallback
        } else {
            upstream_value
        }
    };

    let attachment = first_non_null(
        get_upstream("attachment"),
        metadata_value(|value| Some(JsonValue::Number(value.attachment.into()))),
    );
    let modalities = first_non_null(
        get_upstream("modalities"),
        metadata_value(|value| Some(JsonValue::String(value.modalities.clone()))),
    );
    let reasoning = first_non_null(
        get_upstream("reasoning"),
        metadata_value(|value| Some(JsonValue::Number(value.reasoning.into()))),
    );
    let reasoning_options = if clear_reasoning_options {
        JsonValue::Null
    } else {
        first_non_null(
            get_upstream("reasoning_options"),
            metadata_value(|value| value.reasoning_options.clone().map(JsonValue::String)),
        )
    };
    let tool_call = first_non_null(
        get_upstream("tool_call"),
        metadata_value(|value| Some(JsonValue::Number(value.tool_call.into()))),
    );
    let context_limit = first_non_null(
        get_upstream("context_limit"),
        metadata_value(|value| {
            value
                .context_limit
                .map(|number| JsonValue::Number(number.into()))
        }),
    );
    let output_limit = first_non_null(
        get_upstream("output_limit"),
        metadata_value(|value| {
            value
                .output_limit
                .map(|number| JsonValue::Number(number.into()))
        }),
    );

    Some(JsonMap::from_iter([
        (
            "id".to_string(),
            target.get("id").cloned().unwrap_or(JsonValue::Null),
        ),
        ("attachment".to_string(), attachment),
        ("modalities".to_string(), modalities),
        (
            "open_weights".to_string(),
            metadata_value(|value| Some(JsonValue::Number(value.open_weights.into()))),
        ),
        ("reasoning".to_string(), reasoning),
        ("reasoning_options".to_string(), reasoning_options),
        (
            "release_date".to_string(),
            metadata_value(|value| value.release_date.clone().map(JsonValue::String)),
        ),
        (
            "temperature".to_string(),
            metadata_value(|value| Some(JsonValue::Number(value.temperature.into()))),
        ),
        ("tool_call".to_string(), tool_call),
        (
            "knowledge".to_string(),
            metadata_value(|value| value.knowledge.clone().map(JsonValue::String)),
        ),
        ("context_limit".to_string(), context_limit),
        ("output_limit".to_string(), output_limit),
        (
            "clear_reasoning_options".to_string(),
            JsonValue::Number(i64::from(clear_reasoning_options).into()),
        ),
    ]))
}

pub(super) async fn sync_metadata_on(
    transaction: &mut Transaction<'_, Sqlite>,
) -> Result<(), DatabaseOperationError> {
    let targets = fetch_rows(
        &mut *transaction,
        "SELECT id, model_id, upstream_metadata FROM models WHERE is_custom_metadata = 0",
        Vec::new(),
    )
    .await?;
    if targets.is_empty() {
        return Ok(());
    }

    let candidate_ids = targets
        .iter()
        .flat_map(|target| {
            model_id::expand(optional_text(target, "model_id").unwrap_or_default())
                .into_iter()
                .map(|candidate| candidate.value)
        })
        .collect::<HashSet<_>>();

    let aliases = fetch_rows(
        &mut *transaction,
        "SELECT alias, model_id FROM llm_metadata_aliases",
        Vec::new(),
    )
    .await?;
    let alias_targets = aliases
        .iter()
        .filter_map(|row| {
            let alias = optional_text(row, "alias")?;
            if !candidate_ids.contains(alias) {
                return None;
            }
            Some((
                alias.to_string(),
                optional_text(row, "model_id")?.to_string(),
            ))
        })
        .collect::<HashMap<_, _>>();

    if alias_targets.is_empty() {
        return Ok(());
    }

    let metadata_rows = fetch_rows(
        &mut *transaction,
        "SELECT model_id, attachment, modalities, open_weights, reasoning,
                reasoning_options, release_date, temperature, tool_call, knowledge, limit
         FROM llm_metadata",
        Vec::new(),
    )
    .await?;
    let metadata_by_model = metadata_rows
        .iter()
        .map(|row| {
            let record = metadata_record(row);
            (record.model_id.clone(), record)
        })
        .collect::<HashMap<_, _>>();

    let mut updates = Vec::new();
    for target in &targets {
        let mut best: Option<RankedMatch> = None;
        for candidate in model_id::expand(optional_text(target, "model_id").unwrap_or_default()) {
            let Some(metadata_model_id) = alias_targets.get(&candidate.value) else {
                continue;
            };
            let Some(metadata) = metadata_by_model.get(metadata_model_id) else {
                continue;
            };
            let ranked = RankedMatch {
                depth: candidate.depth,
                metadata: metadata.clone(),
            };
            if best
                .as_ref()
                .is_none_or(|current| is_better_match(&ranked, current))
            {
                best = Some(ranked);
            }
        }
        if let Some(row) = resolve_update_row(target, best.as_ref().map(|match_| &match_.metadata))
        {
            updates.push(JsonValue::Object(row));
        }
    }

    if updates.is_empty() {
        return Ok(());
    }
    let payload = serde_json::to_string(&updates)
        .map_err(|error| DatabaseOperationError::validation(error.to_string()))?;
    run(
        &mut **transaction,
        "WITH selected_model_metadata AS (
            SELECT
                json_extract(entry.value, '$.id') AS model_row_id,
                json_extract(entry.value, '$.attachment') AS attachment,
                json_extract(entry.value, '$.modalities') AS modalities,
                json_extract(entry.value, '$.open_weights') AS open_weights,
                json_extract(entry.value, '$.reasoning') AS reasoning,
                json_extract(entry.value, '$.reasoning_options') AS reasoning_options,
                json_extract(entry.value, '$.release_date') AS release_date,
                json_extract(entry.value, '$.temperature') AS temperature,
                json_extract(entry.value, '$.tool_call') AS tool_call,
                json_extract(entry.value, '$.knowledge') AS knowledge,
                json_extract(entry.value, '$.context_limit') AS context_limit,
                json_extract(entry.value, '$.output_limit') AS output_limit,
                json_extract(entry.value, '$.clear_reasoning_options') AS clear_reasoning_options
            FROM json_each(?) AS entry
        )
        UPDATE models
        SET
            attachment = COALESCE((
                SELECT selected_model_metadata.attachment
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), attachment),
            modalities = COALESCE((
                SELECT selected_model_metadata.modalities
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), modalities),
            open_weights = COALESCE((
                SELECT selected_model_metadata.open_weights
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), open_weights),
            reasoning = COALESCE((
                SELECT selected_model_metadata.reasoning
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), reasoning),
            reasoning_options = CASE
                WHEN (
                    SELECT selected_model_metadata.clear_reasoning_options
                    FROM selected_model_metadata
                    WHERE selected_model_metadata.model_row_id = models.id
                ) = 1 THEN NULL
                ELSE COALESCE((
                    SELECT selected_model_metadata.reasoning_options
                    FROM selected_model_metadata
                    WHERE selected_model_metadata.model_row_id = models.id
                ), reasoning_options)
            END,
            release_date = COALESCE((
                SELECT selected_model_metadata.release_date
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), release_date),
            temperature = COALESCE((
                SELECT selected_model_metadata.temperature
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), temperature),
            tool_call = COALESCE((
                SELECT selected_model_metadata.tool_call
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), tool_call),
            knowledge = COALESCE((
                SELECT selected_model_metadata.knowledge
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), knowledge),
            context_limit = COALESCE((
                SELECT selected_model_metadata.context_limit
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), context_limit),
            output_limit = COALESCE((
                SELECT selected_model_metadata.output_limit
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), output_limit),
            updated_at = datetime('now')
        WHERE is_custom_metadata = 0
          AND EXISTS (
              SELECT 1
              FROM selected_model_metadata
              WHERE selected_model_metadata.model_row_id = models.id
          )",
        vec![JsonValue::String(payload)],
    )
    .await?;
    Ok(())
}
