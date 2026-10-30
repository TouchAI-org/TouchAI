// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Typed SQL for the analytics consent state and bounded outbox.
//!
//! Everything runs on the existing `DatabaseRuntime` pool over `touchai.db`;
//! there is no second database, connection or schema framework. These are
//! crate-internal typed statements, not a generic SQL IPC surface.

use sqlx::{Row, SqlitePool};
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

/// Fixed-format `YYYY-MM-DD` UTC day for a millisecond timestamp.
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

#[derive(Debug, Clone)]
pub(crate) struct AnalyticsStateRow {
    pub(crate) status: String,
    pub(crate) consent_explicit: i64,
    pub(crate) installation_id: Option<String>,
    pub(crate) consent_epoch: i64,
}

// `sqlx` is built without the `macros` feature, so the `FromRow` derive is not
// available. These small manual impls keep typed decoding without adding a
// dependency feature or a second schema definition.
impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for AnalyticsStateRow {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            status: row.try_get("status")?,
            consent_explicit: row.try_get("consent_explicit")?,
            installation_id: row.try_get("installation_id")?,
            consent_epoch: row.try_get("consent_epoch")?,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AnalyticsOutboxRow {
    pub(crate) event_id: String,
    pub(crate) payload_json: String,
    pub(crate) attempt_count: i64,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for AnalyticsOutboxRow {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            event_id: row.try_get("event_id")?,
            payload_json: row.try_get("payload_json")?,
            attempt_count: row.try_get("attempt_count")?,
        })
    }
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

/// Persist one validated event.
///
/// ## Durability
///
/// Enqueue commits in a single SQLite transaction on the existing `touchai.db`
/// pool, which runs the shared WAL + `synchronous=NORMAL` policy. A committed row
/// therefore survives a process/OS crash and is retried after restart. It is not a
/// power-loss or storage-failure durability guarantee, and this module never changes
/// the shared journal/fsync policy.
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::database::DatabaseRuntime;

    async fn test_runtime() -> (tempfile::TempDir, DatabaseRuntime) {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        (root, runtime)
    }

    fn insert(event_id: &str, epoch: i64, event_name: &str) -> OutboxInsert {
        OutboxInsert {
            event_id: event_id.to_string(),
            consent_epoch: epoch,
            schema_version: 1,
            event_name: event_name.to_string(),
            payload_json: r#"{"eventId":"placeholder"}"#.to_string(),
            priority: 100,
            marks_first_success: false,
        }
    }

    #[tokio::test]
    async fn user_gets_a_release_default_that_an_explicit_disable_never_re_derives() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        let created = ensure_state(pool, 1, true).await.expect("create state");
        assert_eq!(created.status, "enabled");
        assert_eq!(created.consent_explicit, 0);

        let disabled = set_enabled(pool, false, 0, 1)
            .await
            .expect("disable")
            .expect("matching epoch");
        assert_eq!(disabled.status, "disabled");
        assert_eq!(disabled.consent_epoch, 1);
        assert_eq!(disabled.consent_explicit, 1);

        // A later default-policy change must not override the explicit choice.
        let reconciled = ensure_state(pool, 2, true).await.expect("reconcile");
        assert_eq!(reconciled.status, "disabled");
        assert_eq!(reconciled.consent_epoch, 1);
    }

    #[tokio::test]
    async fn user_gets_a_default_off_status_re_derived_when_the_policy_changes() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        let off = ensure_state(pool, 1, false).await.expect("create state");
        assert_eq!(off.status, "disabled");

        let on = ensure_state(pool, 2, true).await.expect("reconcile");
        assert_eq!(on.status, "enabled");
        assert_eq!(on.consent_epoch, 0);
    }

    #[tokio::test]
    async fn user_gets_a_stale_consent_epoch_rejected_without_changing_status() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");
        assert!(set_enabled(pool, false, 99, 1)
            .await
            .expect("disable")
            .is_none());

        let reloaded = load_state(pool).await.expect("load").expect("row");
        assert_eq!(reloaded.status, "enabled");
        assert_eq!(reloaded.consent_epoch, 0);
    }

    #[tokio::test]
    async fn user_gets_the_outbox_cleared_in_one_step_when_sharing_is_turned_off() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");
        assert_eq!(
            enqueue(pool, insert("e1", 0, "app.started"))
                .await
                .expect("enqueue"),
            EnqueueOutcome::Persisted
        );
        assert_eq!(queue_stats(pool).await.expect("stats").0, 1);

        set_enabled(pool, false, 0, 1).await.expect("disable");
        assert_eq!(queue_stats(pool).await.expect("stats").0, 0);
    }

    #[tokio::test]
    async fn user_gets_oversized_payloads_rejected_and_expired_events_purged() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");

        let mut oversized = insert("e2", 0, "app.started");
        oversized.payload_json = "x".repeat(MAX_PAYLOAD_BYTES as usize + 1);
        assert_eq!(
            enqueue(pool, oversized).await.expect("enqueue"),
            EnqueueOutcome::Rejected
        );

        enqueue(pool, insert("e3", 0, "app.started"))
            .await
            .expect("enqueue");
        purge_expired(pool, now_millis() + TTL_MS + 1)
            .await
            .expect("purge");
        assert_eq!(queue_stats(pool).await.expect("stats").0, 0);
    }

    #[tokio::test]
    async fn user_gets_events_from_a_stale_or_disabled_state_rejected() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");
        assert_eq!(
            enqueue(pool, insert("e4", 5, "app.started"))
                .await
                .expect("enqueue"),
            EnqueueOutcome::StaleEpoch
        );

        set_enabled(pool, false, 0, 1).await.expect("disable");
        assert_eq!(
            enqueue(pool, insert("e5", 1, "app.started"))
                .await
                .expect("enqueue"),
            EnqueueOutcome::Disabled
        );
    }
}
