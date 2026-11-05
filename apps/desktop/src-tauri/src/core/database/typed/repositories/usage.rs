// Copyright (c) 2026. 千诚. Licensed under GPL v3.

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sqlx::{SqliteConnection, SqlitePool};
use time::{
    format_description::{well_known::Rfc3339, FormatItem},
    macros::format_description,
    OffsetDateTime, PrimitiveDateTime,
};

use super::super::operation::{
    DatabaseOperationError, LlmCallPartInput, UsageDimension, UsageFilterInput, UsageRankMetric,
};
use super::super::repository::{begin_immediate, fetch_one, fetch_rows, run};

const DB_TIME_FORMAT: &[FormatItem<'static>] =
    format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;
const TARGET_BUCKETS: i64 = 48;
const SAMPLE_LIMIT: u32 = 5_000;
const COMPACTION_MIN_TOKENS: f64 = 20_000.0;
const COMPACTION_RATIO: f64 = 0.6;
const SHARE_ORDER: [&str; 6] = [
    "systemPrompt",
    "builtinToolDefinitions",
    "mcpToolDefinitions",
    "conversation",
    "userPrompt",
    "attachments",
];
const BUCKET_STEPS: [i64; 12] = [
    60_000,
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    HOUR_MS,
    2 * HOUR_MS,
    3 * HOUR_MS,
    6 * HOUR_MS,
    12 * HOUR_MS,
    DAY_MS,
];

const ROLLUP_SQL: &str = "
    INSERT INTO usage_daily_rollups (
        day, model_name, provider_name,
        request_count, success_count,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, total_cost_micros, unpriced_count,
        sum_ttft_ms, sum_duration_ms, ttft_sample_count
    )
    SELECT
        date(t.created_at) AS day,
        coalesce(m.name, '—') AS model_name,
        coalesce(p.name, '—') AS provider_name,
        count(*) AS request_count,
        sum(CASE WHEN t.status = 'completed' THEN 1 ELSE 0 END) AS success_count,
        coalesce(sum(t.input_tokens), 0),
        coalesce(sum(t.output_tokens), 0),
        coalesce(sum(t.cache_read_tokens), 0),
        coalesce(sum(t.cache_write_tokens), 0),
        coalesce(sum(t.reasoning_tokens), 0),
        coalesce(sum(t.total_cost_micros), 0),
        coalesce(sum(t.unpriced_calls), 0),
        coalesce(sum(t.ttft_ms), 0),
        coalesce(sum(t.duration_ms), 0),
        count(t.ttft_ms) AS ttft_sample_count
    FROM session_turns t
    LEFT JOIN models m ON m.id = t.model_id
    LEFT JOIN providers p ON p.id = m.provider_id
    GROUP BY day, model_name, provider_name
    ON CONFLICT(day, model_name, provider_name) DO UPDATE SET
        request_count = excluded.request_count,
        success_count = excluded.success_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_cost_micros = excluded.total_cost_micros,
        unpriced_count = excluded.unpriced_count,
        sum_ttft_ms = excluded.sum_ttft_ms,
        sum_duration_ms = excluded.sum_duration_ms,
        ttft_sample_count = excluded.ttft_sample_count
";

struct WhereClause {
    sql: String,
    params: Vec<JsonValue>,
}

struct TrendSegment {
    group_id: Option<i64>,
    name: String,
    requests: i64,
    tokens: i64,
    cost_micros: i64,
}

struct TrendPoint {
    key: String,
    requests: i64,
    tokens: i64,
    cost_micros: i64,
    segments: Vec<TrendSegment>,
}

#[derive(Clone)]
struct RawTurnSample {
    turn_id: i64,
    created_at: String,
    model_id: i64,
    model_name: String,
    window: f64,
    prompt_tokens: f64,
    cache_read_tokens: f64,
    input_tokens: f64,
    breakdown: Option<String>,
    failed: bool,
}

fn integer(row: &JsonMap<String, JsonValue>, key: &str) -> i64 {
    row.get(key)
        .and_then(JsonValue::as_i64)
        .or_else(|| {
            row.get(key)
                .and_then(JsonValue::as_f64)
                .map(|value| value as i64)
        })
        .unwrap_or_default()
}

fn number(row: &JsonMap<String, JsonValue>, key: &str) -> f64 {
    row.get(key)
        .and_then(JsonValue::as_f64)
        .or_else(|| {
            row.get(key)
                .and_then(JsonValue::as_i64)
                .map(|value| value as f64)
        })
        .unwrap_or_default()
}

fn text(row: &JsonMap<String, JsonValue>, key: &str) -> String {
    row.get(key)
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string()
}

fn optional_text(row: &JsonMap<String, JsonValue>, key: &str) -> Option<String> {
    row.get(key)
        .and_then(JsonValue::as_str)
        .map(ToString::to_string)
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(", ")
}

fn push_integer_values(params: &mut Vec<JsonValue>, values: &[i64]) {
    params.extend(values.iter().map(|value| json!(value)));
}

fn push_text_values(params: &mut Vec<JsonValue>, values: &[String]) {
    params.extend(values.iter().map(|value| JsonValue::String(value.clone())));
}

fn validate_statuses(statuses: &[String]) -> Result<(), DatabaseOperationError> {
    const ALLOWED: [&str; 5] = ["pending", "streaming", "completed", "failed", "cancelled"];
    if let Some(status) = statuses
        .iter()
        .find(|status| !ALLOWED.contains(&status.as_str()))
    {
        return Err(DatabaseOperationError::validation(format!(
            "Unsupported usage status '{status}'"
        )));
    }
    Ok(())
}

fn turn_where(filter: &UsageFilterInput) -> Result<WhereClause, DatabaseOperationError> {
    let mut conditions = vec!["session_turns.created_at BETWEEN ? AND ?".to_string()];
    let mut params = vec![
        JsonValue::String(filter.from.clone()),
        JsonValue::String(filter.to.clone()),
    ];

    if let Some(model_ids) = filter.model_ids.as_deref().filter(|ids| !ids.is_empty()) {
        conditions.push(format!(
            "session_turns.model_id IN ({})",
            placeholders(model_ids.len())
        ));
        push_integer_values(&mut params, model_ids);
    }
    if let Some(provider_ids) = filter.provider_ids.as_deref().filter(|ids| !ids.is_empty()) {
        conditions.push(format!(
            "session_turns.model_id IN (
                SELECT models.id FROM models
                WHERE models.provider_id IN ({})
            )",
            placeholders(provider_ids.len())
        ));
        push_integer_values(&mut params, provider_ids);
    }
    if let Some(statuses) = filter.statuses.as_deref().filter(|items| !items.is_empty()) {
        validate_statuses(statuses)?;
        conditions.push(format!(
            "session_turns.status IN ({})",
            placeholders(statuses.len())
        ));
        push_text_values(&mut params, statuses);
    }
    if filter.only_failed.unwrap_or(false) {
        conditions.push("session_turns.status = 'failed'".to_string());
    }
    if filter.only_retried.unwrap_or(false) {
        conditions.push(
            "(SELECT count(*) FROM session_turn_attempts
              WHERE session_turn_attempts.turn_id = session_turns.id) > 1"
                .to_string(),
        );
    }
    if let Some(search) = filter
        .search
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        conditions.push(
            "(session_turns.error_message LIKE ?
              OR session_turns.model_id IN (
                  SELECT models.id
                  FROM models
                  INNER JOIN providers ON providers.id = models.provider_id
                  WHERE models.name LIKE ?
                     OR models.model_id LIKE ?
                     OR providers.name LIKE ?
              ))"
            .to_string(),
        );
        let pattern = format!("%{search}%");
        for _ in 0..4 {
            params.push(JsonValue::String(pattern.clone()));
        }
    }

    Ok(WhereClause {
        sql: format!(" WHERE {}", conditions.join(" AND ")),
        params,
    })
}

fn sample_where(filter: &UsageFilterInput) -> Result<WhereClause, DatabaseOperationError> {
    let mut where_clause = turn_where(filter)?;
    where_clause
        .sql
        .push_str(" AND session_turns.prompt_breakdown_json IS NOT NULL");
    Ok(where_clause)
}

fn percent_round(sum: i64, count: i64) -> Option<i64> {
    (count > 0).then(|| (sum as f64 / count as f64).round() as i64)
}

fn cache_hit_rate(input: i64, cache_read: i64, cache_write: i64) -> f64 {
    let denominator = input + cache_write + cache_read;
    if denominator > 0 {
        cache_read as f64 / denominator as f64
    } else {
        0.0
    }
}

async fn summary_on(
    connection: &mut SqliteConnection,
    filter: &UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let where_clause = turn_where(filter)?;
    let row = fetch_one(
        connection,
        &format!(
            "SELECT
                 count(*) AS request_count,
                 coalesce(sum(CASE WHEN session_turns.status = 'completed' THEN 1 ELSE 0 END), 0)
                     AS success_count,
                 coalesce(sum(session_turns.total_cost_micros), 0) AS total_cost_micros,
                 coalesce(sum(session_turns.unpriced_calls), 0) AS unpriced_count,
                 coalesce(sum(session_turns.input_tokens), 0) AS input_tokens,
                 coalesce(sum(session_turns.output_tokens), 0) AS output_tokens,
                 coalesce(sum(session_turns.cache_read_tokens), 0) AS cache_read_tokens,
                 coalesce(sum(session_turns.cache_write_tokens), 0) AS cache_write_tokens,
                 coalesce(sum(session_turns.reasoning_tokens), 0) AS reasoning_tokens,
                 coalesce(sum(session_turns.ttft_ms), 0) AS sum_ttft,
                 count(session_turns.ttft_ms) AS ttft_count,
                 coalesce(sum(session_turns.first_text_ms), 0) AS sum_first_text,
                 count(session_turns.first_text_ms) AS first_text_count,
                 coalesce(sum(session_turns.duration_ms), 0) AS sum_duration,
                 count(session_turns.duration_ms) AS duration_count,
                 count(DISTINCT session_turns.session_id) AS session_count,
                 count(DISTINCT date(session_turns.created_at, 'localtime')) AS active_day_count,
                 min(session_turns.created_at) AS first_request_at
             FROM session_turns{}",
            where_clause.sql
        ),
        where_clause.params,
    )
    .await?
    .unwrap_or_default();

    let request_count = integer(&row, "request_count");
    let success_count = integer(&row, "success_count");
    let input_tokens = integer(&row, "input_tokens");
    let output_tokens = integer(&row, "output_tokens");
    let cache_read_tokens = integer(&row, "cache_read_tokens");
    let cache_write_tokens = integer(&row, "cache_write_tokens");
    let mean_duration_ms = percent_round(
        integer(&row, "sum_duration"),
        integer(&row, "duration_count"),
    );
    let decode_speed = mean_duration_ms
        .filter(|duration| *duration > 0)
        .and_then(|duration| {
            (request_count > 0 && output_tokens > 0)
                .then_some(output_tokens as f64 / request_count as f64 / (duration as f64 / 1000.0))
        });

    Ok(json!({
        "requestCount": request_count,
        "sessionCount": integer(&row, "session_count"),
        "activeDayCount": integer(&row, "active_day_count"),
        "totalDurationMs": integer(&row, "sum_duration"),
        "firstRequestAt": optional_text(&row, "first_request_at"),
        "successCount": success_count,
        "totalCostMicros": integer(&row, "total_cost_micros"),
        "unpricedCount": integer(&row, "unpriced_count"),
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "cacheReadTokens": cache_read_tokens,
        "cacheWriteTokens": cache_write_tokens,
        "reasoningTokens": integer(&row, "reasoning_tokens"),
        "realTotalTokens": input_tokens + output_tokens + cache_read_tokens + cache_write_tokens,
        "cacheHitRate": cache_hit_rate(input_tokens, cache_read_tokens, cache_write_tokens),
        "successRate": if request_count > 0 {
            success_count as f64 / request_count as f64
        } else {
            0.0
        },
        "meanTtftMs": percent_round(
            integer(&row, "sum_ttft"),
            integer(&row, "ttft_count"),
        ),
        "meanFirstTextMs": percent_round(
            integer(&row, "sum_first_text"),
            integer(&row, "first_text_count"),
        ),
        "meanDurationMs": mean_duration_ms,
        "decodeSpeed": decode_speed,
    }))
}

fn parse_usage_time(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok().or_else(|| {
        PrimitiveDateTime::parse(value, DB_TIME_FORMAT)
            .ok()
            .map(|value| value.assume_utc())
    })
}

fn resolve_bucket_ms(filter: &UsageFilterInput) -> i64 {
    let span_ms = match (parse_usage_time(&filter.from), parse_usage_time(&filter.to)) {
        (Some(from), Some(to)) => (to - from).whole_milliseconds() as i64,
        _ => 0,
    };
    if span_ms <= 0 {
        return 10 * 60_000;
    }

    let ideal = span_ms as f64 / TARGET_BUCKETS as f64;
    BUCKET_STEPS
        .iter()
        .copied()
        .find(|step| *step as f64 >= ideal)
        .unwrap_or(DAY_MS)
}

fn bucket_kind(bucket_ms: i64) -> &'static str {
    if bucket_ms >= DAY_MS {
        "day"
    } else if bucket_ms >= HOUR_MS {
        "hour"
    } else {
        "minute"
    }
}

fn format_bucket_key(
    bucket_index: i64,
    bucket_seconds: i64,
    kind: &str,
) -> Result<String, DatabaseOperationError> {
    let at = OffsetDateTime::from_unix_timestamp(bucket_index * bucket_seconds)
        .map_err(|error| DatabaseOperationError::unavailable(error.to_string()))?;
    let day = format!(
        "{:04}-{:02}-{:02}",
        at.year(),
        u8::from(at.month()),
        at.day()
    );
    Ok(match kind {
        "day" => day,
        "hour" => format!("{day} {:02}:00", at.hour()),
        _ => format!("{day} {:02}:{:02}", at.hour(), at.minute()),
    })
}

fn dimension_columns(dimension: UsageDimension) -> (&'static str, &'static str) {
    match dimension {
        UsageDimension::Model => ("models.id", "models.name"),
        UsageDimension::Provider => ("coalesce(providers.id, 0)", "coalesce(providers.name, '—')"),
    }
}

async fn trend_on(
    connection: &mut SqliteConnection,
    filter: &UsageFilterInput,
    dimension: UsageDimension,
) -> Result<JsonValue, DatabaseOperationError> {
    let bucket_ms = resolve_bucket_ms(filter);
    let bucket = bucket_kind(bucket_ms);
    let bucket_seconds = (bucket_ms / 1000).max(60);
    let where_clause = turn_where(filter)?;
    let (group_id, group_name) = dimension_columns(dimension);
    let mut params = vec![json!(bucket_seconds)];
    params.extend(where_clause.params);

    let rows = fetch_rows(
        connection,
        &format!(
            "SELECT
                 cast(
                     cast(strftime('%s', session_turns.created_at) AS integer) / ?
                     AS integer
                 ) AS bucket_key,
                 {group_id} AS group_id,
                 {group_name} AS group_name,
                 count(*) AS requests,
                 coalesce(sum(
                     session_turns.input_tokens + session_turns.output_tokens
                     + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                 ), 0) AS tokens,
                 coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             LEFT JOIN providers ON providers.id = models.provider_id
             {}
             GROUP BY bucket_key, group_id, group_name
             ORDER BY bucket_key",
            where_clause.sql
        ),
        params,
    )
    .await?;

    let mut by_bucket: BTreeMap<i64, TrendPoint> = BTreeMap::new();
    for row in rows {
        let bucket_index = integer(&row, "bucket_key");
        let requests = integer(&row, "requests");
        let tokens = integer(&row, "tokens");
        let cost_micros = integer(&row, "cost_micros");
        let entry = by_bucket.entry(bucket_index).or_insert_with(|| TrendPoint {
            key: format_bucket_key(bucket_index, bucket_seconds, bucket)
                .unwrap_or_else(|_| bucket_index.to_string()),
            requests: 0,
            tokens: 0,
            cost_micros: 0,
            segments: Vec::new(),
        });
        entry.requests += requests;
        entry.tokens += tokens;
        entry.cost_micros += cost_micros;
        let group_id = integer(&row, "group_id");
        entry.segments.push(TrendSegment {
            group_id: if dimension == UsageDimension::Provider && group_id == 0 {
                None
            } else {
                Some(group_id)
            },
            name: {
                let name = text(&row, "group_name");
                if name.is_empty() {
                    "—".to_string()
                } else {
                    name
                }
            },
            requests,
            tokens,
            cost_micros,
        });
    }

    let mut points = Vec::with_capacity(by_bucket.len());
    for mut point in by_bucket.into_values() {
        point
            .segments
            .sort_by(|left, right| right.tokens.cmp(&left.tokens));
        points.push(json!({
            "key": point.key,
            "requests": point.requests,
            "tokens": point.tokens,
            "costMicros": point.cost_micros,
            "segments": point.segments.into_iter().map(|segment| json!({
                "groupId": segment.group_id,
                "name": segment.name,
                "requests": segment.requests,
                "tokens": segment.tokens,
                "costMicros": segment.cost_micros,
            })).collect::<Vec<_>>(),
        }));
    }

    Ok(json!({
        "bucket": bucket,
        "bucketMs": bucket_ms,
        "points": points,
    }))
}

pub(super) async fn summary(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    summary_on(&mut connection, &filter).await
}

pub(super) async fn dashboard(
    pool: &SqlitePool,
    filter: UsageFilterInput,
    task_ids: Vec<String>,
    dimension: UsageDimension,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = pool.begin().await.map_err(DatabaseOperationError::from)?;
    let summary = summary_on(&mut *transaction, &filter).await?;
    let live_turns = if task_ids.is_empty() {
        Vec::new()
    } else {
        let mut where_clause = turn_where(&filter)?;
        where_clause.sql.push_str(&format!(
            " AND session_turns.task_id IN ({})",
            placeholders(task_ids.len())
        ));
        push_text_values(&mut where_clause.params, &task_ids);
        fetch_rows(
            &mut *transaction,
            &format!(
                "SELECT
                     session_turns.task_id,
                     session_turns.created_at,
                     session_turns.status,
                     session_turns.output_tokens,
                     session_turns.total_cost_micros,
                     session_turns.duration_ms
                 FROM session_turns{}
                 ORDER BY session_turns.created_at, session_turns.id",
                where_clause.sql
            ),
            where_clause.params,
        )
        .await?
        .into_iter()
        .map(|row| {
            json!({
                "taskId": text(&row, "task_id"),
                "createdAt": text(&row, "created_at"),
                "status": text(&row, "status"),
                "outputTokens": integer(&row, "output_tokens"),
                "totalCostMicros": integer(&row, "total_cost_micros"),
                "durationMs": row.get("duration_ms").and_then(JsonValue::as_i64),
            })
        })
        .collect()
    };
    let trend = trend_on(&mut *transaction, &filter, dimension).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;

    Ok(json!({
        "summary": summary,
        "liveTurns": live_turns,
        "trend": trend,
    }))
}

pub(super) async fn trend(
    pool: &SqlitePool,
    filter: UsageFilterInput,
    dimension: UsageDimension,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    trend_on(&mut connection, &filter, dimension).await
}

pub(super) async fn archive_trend(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let rows = fetch_rows(
        &mut connection,
        "SELECT
             usage_daily_rollups.day AS key,
             usage_daily_rollups.model_name AS group_name,
             coalesce(sum(usage_daily_rollups.request_count), 0) AS requests,
             coalesce(sum(
                 usage_daily_rollups.input_tokens + usage_daily_rollups.output_tokens
                 + usage_daily_rollups.cache_read_tokens + usage_daily_rollups.cache_write_tokens
             ), 0) AS tokens,
             coalesce(sum(usage_daily_rollups.total_cost_micros), 0) AS cost_micros
         FROM usage_daily_rollups
         GROUP BY usage_daily_rollups.day, usage_daily_rollups.model_name
         ORDER BY usage_daily_rollups.day",
        Vec::new(),
    )
    .await?;

    let mut by_bucket: BTreeMap<String, TrendPoint> = BTreeMap::new();
    for row in rows {
        let key = text(&row, "key");
        let requests = integer(&row, "requests");
        let tokens = integer(&row, "tokens");
        let cost_micros = integer(&row, "cost_micros");
        let entry = by_bucket.entry(key.clone()).or_insert_with(|| TrendPoint {
            key,
            requests: 0,
            tokens: 0,
            cost_micros: 0,
            segments: Vec::new(),
        });
        entry.requests += requests;
        entry.tokens += tokens;
        entry.cost_micros += cost_micros;
        let name = text(&row, "group_name");
        entry.segments.push(TrendSegment {
            group_id: None,
            name: if name.is_empty() {
                "—".to_string()
            } else {
                name
            },
            requests,
            tokens,
            cost_micros,
        });
    }

    let mut points = Vec::with_capacity(by_bucket.len());
    for mut point in by_bucket.into_values() {
        point
            .segments
            .sort_by(|left, right| right.tokens.cmp(&left.tokens));
        points.push(json!({
            "key": point.key,
            "requests": point.requests,
            "tokens": point.tokens,
            "costMicros": point.cost_micros,
            "segments": point.segments.into_iter().map(|segment| json!({
                "groupId": segment.group_id,
                "name": segment.name,
                "requests": segment.requests,
                "tokens": segment.tokens,
                "costMicros": segment.cost_micros,
            })).collect::<Vec<_>>(),
        }));
    }

    Ok(json!({ "bucket": "day", "points": points }))
}

fn group_json(row: &JsonMap<String, JsonValue>) -> JsonValue {
    let name = text(row, "name");
    json!({
        "id": row.get("id").and_then(JsonValue::as_i64),
        "name": if name.is_empty() { "—".to_string() } else { name },
        "requestCount": integer(row, "request_count"),
        "successCount": integer(row, "success_count"),
        "inputTokens": integer(row, "input_tokens"),
        "outputTokens": integer(row, "output_tokens"),
        "cacheReadTokens": integer(row, "cache_read_tokens"),
        "cacheWriteTokens": integer(row, "cache_write_tokens"),
        "totalCostMicros": integer(row, "total_cost_micros"),
        "unpricedCount": integer(row, "unpriced_count"),
        "meanTtftMs": percent_round(
            integer(row, "sum_ttft"),
            integer(row, "ttft_count"),
        ),
        "meanDurationMs": percent_round(
            integer(row, "sum_duration"),
            integer(row, "duration_count"),
        ),
    })
}

async fn groups(
    pool: &SqlitePool,
    filter: UsageFilterInput,
    dimension: UsageDimension,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let where_clause = turn_where(&filter)?;
    let (id, name, join) = match dimension {
        UsageDimension::Model => (
            "models.id",
            "models.name",
            "INNER JOIN models ON models.id = session_turns.model_id",
        ),
        UsageDimension::Provider => (
            "providers.id",
            "providers.name",
            "INNER JOIN models ON models.id = session_turns.model_id
             INNER JOIN providers ON providers.id = models.provider_id",
        ),
    };
    let rows = fetch_rows(
        &mut connection,
        &format!(
            "SELECT
                 {id} AS id,
                 {name} AS name,
                 count(*) AS request_count,
                 coalesce(sum(CASE WHEN session_turns.status = 'completed' THEN 1 ELSE 0 END), 0)
                     AS success_count,
                 coalesce(sum(session_turns.input_tokens), 0) AS input_tokens,
                 coalesce(sum(session_turns.output_tokens), 0) AS output_tokens,
                 coalesce(sum(session_turns.cache_read_tokens), 0) AS cache_read_tokens,
                 coalesce(sum(session_turns.cache_write_tokens), 0) AS cache_write_tokens,
                 coalesce(sum(session_turns.total_cost_micros), 0) AS total_cost_micros,
                 coalesce(sum(session_turns.unpriced_calls), 0) AS unpriced_count,
                 coalesce(sum(session_turns.ttft_ms), 0) AS sum_ttft,
                 count(session_turns.ttft_ms) AS ttft_count,
                 coalesce(sum(session_turns.duration_ms), 0) AS sum_duration,
                 count(session_turns.duration_ms) AS duration_count
             FROM session_turns
             {join}
             {}
             GROUP BY {id}, {name}
             ORDER BY coalesce(sum(
                 session_turns.input_tokens + session_turns.output_tokens
             ), 0) DESC",
            where_clause.sql
        ),
        where_clause.params,
    )
    .await?;
    Ok(JsonValue::Array(
        rows.iter().map(group_json).collect::<Vec<_>>(),
    ))
}

pub(super) async fn by_model(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    groups(pool, filter, UsageDimension::Model).await
}

pub(super) async fn by_provider(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    groups(pool, filter, UsageDimension::Provider).await
}

pub(super) async fn model_ranking(
    pool: &SqlitePool,
    filter: UsageFilterInput,
    metric: UsageRankMetric,
    limit: u32,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let where_clause = turn_where(&filter)?;
    let order = match metric {
        UsageRankMetric::Cost => "coalesce(sum(session_turns.total_cost_micros), 0)",
        UsageRankMetric::Tokens | UsageRankMetric::Duration => {
            "coalesce(sum(
                session_turns.input_tokens + session_turns.output_tokens
                + session_turns.cache_read_tokens + session_turns.cache_write_tokens
            ), 0)"
        }
    };
    let mut params = where_clause.params;
    params.push(json!(limit));
    let rows = fetch_rows(
        &mut connection,
        &format!(
            "SELECT
                 models.id AS id,
                 models.name AS name,
                 count(*) AS requests,
                 coalesce(sum(
                     session_turns.input_tokens + session_turns.output_tokens
                     + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                 ), 0) AS tokens,
                 coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros,
                 coalesce(sum(session_turns.unpriced_calls), 0) AS unpriced_count
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             {}
             GROUP BY models.id, models.name
             ORDER BY {order} DESC
             LIMIT ?",
            where_clause.sql
        ),
        params,
    )
    .await?;

    Ok(JsonValue::Array(
        rows.iter()
            .map(|row| {
                json!({
                    "id": integer(row, "id"),
                    "name": text(row, "name"),
                    "subtitle": null,
                    "lastAt": null,
                    "requests": integer(row, "requests"),
                    "tokens": integer(row, "tokens"),
                    "costMicros": integer(row, "cost_micros"),
                    "unpricedCount": integer(row, "unpriced_count"),
                    "durationMs": null,
                })
            })
            .collect::<Vec<_>>(),
    ))
}

pub(super) async fn session_ranking(
    pool: &SqlitePool,
    filter: UsageFilterInput,
    metric: UsageRankMetric,
    limit: u32,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let where_clause = turn_where(&filter)?;
    let order = match metric {
        UsageRankMetric::Cost => "coalesce(sum(session_turns.total_cost_micros), 0)",
        UsageRankMetric::Duration => "coalesce(sum(session_turns.duration_ms), 0)",
        UsageRankMetric::Tokens => {
            "coalesce(sum(
                session_turns.input_tokens + session_turns.output_tokens
                + session_turns.cache_read_tokens + session_turns.cache_write_tokens
            ), 0)"
        }
    };
    let mut params = where_clause.params;
    params.push(json!(limit));
    let rows = fetch_rows(
        &mut connection,
        &format!(
            "SELECT
                 sessions.id AS id,
                 sessions.title AS title,
                 coalesce(max(models.name), '') AS model_name,
                 max(session_turns.created_at) AS last_at,
                 count(*) AS requests,
                 coalesce(sum(
                     session_turns.input_tokens + session_turns.output_tokens
                     + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                 ), 0) AS tokens,
                 coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros,
                 coalesce(sum(session_turns.unpriced_calls), 0) AS unpriced_count,
                 coalesce(sum(session_turns.duration_ms), 0) AS duration_ms
             FROM session_turns
             INNER JOIN sessions ON sessions.id = session_turns.session_id
             LEFT JOIN models ON models.id = session_turns.model_id
             {}
             GROUP BY sessions.id, sessions.title
             ORDER BY {order} DESC
             LIMIT ?",
            where_clause.sql
        ),
        params,
    )
    .await?;

    Ok(JsonValue::Array(
        rows.iter()
            .map(|row| {
                let title = text(row, "title");
                let model_name = text(row, "model_name");
                json!({
                    "id": integer(row, "id"),
                    "name": if title.is_empty() { "—".to_string() } else { title },
                    "subtitle": if model_name.is_empty() {
                        JsonValue::Null
                    } else {
                        JsonValue::String(model_name)
                    },
                    "lastAt": optional_text(row, "last_at"),
                    "requests": integer(row, "requests"),
                    "tokens": integer(row, "tokens"),
                    "costMicros": integer(row, "cost_micros"),
                    "unpricedCount": integer(row, "unpriced_count"),
                    "durationMs": integer(row, "duration_ms"),
                })
            })
            .collect::<Vec<_>>(),
    ))
}

pub(super) async fn filter_options(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let where_clause = turn_where(&filter)?;
    let model_rows = fetch_rows(
        &mut connection,
        &format!(
            "SELECT models.id AS id, models.name AS name, count(*) AS count
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             {}
             GROUP BY models.id, models.name
             ORDER BY count(*) DESC",
            where_clause.sql
        ),
        where_clause.params.clone(),
    )
    .await?;
    let provider_rows = fetch_rows(
        &mut connection,
        &format!(
            "SELECT providers.id AS id, providers.name AS name, count(*) AS count
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             INNER JOIN providers ON providers.id = models.provider_id
             {}
             GROUP BY providers.id, providers.name
             ORDER BY count(*) DESC",
            where_clause.sql
        ),
        where_clause.params,
    )
    .await?;
    Ok(json!({
        "models": model_rows.iter().map(|row| json!({
            "id": integer(row, "id"),
            "name": text(row, "name"),
            "count": integer(row, "count"),
        })).collect::<Vec<_>>(),
        "providers": provider_rows.iter().map(|row| json!({
            "id": integer(row, "id"),
            "name": text(row, "name"),
            "count": integer(row, "count"),
        })).collect::<Vec<_>>(),
    }))
}

fn estimate_tokens_from_chars(chars: f64) -> i64 {
    if chars <= 0.0 {
        0
    } else {
        (chars * 0.375).ceil() as i64
    }
}

pub(super) async fn composition(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let where_clause = turn_where(&filter)?;
    let turns = fetch_one(
        &mut connection,
        &format!(
            "SELECT
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.platform')), 0) AS platform,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.policy')), 0) AS policy,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.mode')), 0) AS mode,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.feature')), 0) AS feature,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.agent_profile')), 0) AS agent_profile,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.session_memory')), 0) AS session_memory,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.user_append')), 0) AS user_append,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.fragments.override')), 0) AS override,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.builtinToolDefinitions')), 0) AS builtin_tools,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.mcpToolDefinitions')), 0) AS mcp_tools,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.userPrompt')), 0) AS user_prompt,
                 coalesce(sum(json_extract(session_turns.prompt_breakdown_json,
                     '$.attachments')), 0) AS attachments,
                 coalesce(sum(session_turns.output_tokens), 0) AS output_tokens,
                 coalesce(sum(session_turns.input_tokens), 0) AS input_tokens,
                 coalesce(sum(session_turns.cache_read_tokens), 0) AS cache_read_tokens,
                 coalesce(sum(session_turns.duration_ms), 0) AS total_duration_ms
             FROM session_turns{}",
            where_clause.sql
        ),
        where_clause.params,
    )
    .await?
    .unwrap_or_default();

    let parts = fetch_one(
        &mut connection,
        "SELECT
             coalesce(sum(CASE WHEN message_parts.type = 'text'
                 THEN length(message_parts.content) ELSE 0 END), 0) AS text_chars,
             coalesce(sum(CASE WHEN message_parts.type = 'reasoning'
                 THEN length(message_parts.content) ELSE 0 END), 0) AS reasoning_chars,
             coalesce(sum(CASE WHEN message_parts.type = 'tool_call'
                 THEN length(json_extract(message_parts.data, '$.output')) ELSE 0 END), 0)
                 AS tool_output_chars
         FROM message_parts
         WHERE message_parts.created_at BETWEEN ? AND ?",
        vec![
            JsonValue::String(filter.from.clone()),
            JsonValue::String(filter.to.clone()),
        ],
    )
    .await?
    .unwrap_or_default();
    let timing = fetch_one(
        &mut connection,
        "SELECT
             coalesce(sum(CASE WHEN message_parts.type = 'llm_call'
                 THEN json_extract(message_parts.data, '$.timing.ttftMs') ELSE 0 END), 0) AS wait,
             coalesce(sum(CASE WHEN message_parts.type = 'llm_call'
                 AND json_extract(message_parts.data, '$.timing.firstTextMs') IS NOT NULL
                 AND json_extract(message_parts.data, '$.timing.ttftMs') IS NOT NULL
                 THEN max(
                     0,
                     json_extract(message_parts.data, '$.timing.firstTextMs')
                     - json_extract(message_parts.data, '$.timing.ttftMs')
                 )
                 ELSE 0 END), 0) AS think,
             coalesce(sum(CASE WHEN message_parts.type = 'llm_call'
                 THEN json_extract(message_parts.data, '$.timing.flowMs') ELSE 0 END), 0) AS reply,
             coalesce(sum(CASE WHEN message_parts.type = 'tool_call'
                 THEN json_extract(message_parts.data, '$.duration_ms') ELSE 0 END), 0) AS tool
         FROM message_parts
         WHERE message_parts.created_at BETWEEN ? AND ?",
        vec![
            JsonValue::String(filter.from.clone()),
            JsonValue::String(filter.to.clone()),
        ],
    )
    .await?
    .unwrap_or_default();

    let mut segments = vec![
        json!({
            "key": "systemPrompt",
            "value": estimate_tokens_from_chars(
                number(&turns, "platform") + number(&turns, "policy")
            ),
            "estimated": true,
        }),
        json!({
            "key": "toolDefinitions",
            "value": estimate_tokens_from_chars(
                number(&turns, "builtin_tools") + number(&turns, "mcp_tools")
            ),
            "estimated": true,
        }),
        json!({
            "key": "conversation",
            "value": estimate_tokens_from_chars(
                number(&parts, "text_chars") + number(&parts, "reasoning_chars")
            ),
            "estimated": true,
        }),
        json!({
            "key": "toolResults",
            "value": estimate_tokens_from_chars(number(&parts, "tool_output_chars")),
            "estimated": true,
        }),
        json!({
            "key": "userPrompt",
            "value": estimate_tokens_from_chars(number(&turns, "user_prompt")),
            "estimated": true,
        }),
        json!({
            "key": "injections",
            "value": estimate_tokens_from_chars(
                number(&turns, "mode")
                + number(&turns, "feature")
                + number(&turns, "agent_profile")
                + number(&turns, "session_memory")
                + number(&turns, "user_append")
                + number(&turns, "override")
                + number(&turns, "attachments")
            ),
            "estimated": true,
        }),
        json!({
            "key": "output",
            "value": integer(&turns, "output_tokens"),
            "estimated": false,
        }),
    ];
    segments.retain(|segment| {
        segment
            .get("value")
            .and_then(JsonValue::as_i64)
            .unwrap_or_default()
            > 0
    });
    let token_total = segments
        .iter()
        .map(|segment| {
            segment
                .get("value")
                .and_then(JsonValue::as_i64)
                .unwrap_or_default()
        })
        .sum::<i64>();

    let total_ms = integer(&turns, "total_duration_ms");
    let wait = integer(&timing, "wait");
    let think = integer(&timing, "think");
    let reply = integer(&timing, "reply");
    let tool = integer(&timing, "tool");
    let other = (total_ms - wait - think - reply - tool).max(0);
    let mut timing_segments = vec![
        json!({ "key": "wait", "value": wait, "estimated": false }),
        json!({ "key": "think", "value": think, "estimated": false }),
        json!({ "key": "reply", "value": reply, "estimated": false }),
        json!({ "key": "tool", "value": tool, "estimated": false }),
        json!({ "key": "other", "value": other, "estimated": false }),
    ];
    timing_segments.retain(|segment| {
        segment
            .get("value")
            .and_then(JsonValue::as_i64)
            .unwrap_or_default()
            > 0
    });
    let billing_input = integer(&turns, "input_tokens") + integer(&turns, "cache_read_tokens");
    let cache_read_share = if billing_input > 0 {
        integer(&turns, "cache_read_tokens") as f64 / billing_input as f64
    } else {
        0.0
    };

    Ok(json!({
        "tokens": {
            "total": token_total,
            "segments": segments,
        },
        "timing": {
            "totalMs": total_ms,
            "segments": timing_segments,
        },
        "cacheReadShare": cache_read_share,
    }))
}

pub(super) async fn tool_stats(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let rows = fetch_rows(
        &mut connection,
        "SELECT
             CASE json_extract(message_parts.data, '$.toolKind')
                 WHEN 'builtin' THEN 'builtin__' || json_extract(message_parts.data, '$.tool_id')
                 WHEN 'mcp' THEN 'mcp__'
                     || coalesce(json_extract(message_parts.data, '$.server_id'), '')
                     || '__'
                     || coalesce(json_extract(message_parts.data, '$.tool_name'), '')
                 ELSE NULL
             END AS name,
             json_extract(message_parts.data, '$.toolKind') AS kind,
             json_extract(message_parts.data, '$.status') AS status,
             count(*) AS count,
             coalesce(sum(json_extract(message_parts.data, '$.duration_ms')), 0) AS sum_duration,
             count(json_extract(message_parts.data, '$.duration_ms')) AS duration_count
         FROM message_parts
         WHERE message_parts.type = 'tool_call'
           AND message_parts.created_at BETWEEN ? AND ?
         GROUP BY name, kind, status",
        vec![JsonValue::String(filter.from), JsonValue::String(filter.to)],
    )
    .await?;

    struct ToolEntry {
        name: String,
        kind: &'static str,
        count: i64,
        error_count: i64,
        sum_duration: i64,
        duration_count: i64,
    }

    let mut by_tool_index: HashMap<String, usize> = HashMap::new();
    let mut tools: Vec<ToolEntry> = Vec::new();
    let mut total_count = 0;
    let mut error_count = 0;
    let mut sum_duration = 0;
    let mut duration_count = 0;
    for row in rows {
        let raw_name = text(&row, "name");
        let name = if raw_name.is_empty() {
            "—".to_string()
        } else {
            raw_name
        };
        let count = integer(&row, "count");
        let row_sum_duration = integer(&row, "sum_duration");
        let row_duration_count = integer(&row, "duration_count");
        let status = text(&row, "status");
        let is_error = matches!(status.as_str(), "error" | "timeout" | "rejected");
        total_count += count;
        if is_error {
            error_count += count;
        }
        sum_duration += row_sum_duration;
        duration_count += row_duration_count;
        let kind = if text(&row, "kind") == "mcp" {
            "mcp"
        } else {
            "builtin"
        };
        let index = match by_tool_index.get(&name) {
            Some(index) => *index,
            None => {
                let index = tools.len();
                by_tool_index.insert(name.clone(), index);
                tools.push(ToolEntry {
                    name,
                    kind,
                    count: 0,
                    error_count: 0,
                    sum_duration: 0,
                    duration_count: 0,
                });
                index
            }
        };
        let entry = &mut tools[index];
        entry.count += count;
        if is_error {
            entry.error_count += count;
        }
        entry.sum_duration += row_sum_duration;
        entry.duration_count += row_duration_count;
    }

    tools.sort_by(|left, right| right.count.cmp(&left.count));
    let distinct_tools = tools.len() as i64;
    let by_tool = tools
        .into_iter()
        .map(|entry| {
            json!({
                "name": entry.name,
                "kind": entry.kind,
                "count": entry.count,
                "errorCount": entry.error_count,
                "meanDurationMs": percent_round(entry.sum_duration, entry.duration_count),
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "totalCount": total_count,
        "errorCount": error_count,
        "distinctTools": distinct_tools,
        "meanDurationMs": percent_round(sum_duration, duration_count),
        "byTool": by_tool,
    }))
}

pub(super) async fn heatmap(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let where_clause = turn_where(&filter)?;
    let rows = fetch_rows(
        &mut connection,
        &format!(
            "SELECT
                 date(session_turns.created_at, 'localtime') AS day,
                 cast(strftime('%H', session_turns.created_at, 'localtime') AS integer) AS hour,
                 count(*) AS requests,
                 coalesce(sum(
                     session_turns.input_tokens + session_turns.output_tokens
                     + session_turns.cache_read_tokens + session_turns.cache_write_tokens
                 ), 0) AS tokens,
                 coalesce(sum(session_turns.total_cost_micros), 0) AS cost_micros
             FROM session_turns{}
             GROUP BY day, hour
             ORDER BY day, hour",
            where_clause.sql
        ),
        where_clause.params,
    )
    .await?;
    Ok(JsonValue::Array(
        rows.iter()
            .map(|row| {
                json!({
                    "day": text(row, "day"),
                    "hour": integer(row, "hour"),
                    "requests": integer(row, "requests"),
                    "tokens": integer(row, "tokens"),
                    "costMicros": integer(row, "cost_micros"),
                })
            })
            .collect::<Vec<_>>(),
    ))
}

async fn load_context_samples(
    connection: &mut SqliteConnection,
    filter: &UsageFilterInput,
) -> Result<Vec<RawTurnSample>, DatabaseOperationError> {
    let where_clause = sample_where(filter)?;
    let mut params = where_clause.params;
    params.push(json!(SAMPLE_LIMIT));
    let rows = fetch_rows(
        connection,
        &format!(
            "SELECT
                 session_turns.id AS turn_id,
                 session_turns.created_at AS created_at,
                 session_turns.model_id AS model_id,
                 models.name AS model_name,
                 coalesce(models.context_limit, 0) AS window,
                 (
                     session_turns.input_tokens
                     + session_turns.cache_read_tokens
                     + session_turns.cache_write_tokens
                 ) AS prompt_tokens,
                 session_turns.cache_read_tokens AS cache_read_tokens,
                 session_turns.input_tokens AS input_tokens,
                 session_turns.prompt_breakdown_json AS breakdown,
                 CASE WHEN session_turns.status = 'failed' THEN 1 ELSE 0 END AS failed
             FROM session_turns
             INNER JOIN models ON models.id = session_turns.model_id
             {}
             ORDER BY session_turns.created_at DESC, session_turns.id DESC
             LIMIT ?",
            where_clause.sql
        ),
        params,
    )
    .await?;
    Ok(rows
        .iter()
        .map(|row| RawTurnSample {
            turn_id: integer(row, "turn_id"),
            created_at: text(row, "created_at"),
            model_id: integer(row, "model_id"),
            model_name: text(row, "model_name"),
            window: number(row, "window"),
            prompt_tokens: number(row, "prompt_tokens"),
            cache_read_tokens: number(row, "cache_read_tokens"),
            input_tokens: number(row, "input_tokens"),
            breakdown: optional_text(row, "breakdown"),
            failed: integer(row, "failed") == 1,
        })
        .collect())
}

fn percentile(sorted: &[f64], ratio: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * ratio)
        .round()
        .clamp(0.0, (sorted.len() - 1) as f64) as usize;
    sorted[index]
}

fn median(sorted: &[f64]) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let middle = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[middle]
    } else {
        (sorted[middle - 1] + sorted[middle]) / 2.0
    }
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn prompt_breakdown(raw: Option<&str>) -> Option<JsonValue> {
    let parsed: JsonValue = serde_json::from_str(raw?).ok()?;
    if !parsed.is_object() || !parsed.get("fragments")?.is_object() {
        return None;
    }
    Some(parsed)
}

fn json_number(object: &JsonValue, key: &str) -> f64 {
    object
        .get(key)
        .and_then(JsonValue::as_f64)
        .unwrap_or_default()
}

fn sum_fragment_chars(fragments: &JsonValue) -> f64 {
    fragments
        .as_object()
        .map(|values| values.values().filter_map(JsonValue::as_f64).sum())
        .unwrap_or_default()
}

fn score_context(input: (f64, bool, f64, f64, f64, f64)) -> (i64, Vec<JsonValue>) {
    let (cache_reuse_rate, cache_known, baseline_median, window, growth_median, error_rate) = input;
    let window = window.max(1.0);
    let cache = if cache_known {
        clamp01(cache_reuse_rate / 0.9)
    } else {
        0.5
    };
    let lean = clamp01(1.0 - (baseline_median / window - 0.05) / 0.25);
    let pace = clamp01(1.0 - (growth_median / window - 0.01) / 0.05);
    let reliable = clamp01(1.0 - error_rate / 0.2);
    let scores = vec![
        json!({ "key": "cache", "points": (cache * 35.0).round() as i64, "most": 35 }),
        json!({ "key": "lean", "points": (lean * 25.0).round() as i64, "most": 25 }),
        json!({ "key": "pace", "points": (pace * 20.0).round() as i64, "most": 20 }),
        json!({ "key": "reliable", "points": (reliable * 20.0).round() as i64, "most": 20 }),
    ];
    let total = scores
        .iter()
        .map(|score| {
            score
                .get("points")
                .and_then(JsonValue::as_i64)
                .unwrap_or_default()
        })
        .sum();
    (total, scores)
}

#[allow(clippy::too_many_arguments)]
fn context_tags(
    input: (
        f64,
        bool,
        f64,
        f64,
        f64,
        f64,
        f64,
        i64,
        usize,
        f64,
        f64,
        f64,
    ),
) -> Vec<JsonValue> {
    let (
        cache_reuse_rate,
        cache_known,
        baseline_median,
        mcp_tool_tokens,
        window,
        growth_median,
        peak_fill,
        compact_count,
        turn_count,
        error_rate,
        attachment_share,
        user_prompt_share,
    ) = input;
    let window = window.max(1.0);
    let mut tags = Vec::new();
    if cache_known && cache_reuse_rate >= 0.8 {
        tags.push(json!({ "key": "cacheFriendly", "tone": "good" }));
    }
    if cache_known && cache_reuse_rate < 0.4 && turn_count >= 5 {
        tags.push(json!({ "key": "cacheMisses", "tone": "warn" }));
    }
    if baseline_median / window <= 0.06 {
        tags.push(json!({ "key": "lean", "tone": "good" }));
    }
    if baseline_median / window >= 0.2 {
        tags.push(json!({ "key": "heavyStart", "tone": "warn" }));
    }
    if mcp_tool_tokens >= 5_000.0 && mcp_tool_tokens >= baseline_median * 0.3 {
        tags.push(json!({ "key": "mcpHeavy", "tone": "info" }));
    }
    if growth_median / window >= 0.03 {
        tags.push(json!({ "key": "fillsFast", "tone": "warn" }));
    }
    if peak_fill >= 0.85 {
        tags.push(json!({ "key": "nearFull", "tone": "warn" }));
    }
    if compact_count > 0 {
        tags.push(json!({ "key": "compacts", "tone": "info" }));
    }
    if attachment_share >= 0.15 {
        tags.push(json!({ "key": "attachmentHeavy", "tone": "info" }));
    }
    if user_prompt_share >= 0.3 {
        tags.push(json!({ "key": "promptBloat", "tone": "info" }));
    }
    if turn_count >= 20 && error_rate < 0.01 {
        tags.push(json!({ "key": "steady", "tone": "good" }));
    }
    if turn_count >= 5 && error_rate >= 0.1 {
        tags.push(json!({ "key": "flaky", "tone": "warn" }));
    }
    tags
}

fn context_profile(
    samples: &[RawTurnSample],
    model_id: Option<i64>,
    model_name: &str,
) -> Option<JsonValue> {
    if samples.is_empty() {
        return None;
    }

    let mut prompts = samples
        .iter()
        .map(|sample| sample.prompt_tokens)
        .collect::<Vec<_>>();
    prompts.sort_by(f64::total_cmp);
    let prompt_median = median(&prompts);
    let prompt_p90 = percentile(&prompts, 0.9);
    let peak = prompts.last().copied().unwrap_or_default();
    let window = samples
        .iter()
        .map(|sample| sample.window)
        .filter(|value| *value > 0.0)
        .reduce(f64::max)
        .unwrap_or_default();

    let mut baselines = Vec::new();
    let mut share_totals: HashMap<&str, f64> = HashMap::new();
    let mut user_prompt_chars = 0.0;
    let mut total_chars = 0.0;
    for sample in samples {
        let Some(parsed) = prompt_breakdown(sample.breakdown.as_deref()) else {
            continue;
        };
        let fragments = parsed.get("fragments").expect("checked fragments");
        let system_prompt_total = json_number(&parsed, "systemPromptTotal");
        let builtin_tool_definitions = json_number(&parsed, "builtinToolDefinitions");
        let mcp_tool_definitions = json_number(&parsed, "mcpToolDefinitions");
        let user_prompt = json_number(&parsed, "userPrompt");
        let attachments = json_number(&parsed, "attachments");
        let fragment_chars = sum_fragment_chars(fragments);
        baselines.push(estimate_tokens_from_chars(
            system_prompt_total + builtin_tool_definitions + mcp_tool_definitions,
        ) as f64);

        let conversation_chars = (system_prompt_total - fragment_chars).max(0.0);
        let segments = [
            ("systemPrompt", fragment_chars),
            ("builtinToolDefinitions", builtin_tool_definitions),
            ("mcpToolDefinitions", mcp_tool_definitions),
            ("conversation", conversation_chars),
            ("userPrompt", user_prompt),
            ("attachments", attachments),
        ];
        let mut sample_total = 0.0;
        for (key, chars) in segments {
            *share_totals.entry(key).or_default() += chars;
            sample_total += chars;
        }
        total_chars += sample_total;
        user_prompt_chars += user_prompt;
    }
    baselines.sort_by(f64::total_cmp);
    let baseline_median = if baselines.is_empty() {
        0.0
    } else {
        percentile(&baselines, 0.5)
    };

    let mut chronological = samples.to_vec();
    chronological.sort_by_key(|sample| sample.turn_id);
    let mut growth = Vec::new();
    let mut compaction_count = 0;
    for pair in chronological.windows(2) {
        let previous = &pair[0];
        let current = &pair[1];
        if previous.model_id != current.model_id {
            continue;
        }
        let delta = current.prompt_tokens - previous.prompt_tokens;
        if delta > 0.0 {
            growth.push(delta);
        }
        if previous.prompt_tokens >= COMPACTION_MIN_TOKENS
            && current.prompt_tokens < previous.prompt_tokens * COMPACTION_RATIO
        {
            compaction_count += 1;
        }
    }
    growth.sort_by(f64::total_cmp);
    let growth_median = if growth.is_empty() {
        0.0
    } else {
        percentile(&growth, 0.5)
    };

    let cache_read_total = samples
        .iter()
        .map(|sample| sample.cache_read_tokens)
        .sum::<f64>();
    let input_total = samples
        .iter()
        .map(|sample| sample.input_tokens)
        .sum::<f64>();
    let cache_known = cache_read_total > 0.0;
    let cache_reuse_rate = if cache_read_total + input_total > 0.0 {
        cache_read_total / (cache_read_total + input_total)
    } else {
        0.0
    };
    let failures = samples.iter().filter(|sample| sample.failed).count();
    let error_rate = failures as f64 / samples.len() as f64;
    let shares = SHARE_ORDER
        .iter()
        .map(|key| {
            let chars = share_totals.get(key).copied().unwrap_or_default();
            json!({
                "key": key,
                "tokens": estimate_tokens_from_chars(chars),
                "share": if total_chars > 0.0 { chars / total_chars } else { 0.0 },
            })
        })
        .collect::<Vec<_>>();
    let (score, scores) = score_context((
        cache_reuse_rate,
        cache_known,
        baseline_median,
        window,
        growth_median,
        error_rate,
    ));
    let tags = context_tags((
        cache_reuse_rate,
        cache_known,
        baseline_median,
        share_totals
            .get("mcpToolDefinitions")
            .copied()
            .unwrap_or_default(),
        window,
        growth_median,
        if window > 0.0 { peak / window } else { 0.0 },
        compaction_count,
        samples.len(),
        error_rate,
        if total_chars > 0.0 {
            share_totals.get("attachments").copied().unwrap_or_default() / total_chars
        } else {
            0.0
        },
        if total_chars > 0.0 {
            user_prompt_chars / total_chars
        } else {
            0.0
        },
    ));

    Some(json!({
        "modelId": model_id,
        "modelName": model_name,
        "window": window,
        "turnCount": samples.len(),
        "promptMedian": prompt_median,
        "promptP90": prompt_p90,
        "baselineMedian": baseline_median,
        "growthMedian": growth_median,
        "peakFill": if window > 0.0 { peak / window } else { 0.0 },
        "cacheReuseRate": cache_reuse_rate,
        "compactCount": compaction_count,
        "errorRate": error_rate,
        "shares": shares,
        "score": score,
        "scores": scores,
        "tags": tags,
    }))
}

pub(super) async fn context_profiles(
    pool: &SqlitePool,
    filter: UsageFilterInput,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let samples = load_context_samples(&mut connection, &filter).await?;
    if samples.is_empty() {
        return Ok(json!({ "overall": null, "models": [] }));
    }
    let overall = context_profile(&samples, None, "");
    let mut by_model_index: HashMap<i64, usize> = HashMap::new();
    let mut by_model: Vec<Vec<RawTurnSample>> = Vec::new();
    for sample in &samples {
        let index = match by_model_index.get(&sample.model_id) {
            Some(index) => *index,
            None => {
                let index = by_model.len();
                by_model_index.insert(sample.model_id, index);
                by_model.push(Vec::new());
                index
            }
        };
        by_model[index].push(sample.clone());
    }
    let mut models = by_model
        .into_iter()
        .filter_map(|model_samples| {
            let model_id = model_samples.first()?.model_id;
            let name = model_samples
                .first()
                .map(|sample| sample.model_name.as_str())
                .unwrap_or_default();
            context_profile(&model_samples, Some(model_id), name)
        })
        .collect::<Vec<_>>();
    models.sort_by(|left, right| {
        let left = left
            .get("turnCount")
            .and_then(JsonValue::as_i64)
            .unwrap_or_default();
        let right = right
            .get("turnCount")
            .and_then(JsonValue::as_i64)
            .unwrap_or_default();
        right.cmp(&left)
    });
    Ok(json!({ "overall": overall, "models": models }))
}

pub(super) async fn context_points(
    pool: &SqlitePool,
    filter: UsageFilterInput,
    limit: u32,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut connection = pool.acquire().await.map_err(DatabaseOperationError::from)?;
    let samples = load_context_samples(&mut connection, &filter).await?;
    if samples.is_empty() {
        return Ok(JsonValue::Array(Vec::new()));
    }
    let mut chronological = samples;
    chronological.sort_by_key(|sample| sample.turn_id);
    let mut points = Vec::with_capacity(chronological.len());
    for (index, sample) in chronological.iter().enumerate() {
        let is_compaction = index > 0
            && chronological[index - 1].model_id == sample.model_id
            && chronological[index - 1].prompt_tokens >= COMPACTION_MIN_TOKENS
            && sample.prompt_tokens < chronological[index - 1].prompt_tokens * COMPACTION_RATIO;
        points.push(json!({
            "turnId": sample.turn_id,
            "createdAt": sample.created_at,
            "modelId": sample.model_id,
            "promptTokens": sample.prompt_tokens,
            "window": sample.window,
            "fillRate": if sample.window > 0.0 {
                sample.prompt_tokens / sample.window
            } else {
                0.0
            },
            "cacheReadTokens": sample.cache_read_tokens,
            "isCompaction": is_compaction,
        }));
    }
    let start = points.len().saturating_sub(limit as usize);
    Ok(JsonValue::Array(points.split_off(start)))
}

pub(super) async fn append_llm_call_parts(
    pool: &SqlitePool,
    message_id: i64,
    calls: Vec<LlmCallPartInput>,
) -> Result<JsonValue, DatabaseOperationError> {
    if calls.is_empty() {
        return Ok(json!(0));
    }
    let mut transaction = begin_immediate(pool).await?;
    let max_row = fetch_one(
        &mut *transaction,
        "SELECT coalesce(max(sort_order), -1) AS value
         FROM message_parts
         WHERE message_id = ?",
        vec![json!(message_id)],
    )
    .await?;
    let base_order = max_row
        .as_ref()
        .map(|row| integer(row, "value"))
        .unwrap_or(-1)
        + 1;
    for (index, call) in calls.iter().enumerate() {
        run(
            &mut *transaction,
            "INSERT INTO message_parts (
                 message_id, type, content, data, started_at, ended_at, sort_order
             ) VALUES (?, 'llm_call', '', ?, ?, ?, ?)",
            vec![
                json!(message_id),
                JsonValue::String(call.data.clone()),
                call.started_at
                    .map(|value| json!(value))
                    .unwrap_or(JsonValue::Null),
                call.ended_at
                    .map(|value| json!(value))
                    .unwrap_or(JsonValue::Null),
                json!(base_order + index as i64),
            ],
        )
        .await?;
    }
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(json!(calls.len()))
}

fn normalized_retention_days(retention_days: f64) -> Option<i64> {
    if !retention_days.is_finite() || retention_days <= 0.0 {
        None
    } else {
        Some(retention_days.floor() as i64)
    }
}

async fn rollup_on(connection: &mut SqliteConnection) -> Result<(), DatabaseOperationError> {
    run(connection, ROLLUP_SQL, Vec::new()).await?;
    Ok(())
}

async fn prune_on(
    connection: &mut SqliteConnection,
    retention_days: f64,
) -> Result<i64, DatabaseOperationError> {
    let Some(days) = normalized_retention_days(retention_days) else {
        return Ok(0);
    };
    let rows = fetch_rows(
        connection,
        "DELETE FROM message_parts
         WHERE type = 'llm_call'
           AND created_at < datetime('now', ?)
         RETURNING id",
        vec![JsonValue::String(format!("-{days} days"))],
    )
    .await?;
    Ok(rows.len() as i64)
}

pub(super) async fn rollup_daily(pool: &SqlitePool) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    rollup_on(&mut *transaction).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(JsonValue::Null)
}

pub(super) async fn prune_detail(
    pool: &SqlitePool,
    retention_days: f64,
) -> Result<JsonValue, DatabaseOperationError> {
    let mut transaction = begin_immediate(pool).await?;
    let pruned = prune_on(&mut *transaction, retention_days).await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(json!(pruned))
}

pub(super) async fn maintenance(
    pool: &SqlitePool,
    retention_days: f64,
    min_interval_ms: i64,
    now: String,
    statistic_key: String,
) -> Result<JsonValue, DatabaseOperationError> {
    if statistic_key.trim().is_empty() {
        return Err(DatabaseOperationError::validation(
            "Usage maintenance statistic key must not be empty",
        ));
    }
    let now_at = parse_usage_time(&now).ok_or_else(|| {
        DatabaseOperationError::validation("Usage maintenance timestamp is invalid")
    })?;
    let mut transaction = begin_immediate(pool).await?;
    let last_run = fetch_one(
        &mut *transaction,
        "SELECT value FROM statistics WHERE key = ? LIMIT 1",
        vec![JsonValue::String(statistic_key.clone())],
    )
    .await?
    .and_then(|row| optional_text(&row, "value"));
    let due = last_run
        .as_deref()
        .and_then(parse_usage_time)
        .map(|last| (now_at - last).whole_milliseconds() >= min_interval_ms as i128)
        .unwrap_or(true);
    if !due {
        transaction
            .rollback()
            .await
            .map_err(DatabaseOperationError::from)?;
        return Ok(json!({ "ran": false, "pruned": 0 }));
    }

    rollup_on(&mut *transaction).await?;
    let pruned = prune_on(&mut *transaction, retention_days).await?;
    run(
        &mut *transaction,
        "INSERT INTO statistics (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        vec![JsonValue::String(statistic_key), JsonValue::String(now)],
    )
    .await?;
    transaction
        .commit()
        .await
        .map_err(DatabaseOperationError::from)?;
    Ok(json!({ "ran": true, "pruned": pruned }))
}
