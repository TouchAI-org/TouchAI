// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Typed SQL for the analytics consent state and bounded outbox.
//!
//! Everything runs on the existing `DatabaseRuntime` pool over `touchai.db`;
//! there is no second database, connection or schema framework. These are
//! crate-internal typed statements, not a generic SQL IPC surface.

use sqlx::{Row, SqliteConnection, SqlitePool};
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
    pub(crate) observation_started_day: Option<String>,
    pub(crate) first_success_day: Option<String>,
    pub(crate) pending_update_json: Option<String>,
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
            observation_started_day: row.try_get("observation_started_day")?,
            first_success_day: row.try_get("first_success_day")?,
            pending_update_json: row.try_get("pending_update_json")?,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct AnalyticsOutboxRow {
    pub(crate) event_id: String,
    pub(crate) event_name: String,
    pub(crate) payload_json: String,
    pub(crate) attempt_count: i64,
}

impl<'r> sqlx::FromRow<'r, sqlx::sqlite::SqliteRow> for AnalyticsOutboxRow {
    fn from_row(row: &'r sqlx::sqlite::SqliteRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            event_id: row.try_get("event_id")?,
            event_name: row.try_get("event_name")?,
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

/// A bounded pending-update confirmation to apply in the same transaction as the
/// enqueued rows, so an install handoff and its metadata never half-commit.
pub(crate) enum PendingUpdate {
    /// Leave any stored pending-update metadata untouched.
    Unchanged,
    /// Store bounded pending metadata for the next native start to confirm.
    Set(String),
    /// Confirm only this handoff, clearing it atomically with its event.
    Confirm(String),
}

const STATE_SELECT: &str =
    "SELECT status, consent_explicit, installation_id, consent_epoch, observation_started_day, \
     first_success_day, pending_update_json FROM analytics_state WHERE id = 1";

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
        .begin_with("BEGIN IMMEDIATE")
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
        Some(row) => {
            // An explicit choice is never re-derived, but a restored snapshot
            // carries no installation identity: mint a fresh local one so the
            // restored install is a new anonymous installation rather than the
            // exported one.
            if row.installation_id.is_some() {
                row
            } else {
                sqlx::query(
                    "UPDATE analytics_state SET installation_id = ?, \
                     observation_started_day = COALESCE(observation_started_day, ?), \
                     updated_at = datetime('now') WHERE id = 1",
                )
                .bind(uuid::Uuid::new_v4().to_string())
                .bind(utc_day_from_ms(now))
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("Failed to restore analytics identity: {error}"))?;
                sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
                    .fetch_one(&mut *transaction)
                    .await
                    .map_err(|error| format!("Failed to reload analytics state: {error}"))?
            }
        }
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
        .begin_with("BEGIN IMMEDIATE")
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

/// The consent choice carried by a scrubbed snapshot. It holds no installation
/// identity, consent epoch or queued payload, so a restore keeps the decision
/// without adopting the exporting install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestoredConsent {
    pub(crate) status: String,
    pub(crate) explicit: bool,
}

/// Applies the consent choice preserved by a restored snapshot. The local
/// installation keeps its own identity and local epoch; only a machine that has
/// not made an explicit choice adopts the restored one, which is what stops a
/// backup taken after an explicit opt-out from being re-enabled by the
/// deployment default on the restored install.
///
/// This runs on the caller's import transaction so a failed import cannot leave
/// a half-applied consent choice behind. When the restored choice turns sharing
/// off, every queued event and the pending-update metadata go in the same
/// transaction: a later re-enable must not send anything queued before the
/// opt-out. A missing state row adopts the choice with a fresh local identity
/// instead of dropping it.
pub(crate) async fn adopt_restored_consent(
    connection: &mut SqliteConnection,
    consent: &RestoredConsent,
) -> Result<(), String> {
    if !consent.explicit {
        return Ok(());
    }
    if !matches!(consent.status.as_str(), "enabled" | "disabled") {
        return Err("invalid_restored_consent".to_string());
    }
    let now = now_millis();
    let updated = sqlx::query(
        "UPDATE analytics_state SET consent_explicit = 1, status = ?, \
         consent_epoch = CASE WHEN status = ? THEN consent_epoch ELSE consent_epoch + 1 END, \
         updated_at = datetime('now') WHERE id = 1 AND consent_explicit = 0",
    )
    .bind(&consent.status)
    .bind(&consent.status)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("Failed to restore analytics consent: {error}"))?
    .rows_affected();

    let applied = if updated > 0 {
        true
    } else {
        let existing: Option<i64> =
            sqlx::query_scalar("SELECT 1 FROM analytics_state WHERE id = 1")
                .fetch_optional(&mut *connection)
                .await
                .map_err(|error| format!("Failed to read analytics state: {error}"))?;
        if existing.is_none() {
            sqlx::query(
                "INSERT INTO analytics_state (id, status, consent_explicit, installation_id, \
                 observation_started_day, updated_at) VALUES (1, ?, 1, ?, ?, datetime('now'))",
            )
            .bind(&consent.status)
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(utc_day_from_ms(now))
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to create restored analytics state: {error}"))?;
            true
        } else {
            // An explicit choice made on this machine wins over the backup.
            false
        }
    };

    if applied && consent.status == "disabled" {
        sqlx::query("DELETE FROM analytics_outbox")
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to clear restored analytics outbox: {error}"))?;
        sqlx::query(
            "UPDATE analytics_state SET pending_update_json = NULL, \
             updated_at = datetime('now') WHERE id = 1",
        )
        .execute(&mut *connection)
        .await
        .map_err(|error| format!("Failed to clear restored analytics pending update: {error}"))?;
    }
    Ok(())
}

/// Clears queued work without changing consent. Returns `None` for a stale epoch.
pub(crate) async fn clear_pending(
    pool: &SqlitePool,
    expected_epoch: i64,
) -> Result<Option<AnalyticsStateRow>, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
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

/// Persist one validated event. Delegates to [`enqueue_batch`] so a native
/// session start and its triggering interaction can commit in one transaction.
pub(crate) async fn enqueue(
    pool: &SqlitePool,
    insert: OutboxInsert,
) -> Result<EnqueueOutcome, String> {
    enqueue_batch(pool, vec![insert], PendingUpdate::Unchanged).await
}

/// Persist a group of validated events that share one consent epoch in a single
/// SQLite transaction.
///
/// ## Atomicity
///
/// The batch commits in one transaction: either every row lands or none does, so
/// a native `analytics.session_started` and the interaction that opened the
/// session can never half-commit and a session cannot be advertised without its
/// session-start row.
///
/// ## Durability
///
/// The batch commits on the existing `touchai.db` pool, which runs the shared WAL +
/// `synchronous=NORMAL` policy. A committed row therefore survives a
/// process/OS crash and is retried after restart. It is not a power-loss or
/// storage-failure durability guarantee, and this module never changes the
/// shared journal/fsync policy.
pub(crate) async fn enqueue_batch(
    pool: &SqlitePool,
    inserts: Vec<OutboxInsert>,
    pending: PendingUpdate,
) -> Result<EnqueueOutcome, String> {
    if inserts.is_empty() {
        return Ok(EnqueueOutcome::Persisted);
    }
    let consent_epoch = inserts[0].consent_epoch;
    if inserts
        .iter()
        .any(|insert| insert.consent_epoch != consent_epoch)
    {
        return Err("mixed_consent_epoch".to_string());
    }
    for insert in &inserts {
        let payload_bytes = insert.payload_json.len() as i64;
        if payload_bytes <= 0 || payload_bytes > MAX_PAYLOAD_BYTES {
            return Ok(EnqueueOutcome::Rejected);
        }
    }

    let now = now_millis();
    let expires_at = now + TTL_MS;

    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics enqueue transaction: {error}"))?;
    let state = sqlx::query_as::<_, AnalyticsStateRow>(STATE_SELECT)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))?
        .ok_or_else(|| "analytics_state_missing".to_string())?;

    if let PendingUpdate::Confirm(expected) = &pending {
        if state.pending_update_json.as_deref() != Some(expected.as_str()) {
            // Another resolver already confirmed it, or a new handoff replaced it.
            transaction
                .commit()
                .await
                .map_err(|error| format!("Failed to commit analytics confirmation: {error}"))?;
            return Ok(EnqueueOutcome::Persisted);
        }
    }

    if state.status != "enabled" {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics enqueue: {error}"))?;
        return Ok(EnqueueOutcome::Disabled);
    }
    if state.consent_epoch != consent_epoch {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics enqueue: {error}"))?;
        return Ok(EnqueueOutcome::StaleEpoch);
    }

    // Session starts must go through native abandonment, including handle
    // revocation. Leave those for `purge_expired` rather than erase the proof
    // that their dependents have never had an accepted start.
    sqlx::query(
        "DELETE FROM analytics_outbox WHERE expires_at <= ? \
         AND event_name != 'analytics.session_started'",
    )
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

    let mut marks_first_success = false;
    for insert in &inserts {
        let payload_bytes = insert.payload_json.len() as i64;
        while depth >= MAX_EVENTS || bytes + payload_bytes > MAX_BYTES {
            let victim = sqlx::query_as::<_, (String, i64)>(
                "SELECT event_id, payload_bytes FROM analytics_outbox \
                 WHERE priority > ? AND event_name != 'analytics.session_started' \
                 ORDER BY priority DESC, enqueued_at ASC LIMIT 1",
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
            // The batch cannot fit as a whole, so nothing of it may land: roll
            // back rather than commit the rows inserted before this one.
            transaction
                .rollback()
                .await
                .map_err(|error| format!("Failed to roll back analytics enqueue: {error}"))?;
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
        depth += 1;
        bytes += payload_bytes;
        marks_first_success |= insert.marks_first_success;
    }

    if marks_first_success {
        sqlx::query(
            "UPDATE analytics_state SET first_success_day = COALESCE(first_success_day, ?), \
             updated_at = datetime('now') WHERE id = 1",
        )
        .bind(utc_day_from_ms(now))
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to record first success day: {error}"))?;
    }

    match pending {
        PendingUpdate::Unchanged => {}
        PendingUpdate::Set(json) => {
            sqlx::query(
                "UPDATE analytics_state SET pending_update_json = ?, updated_at = datetime('now') \
                 WHERE id = 1",
            )
            .bind(json)
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to store pending update: {error}"))?;
        }
        PendingUpdate::Confirm(_) => {
            sqlx::query(
                "UPDATE analytics_state SET pending_update_json = NULL, \
                 updated_at = datetime('now') WHERE id = 1",
            )
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to clear pending update: {error}"))?;
        }
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
        "SELECT event_id, event_name, payload_json, attempt_count \
         FROM analytics_outbox WHERE next_attempt_at <= ? AND expires_at > ? \
         ORDER BY CASE WHEN event_name = 'analytics.session_started' THEN 0 ELSE priority END ASC, \
         next_attempt_at ASC, enqueued_at ASC LIMIT ?",
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

/// Re-check a buffered row against live consent and the queue before sending.
/// A full import or clear-pending can remove it after the batch was read.
pub(crate) async fn event_is_sendable(pool: &SqlitePool, event_id: &str) -> Result<bool, String> {
    let sendable: i64 = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM analytics_outbox AS event \
         JOIN analytics_state AS state ON state.id = 1 \
         WHERE event.event_id = ? AND event.consent_epoch = state.consent_epoch \
         AND state.status = 'enabled' AND event.expires_at > ?)",
    )
    .bind(event_id)
    .bind(now_millis())
    .fetch_one(pool)
    .await
    .map_err(|error| format!("Failed to check analytics delivery eligibility: {error}"))?;
    Ok(sendable != 0)
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

/// Moves one row later in the queue, never earlier, so a dependent event waits
/// for the session start it references without losing its own backoff.
pub(crate) async fn hold_event_until(
    pool: &SqlitePool,
    event_id: &str,
    next_attempt_at: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE analytics_outbox SET next_attempt_at = ? \
         WHERE event_id = ? AND next_attempt_at < ?",
    )
    .bind(next_attempt_at)
    .bind(event_id)
    .bind(next_attempt_at)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| format!("Failed to hold analytics event: {error}"))
}

/// The session id a queued envelope references, if any. Envelope payloads are the
/// only place the outbox stores it, so this is the shared reader for the
/// send-order guard and the fail-closed session drop.
pub(crate) fn session_id_from_payload(payload_json: &str) -> Option<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SessionRef {
        #[serde(default)]
        analytics_session_id: Option<String>,
    }
    serde_json::from_str::<SessionRef>(payload_json)
        .ok()?
        .analytics_session_id
}

/// Session starts that are still queued, with the instant each one becomes
/// retryable. Any event that references such a session is held back to that
/// instant, so the receiver never sees a reference before its session start.
pub(crate) async fn undelivered_session_starts(
    pool: &SqlitePool,
) -> Result<std::collections::HashMap<String, i64>, String> {
    let rows: Vec<(i64, String)> = sqlx::query_as(
        "SELECT next_attempt_at, payload_json FROM analytics_outbox \
         WHERE event_name = 'analytics.session_started'",
    )
    .fetch_all(pool)
    .await
    .map_err(|error| format!("Failed to read queued analytics session starts: {error}"))?;
    let mut starts = std::collections::HashMap::new();
    for (next_attempt_at, payload_json) in rows {
        let session_id = session_id_from_payload(&payload_json)
            .ok_or_else(|| "stored_session_start_corrupt".to_string())?;
        starts.insert(session_id, next_attempt_at);
    }
    Ok(starts)
}

/// Drops a whole session in one transaction after the receiver permanently
/// rejected its `analytics.session_started` row. An event can never be
/// attributed without the session start that describes it, so every queued row
/// that references the session is removed instead of being sent as an orphan.
/// Returns the number of removed rows.
pub(crate) async fn drop_session(pool: &SqlitePool, session_id: &str) -> Result<u64, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics session drop: {error}"))?;
    let dropped = drop_session_on_connection(&mut *transaction, session_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics session drop: {error}"))?;
    Ok(dropped)
}

async fn drop_session_on_connection(
    connection: &mut SqliteConnection,
    session_id: &str,
) -> Result<u64, String> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT event_id, payload_json FROM analytics_outbox")
            .fetch_all(&mut *connection)
            .await
            .map_err(|error| format!("Failed to read analytics outbox: {error}"))?;
    let mut dropped = 0_u64;
    for (event_id, payload_json) in rows {
        if session_id_from_payload(&payload_json).as_deref() != Some(session_id) {
            continue;
        }
        sqlx::query("DELETE FROM analytics_outbox WHERE event_id = ?")
            .bind(&event_id)
            .execute(&mut *connection)
            .await
            .map_err(|error| format!("Failed to drop analytics session event: {error}"))?;
        dropped += 1;
    }
    Ok(dropped)
}

/// Returns the removed count and abandoned session ids for native revocation.
pub(crate) async fn purge_expired(
    pool: &SqlitePool,
    now: i64,
) -> Result<(u64, Vec<Option<String>>), String> {
    // A session start that expires drops its dependents with it: an event that
    // references a session we can no longer report must not be sent as an
    // orphan. The pick reads the expiry index and is usually empty.
    let has_expired: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM analytics_outbox WHERE expires_at <= ?)")
            .bind(now)
            .fetch_one(pool)
            .await
            .map_err(|error| format!("Failed to inspect expired analytics events: {error}"))?;
    if has_expired == 0 {
        return Ok((0, Vec::new()));
    }
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics expiry transaction: {error}"))?;
    let expired: Vec<String> = sqlx::query_scalar(
        "SELECT payload_json FROM analytics_outbox WHERE expires_at <= ? \
         AND event_name = 'analytics.session_started'",
    )
    .bind(now)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|error| format!("Failed to read expired analytics events: {error}"))?;
    let expired_sessions: std::collections::HashSet<Option<String>> = expired
        .iter()
        .map(|payload_json| session_id_from_payload(payload_json))
        .collect();
    let mut removed = sqlx::query("DELETE FROM analytics_outbox WHERE expires_at <= ?")
        .bind(now)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to purge expired analytics events: {error}"))?
        .rows_affected();
    for session_id in &expired_sessions {
        removed += match session_id {
            Some(session_id) => drop_session_on_connection(&mut *transaction, session_id).await?,
            None => sqlx::query("DELETE FROM analytics_outbox")
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("Failed to drop corrupt analytics session: {error}"))?
                .rows_affected(),
        };
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics expiry transaction: {error}"))?;
    Ok((removed, expired_sessions.into_iter().collect()))
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

/// Drops pending-update metadata without enqueuing anything. Used when the
/// stored handoff is stale (an unfinished update, a restored backup or a changed
/// consent epoch) so a restored backup can never become a false confirmation.
pub(crate) async fn clear_pending_update(pool: &SqlitePool, expected: &str) -> Result<(), String> {
    sqlx::query(
        "UPDATE analytics_state SET pending_update_json = NULL, updated_at = datetime('now') \
         WHERE id = 1 AND pending_update_json = ?",
    )
    .bind(expected)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| format!("Failed to clear pending update: {error}"))
}

/// Records the running app version so the next native start can tell an actual
/// restart after an update apart from a restored backup.
pub(crate) async fn observe_app_version(pool: &SqlitePool, version: &str) -> Result<(), String> {
    sqlx::query(
        "UPDATE analytics_state SET last_observed_app_version = ?, \
         updated_at = datetime('now') WHERE id = 1",
    )
    .bind(version)
    .execute(pool)
    .await
    .map(|_| ())
    .map_err(|error| format!("Failed to record observed version: {error}"))
}

/// Settings key that records which deployment (endpoint + project id) enqueued
/// the current rows. It is not a secret and carries no event data; export
/// scrubbing drops it so a backup never carries another install's binding.
pub(crate) const DEPLOYMENT_KEY_SETTING: &str = "analytics.deploymentKey";

/// Binds the outbox to one deployment. When the resolved deployment key differs
/// from the stored one, every queued row was produced for a different endpoint
/// or project id and is dropped, so a community/self build queue can never be
/// flushed through the official deployment after a build switch. Returns whether
/// rows were cleared. Storing the key is part of the same transaction so the
/// binding and the clear cannot half-commit.
pub(crate) async fn reconcile_deployment_key(
    pool: &SqlitePool,
    current: &str,
) -> Result<bool, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics deployment transaction: {error}"))?;
    let stored: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(DEPLOYMENT_KEY_SETTING)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|error| format!("Failed to read analytics deployment key: {error}"))?;

    let mut cleared = false;
    if stored.as_deref().is_some_and(|stored| stored != current) {
        sqlx::query("DELETE FROM analytics_outbox")
            .execute(&mut *transaction)
            .await
            .map_err(|error| format!("Failed to clear analytics outbox: {error}"))?;
        cleared = true;
    }

    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(DEPLOYMENT_KEY_SETTING)
    .bind(current)
    .execute(&mut *transaction)
    .await
    .map_err(|error| format!("Failed to store analytics deployment key: {error}"))?;

    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics deployment transaction: {error}"))?;
    Ok(cleared)
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

    /// Adoption runs on a caller-supplied connection so the import transaction
    /// owns the atomicity; these tests supply one from the pool.
    async fn adopt(pool: &SqlitePool, consent: &RestoredConsent) -> Result<(), String> {
        let mut transaction = pool
            .begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|error| format!("Failed to begin consent adoption: {error}"))?;
        adopt_restored_consent(&mut *transaction, consent).await?;
        transaction
            .commit()
            .await
            .map_err(|error| error.to_string())
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

    #[tokio::test]
    async fn user_keeps_a_pending_handoff_until_the_matching_saved_metadata_is_cleared() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();
        ensure_state(pool, 1, true).await.expect("create state");

        let stored = serde_json::json!({ "toVersion": "2.0.0" }).to_string();
        assert_eq!(
            enqueue_batch(
                pool,
                vec![insert("e1", 0, "app.update_transition")],
                PendingUpdate::Set(stored.clone())
            )
            .await
            .expect("enqueue"),
            EnqueueOutcome::Persisted
        );
        let row = load_state(pool).await.expect("load").expect("row");
        assert_eq!(row.pending_update_json.as_deref(), Some(stored.as_str()));

        clear_pending_update(pool, &stored).await.expect("clear");
        let row = load_state(pool).await.expect("load").expect("row");
        assert!(row.pending_update_json.is_none());
    }

    #[tokio::test]
    async fn user_gets_the_observed_app_version_recorded() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();
        ensure_state(pool, 1, true).await.expect("create state");

        observe_app_version(pool, "1.2.3").await.expect("observe");
        let value: Option<String> = sqlx::query_scalar(
            "SELECT last_observed_app_version FROM analytics_state WHERE id = 1",
        )
        .fetch_one(pool)
        .await
        .expect("read version");
        assert_eq!(value.as_deref(), Some("1.2.3"));
    }

    #[tokio::test]
    async fn user_gets_an_explicit_opt_out_restored_without_adopting_the_exported_identity() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        let created = ensure_state(pool, 1, true).await.expect("create state");
        assert_eq!(created.status, "enabled");
        let local_installation = created.installation_id.clone().expect("local identity");

        adopt(
            pool,
            &RestoredConsent {
                status: "disabled".to_string(),
                explicit: true,
            },
        )
        .await
        .expect("adopt restored consent");

        let restored = load_state(pool).await.expect("load").expect("row");
        assert_eq!(restored.status, "disabled");
        assert_eq!(restored.consent_explicit, 1);
        assert_eq!(
            restored.consent_epoch, 1,
            "a changed consent bumps the epoch"
        );
        assert_eq!(
            restored.installation_id.as_deref(),
            Some(local_installation.as_str()),
            "the restored install keeps its own anonymous identity"
        );

        // The restored choice is explicit, so a later default-policy change must
        // not re-enable sharing.
        let reconciled = ensure_state(pool, 2, true).await.expect("reconcile");
        assert_eq!(reconciled.status, "disabled");
        assert_eq!(reconciled.consent_epoch, 1);
    }

    #[tokio::test]
    async fn user_keeps_the_consent_choice_made_on_this_machine_over_a_restored_one() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");
        set_enabled(pool, false, 0, 1)
            .await
            .expect("disable")
            .expect("matching epoch");

        adopt(
            pool,
            &RestoredConsent {
                status: "enabled".to_string(),
                explicit: true,
            },
        )
        .await
        .expect("adopt restored consent");

        let reloaded = load_state(pool).await.expect("load").expect("row");
        assert_eq!(reloaded.status, "disabled");
        assert_eq!(reloaded.consent_epoch, 1);
    }

    #[tokio::test]
    async fn user_gets_the_pre_restore_queue_purged_with_a_restored_opt_out() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");
        enqueue(pool, insert("e1", 0, "app.started"))
            .await
            .expect("enqueue");
        let pending = serde_json::json!({ "toVersion": "2.0.0" }).to_string();
        enqueue_batch(
            pool,
            vec![insert("e2", 0, "app.update_transition")],
            PendingUpdate::Set(pending),
        )
        .await
        .expect("enqueue with pending metadata");
        assert_eq!(queue_stats(pool).await.expect("stats").0, 2);

        adopt(
            pool,
            &RestoredConsent {
                status: "disabled".to_string(),
                explicit: true,
            },
        )
        .await
        .expect("adopt restored consent");

        let restored = load_state(pool).await.expect("load").expect("row");
        assert_eq!(restored.status, "disabled");
        assert_eq!(
            queue_stats(pool).await.expect("stats").0,
            0,
            "a restored opt-out must not leave pre-opt-out events queued"
        );
        assert!(
            restored.pending_update_json.is_none(),
            "a restored opt-out must not leave pending update metadata"
        );
    }

    #[tokio::test]
    async fn user_clears_old_pending_work_when_a_restored_opt_out_matches_the_current_default() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();
        ensure_state(pool, 1, false).await.expect("default off");
        sqlx::query("UPDATE analytics_state SET pending_update_json = '{}' WHERE id = 1")
            .execute(pool)
            .await
            .expect("seed old pending metadata");
        sqlx::query(
            "INSERT INTO analytics_outbox (event_id, consent_epoch, schema_version, event_name, \
             payload_json, payload_bytes, enqueued_at, expires_at, next_attempt_at) \
             VALUES ('old', 0, 1, 'app.started', '{}', 2, 1, 9, 1)",
        )
        .execute(pool)
        .await
        .expect("seed old queued work");

        adopt(
            pool,
            &RestoredConsent {
                status: "disabled".to_string(),
                explicit: true,
            },
        )
        .await
        .expect("adopt explicit opt-out");

        let state = load_state(pool).await.expect("load").expect("row");
        assert_eq!(state.status, "disabled");
        assert_eq!(state.consent_explicit, 1);
        assert_eq!(
            state.consent_epoch, 0,
            "the same status keeps its local epoch"
        );
        assert!(state.pending_update_json.is_none());
        assert_eq!(queue_stats(pool).await.expect("stats").0, 0);
    }

    #[tokio::test]
    async fn user_keeps_the_local_default_when_a_backup_contains_no_explicit_choice() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();
        ensure_state(pool, 1, true).await.expect("default on");
        enqueue(pool, insert("local", 0, "app.started"))
            .await
            .expect("enqueue");

        adopt(
            pool,
            &RestoredConsent {
                status: "disabled".to_string(),
                explicit: false,
            },
        )
        .await
        .expect("ignore restored default");

        let state = load_state(pool).await.expect("load").expect("row");
        assert_eq!(state.status, "enabled");
        assert_eq!(state.consent_explicit, 0);
        assert_eq!(state.consent_epoch, 0);
        assert_eq!(queue_stats(pool).await.expect("stats").0, 1);
    }

    #[tokio::test]
    async fn user_keeps_the_local_queue_when_a_restored_opt_out_is_not_adopted() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");
        set_enabled(pool, true, 0, 1)
            .await
            .expect("opt in")
            .expect("matching epoch");
        enqueue(pool, insert("e1", 0, "app.started"))
            .await
            .expect("enqueue");

        adopt(
            pool,
            &RestoredConsent {
                status: "disabled".to_string(),
                explicit: true,
            },
        )
        .await
        .expect("adopt restored consent");

        let reloaded = load_state(pool).await.expect("load").expect("row");
        assert_eq!(reloaded.status, "enabled", "the local explicit choice wins");
        assert_eq!(
            queue_stats(pool).await.expect("stats").0,
            1,
            "an unadopted restore must not purge this machine's queue"
        );
    }

    #[tokio::test]
    async fn user_gets_a_fresh_identity_when_an_explicit_choice_was_restored_without_one() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();

        ensure_state(pool, 1, true).await.expect("create state");
        // A scrubbed snapshot keeps the decision but no identity.
        sqlx::query(
            "UPDATE analytics_state SET status = 'disabled', consent_explicit = 1, \
             installation_id = NULL, consent_epoch = 0 WHERE id = 1",
        )
        .execute(pool)
        .await
        .expect("seed scrubbed state");

        let reconciled = ensure_state(pool, 1, true).await.expect("reconcile");
        assert_eq!(reconciled.status, "disabled");
        assert!(reconciled.installation_id.is_some());
        assert!(reconciled.observation_started_day.is_some());
    }

    #[tokio::test]
    async fn user_gets_another_deployments_queued_events_dropped_when_the_target_changes() {
        let (_root, runtime) = test_runtime().await;
        let pool = runtime.pool();
        ensure_state(pool, 1, true).await.expect("create state");

        // The first run binds the outbox to deployment A and keeps its rows.
        assert!(
            !reconcile_deployment_key(pool, "https://a/send|a")
                .await
                .expect("bind a"),
            "a first run has nothing foreign to clear"
        );
        enqueue(pool, insert("e1", 0, "app.started"))
            .await
            .expect("enqueue");
        assert!(
            !reconcile_deployment_key(pool, "https://a/send|a")
                .await
                .expect("same deployment"),
            "the same deployment keeps its rows"
        );
        assert_eq!(queue_stats(pool).await.expect("stats").0, 1);

        // Switching to a different target means the queued rows are foreign.
        assert!(
            reconcile_deployment_key(pool, "https://b/send|b")
                .await
                .expect("bind b"),
            "a changed deployment clears the foreign rows"
        );
        assert_eq!(queue_stats(pool).await.expect("stats").0, 0);
    }
}
