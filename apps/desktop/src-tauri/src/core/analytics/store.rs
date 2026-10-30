// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Typed SQL for the analytics consent state and bounded outbox.
//!
//! Everything runs on the existing `DatabaseRuntime` pool over `touchai.db`;
//! there is no second database, connection or schema framework. These are
//! crate-internal typed statements, not a generic SQL IPC surface.

use sqlx::{FromRow, SqlitePool};
use time::OffsetDateTime;

pub(crate) const MAX_EVENTS: i64 = 10_000;
pub(crate) const MAX_BYTES: i64 = 16 * 1024 * 1024;
pub(crate) const MAX_PAYLOAD_BYTES: i64 = 2048;
pub(crate) const TTL_MS: i64 = 72 * 60 * 60 * 1000;
pub(crate) const SEND_BATCH_LIMIT: i64 = 50;

pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub(crate) fn utc_day_from_ms(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    match OffsetDateTime::from_unix_timestamp(seconds) {
        Ok(moment) => {
            let date = moment.date();
            format!(
                "{:04}-{:02}-{:02}",
                date.year(),
                date.month() as u8,
                date.day()
            )
        }
        Err(_) => "1970-01-01".to_string(),
    }
}

#[derive(Debug, Clone, FromRow)]
pub(crate) struct AnalyticsStateRow {
    pub(crate) status: String,
    pub(crate) consent_explicit: i64,
    pub(crate) installation_id: Option<String>,
    pub(crate) consent_epoch: i64,
}

#[derive(Debug, Clone, FromRow)]
pub(crate) struct AnalyticsOutboxRow {
    pub(crate) event_id: String,
    pub(crate) payload_json: String,
    pub(crate) attempt_count: i64,
}

pub(crate) struct OutboxInsert {
    pub(crate) event_id: String,
    pub(crate) consent_epoch: i64,
    pub(crate) schema_version: i64,
    pub(crate) event_name: String,
    pub(crate) payload_json: String,
    pub(crate) priority: i64,
    pub(crate) marks_first_success: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EnqueueOutcome {
    Persisted,
    Disabled,
    StaleEpoch,
    Unavailable,
    Rejected,
}

const STATE_SELECT: &str = "SELECT status, consent_explicit, installation_id, consent_epoch \
     FROM analytics_state WHERE id = 1";

pub(crate) async fn load_state(pool: &SqlitePool) -> Result<Option<AnalyticsStateRow>, String> {
    sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))
}

/// Creates the single state row on first use and re-derives a default-policy
/// status while the user has not made an explicit choice. An explicit choice is
/// never overwritten, even if the deployment default later changes.
pub(crate) async fn ensure_state(
    pool: &SqlitePool,
    policy_version: i64,
    default_enabled: bool,
) -> Result<AnalyticsStateRow, String> {
    let now = now_millis();
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("Failed to begin analytics state transaction: {error}"))?;

    let existing = sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))?;

    let row = match existing {
        None => {
            let status = if default_enabled {
                "enabled"
            } else {
                "disabled"
            };
            let installation_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO analytics_state (id, policy_version, status, consent_explicit, \
                 installation_id, consent_epoch, observation_started_day, updated_at) \
                 VALUES (1, ?, ?, 0, ?, 0, ?, datetime('now'))",
            )
            .bind(policy_version)
            .bind(status)
            .bind(&installation_id)
            .bind(utc_day_from_ms(now))
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to create analytics state: {error}"))?;
            sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
                .fetch_one(&mut *transaction)
                .await
                .map_err(|error| format!("Failed to reload analytics state: {error}"))?
        }
        Some(row) if row.consent_explicit == 0 => {
            let status = if default_enabled {
                "enabled"
            } else {
                "disabled"
            };
            sqlx::query(
                "UPDATE analytics_state SET policy_version = ?, status = ?, \
                 observation_started_day = COALESCE(observation_started_day, ?), \
                 installation_id = COALESCE(installation_id, ?), updated_at = datetime('now') \
                 WHERE id = 1",
            )
            .bind(policy_version)
            .bind(status)
            .bind(utc_day_from_ms(now))
            .bind(uuid::Uuid::new_v4().to_string())
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to reconcile analytics state: {error}"))?;
            sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
                .fetch_one(&mut *transaction)
                .await
                .map_err(|error| format!("Failed to reload analytics state: {error}"))?
        }
        Some(row) => row,
    };

    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics state transaction: {error}"))?;
    Ok(row)
}

/// Applies an explicit user choice. Returns `None` when `expected_epoch` is
/// stale, so the caller keeps the unchanged authoritative state.
pub(crate) async fn set_enabled(
    pool: &SqlitePool,
    enabled: bool,
    expected_epoch: i64,
    policy_version: i64,
) -> Result<Option<AnalyticsStateRow>, String> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("Failed to begin analytics consent transaction: {error}"))?;

    let current = sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))?
        .ok_or_else(|| "analytics_state_missing".to_string())?;

    if current.consent_epoch != expected_epoch {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics consent transaction: {error}"))?;
        return Ok(None);
    }

    let target = if enabled { "enabled" } else { "disabled" };
    if current.status != target {
        let next_epoch = current.consent_epoch + 1;
        sqlx::query(
            "UPDATE analytics_state SET status = ?, consent_explicit = 1, policy_version = ?, \
             consent_epoch = ?, installation_id = COALESCE(installation_id, ?), \
             updated_at = datetime('now') WHERE id = 1",
        )
        .bind(target)
        .bind(policy_version)
        .bind(next_epoch)
        .bind(uuid::Uuid::new_v4().to_string())
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to update analytics state: {error}"))?;

        if !enabled {
            // One transaction: withdrawing consent also clears queued work and the
            // bounded pending-update confirmation state.
            sqlx::query("DELETE FROM analytics_outbox")
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("Failed to clear analytics outbox: {error}"))?;
            sqlx::query("UPDATE analytics_state SET pending_update_json = NULL WHERE id = 1")
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("Failed to clear pending update: {error}"))?;
        }
    } else {
        sqlx::query(
            "UPDATE analytics_state SET consent_explicit = 1, policy_version = ?, \
             updated_at = datetime('now') WHERE id = 1",
        )
        .bind(policy_version)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to record analytics consent: {error}"))?;
    }

    let updated = sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to reload analytics state: {error}"))?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics consent transaction: {error}"))?;
    Ok(Some(updated))
}

/// Clears queued work without changing consent. Returns `None` for a stale epoch.
pub(crate) async fn clear_pending(
    pool: &SqlitePool,
    expected_epoch: i64,
) -> Result<Option<AnalyticsStateRow>, String> {
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("Failed to begin analytics clear transaction: {error}"))?;
    let current = sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))?;
    let Some(current) = current else {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics clear transaction: {error}"))?;
        return Ok(None);
    };
    if current.consent_epoch != expected_epoch {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics clear transaction: {error}"))?;
        return Ok(None);
    }
    sqlx::query("DELETE FROM analytics_outbox")
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to clear analytics outbox: {error}"))?;
    sqlx::query("UPDATE analytics_state SET pending_update_json = NULL, updated_at = datetime('now') WHERE id = 1")
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to clear pending update: {error}"))?;
    let updated = sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to reload analytics state: {error}"))?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics clear transaction: {error}"))?;
    Ok(Some(updated))
}

pub(crate) async fn enqueue(
    pool: &SqlitePool,
    insert: OutboxInsert,
) -> Result<EnqueueOutcome, String> {
    let payload_bytes = insert.payload_json.len() as i64;
    if payload_bytes <= 0 || payload_bytes > MAX_PAYLOAD_BYTES {
        return Ok(EnqueueOutcome::Rejected);
    }
    let now = now_millis();
    let expires_at = now + TTL_MS;

    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("Failed to begin analytics enqueue transaction: {error}"))?;
    let state = sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))?
        .ok_or_else(|| "analytics_state_missing".to_string())?;

    if state.status != "enabled" {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics enqueue: {error}"))?;
        return Ok(EnqueueOutcome::Disabled);
    }
    if state.consent_epoch != insert.consent_epoch {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics enqueue: {error}"))?;
        return Ok(EnqueueOutcome::StaleEpoch);
    }

    // Expired rows are reclaimed before the capacity decision so a stale queue
    // never blocks a fresh event.
    sqlx::query("DELETE FROM analytics_outbox WHERE expires_at <= ?")
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to purge expired analytics events: {error}"))?;

    let mut depth: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM analytics_outbox")
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to count analytics outbox: {error}"))?;
    let mut bytes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(payload_bytes), 0) FROM analytics_outbox")
            .fetch_one(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to size analytics outbox: {error}"))?;

    while depth >= MAX_EVENTS || bytes + payload_bytes > MAX_BYTES {
        let victim = sqlx::query_as::<_, (String, i64)>(
            "SELECT event_id, payload_bytes FROM analytics_outbox \
             WHERE priority > ? ORDER BY priority DESC, enqueued_at ASC LIMIT 1",
        )
        .bind(insert.priority)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to select analytics eviction: {error}"))?;
        let Some((victim_id, victim_bytes)) = victim else {
            break;
        };
        sqlx::query("DELETE FROM analytics_outbox WHERE event_id = ?")
            .bind(&victim_id)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to evict analytics event: {error}"))?;
        depth -= 1;
        bytes -= victim_bytes;
    }

    if depth >= MAX_EVENTS || bytes + payload_bytes > MAX_BYTES {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics enqueue: {error}"))?;
        return Ok(EnqueueOutcome::Unavailable);
    }

    sqlx::query(
        "INSERT INTO analytics_outbox (event_id, consent_epoch, schema_version, event_name, \
         payload_json, payload_bytes, enqueued_at, expires_at, next_attempt_at, attempt_count, priority) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
    )
    .bind(&insert.event_id)
    .bind(insert.consent_epoch)
    .bind(insert.schema_version)
    .bind(&insert.event_name)
    .bind(&insert.payload_json)
    .bind(payload_bytes)
    .bind(now)
    .bind(expires_at)
    .bind(now)
    .bind(insert.priority)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("Failed to enqueue analytics event: {error}"))?;

    if insert.marks_first_success {
        sqlx::query(
            "UPDATE analytics_state SET first_success_day = COALESCE(first_success_day, ?), \
             updated_at = datetime('now') WHERE id = 1",
        )
        .bind(utc_day_from_ms(now))
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to record first success day: {error}"))?;
    }

    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics enqueue: {error}"))?;
    Ok(EnqueueOutcome::Persisted)
}

pub(crate) async fn due_batch(
    pool: &SqlitePool,
    now: i64,
) -> Result<Vec<AnalyticsOutboxRow>, String> {
    sqlx::query_as::<_, AnalyticsOutboxRow>(
        "SELECT event_id, payload_json, attempt_count \
         FROM analytics_outbox WHERE next_attempt_at <= ? AND expires_at > ? \
         ORDER BY priority ASC, next_attempt_at ASC, enqueued_at ASC LIMIT ?",
    )
    .bind(now)
    .bind(now)
    .bind(SEND_BATCH_LIMIT)
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to load due analytics events: {error}"))
}

pub(crate) async fn delete_event(pool: &SqlitePool, event_id: &str) -> Result<(), String> {
    sqlx::query("DELETE FROM analytics_outbox WHERE event_id = ?")
        .bind(event_id)
        .execute(pool)
        .await
        .map(|_| ())
        .map_err(|error| format!("Failed to delete analytics event: {error}"))
}

pub(crate) async fn reschedule(
    pool: &SqlitePool,
    event_id: &str,
    next_attempt_at: i64,
    attempt_count: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE analytics_outbox SET next_attempt_at = ?, attempt_count = ? WHERE event_id = ?",
    )
    .bind(next_attempt_at)
    .bind(attempt_count)
    .bind(event_id)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| format!("Failed to reschedule analytics event: {error}"))
}

pub(crate) async fn purge_expired(pool: &SqlitePool, now: i64) -> Result<u64, String> {
    sqlx::query("DELETE FROM analytics_outbox WHERE expires_at <= ?")
        .bind(now)
        .execute(pool)
        .await
        .map(|result| result.rows_affected())
        .map_err(|error| format!("Failed to purge expired analytics events: {error}"))
}

pub(crate) async fn queue_stats(pool: &SqlitePool) -> Result<(i64, i64), String> {
    let depth: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM analytics_outbox")
        .fetch_one(pool)
        .await
        .map_err(|error| format!("Failed to count analytics outbox: {error}"))?;
    let bytes: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(payload_bytes), 0) FROM analytics_outbox")
            .fetch_one(pool)
            .await
            .map_err(|error| format!("Failed to size analytics outbox: {error}"))?;
    Ok((depth, bytes))
}
