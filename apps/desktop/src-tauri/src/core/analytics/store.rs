// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Consent and installation state stored in the existing generic `settings`
//! table. Event delivery is intentionally not persisted here; it lives in the
//! bounded in-memory queue.

use serde::{Deserialize, Serialize};
use sqlx::{SqliteConnection, SqlitePool};
use time::OffsetDateTime;

pub(crate) const ANALYTICS_STATE_SETTING: &str = "analytics.state.v1";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalyticsStateRow {
    #[serde(default = "default_policy_version")]
    pub(crate) policy_version: i64,
    #[serde(default)]
    pub(crate) status: String,
    #[serde(default)]
    pub(crate) consent_explicit: i64,
    #[serde(default)]
    pub(crate) installation_id: Option<String>,
    #[serde(default)]
    pub(crate) consent_epoch: i64,
    #[serde(default)]
    pub(crate) observation_started_day: Option<String>,
    #[serde(default)]
    pub(crate) first_success_day: Option<String>,
    #[serde(default)]
    pub(crate) last_observed_app_version: Option<String>,
    #[serde(default)]
    pub(crate) pending_update_json: Option<String>,
    #[serde(default)]
    pub(crate) deployment_key: String,
    #[serde(default)]
    pub(crate) updated_at_ms: i64,
}

fn default_policy_version() -> i64 {
    1
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestoredConsent {
    pub(crate) status: String,
    pub(crate) explicit: bool,
}

/// A metadata change that must be persisted when an event is accepted by the
/// in-memory queue.
pub(crate) enum PendingUpdate {
    Unchanged,
    Set(String),
    Confirm(String),
}

pub(crate) enum MetadataOutcome {
    Applied,
    Disabled,
    StaleEpoch,
    PendingChanged,
}

pub(crate) async fn load_state(pool: &SqlitePool) -> Result<Option<AnalyticsStateRow>, String> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(ANALYTICS_STATE_SETTING)
        .fetch_optional(pool)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))?;
    value.map(|json| parse_state(&json)).transpose()
}

async fn read_state(
    connection: &mut SqliteConnection,
) -> Result<Option<AnalyticsStateRow>, String> {
    let value: Option<String> = sqlx::query_scalar("SELECT value FROM settings WHERE key = ?")
        .bind(ANALYTICS_STATE_SETTING)
        .fetch_optional(&mut *connection)
        .await
        .map_err(|error| format!("Failed to read analytics state: {error}"))?;
    value.map(|json| parse_state(&json)).transpose()
}

fn parse_state(value: &str) -> Result<AnalyticsStateRow, String> {
    let state: AnalyticsStateRow = serde_json::from_str(value)
        .map_err(|error| format!("Failed to parse analytics state: {error}"))?;
    if !matches!(
        state.status.as_str(),
        "uninitialized" | "enabled" | "disabled"
    ) {
        return Err("invalid_analytics_status".to_string());
    }
    if !matches!(state.consent_explicit, 0 | 1) {
        return Err("invalid_analytics_consent_marker".to_string());
    }
    if state.consent_epoch < 0 {
        return Err("invalid_analytics_consent_epoch".to_string());
    }
    Ok(state)
}

/// Replaces analytics identity and local delivery metadata with a backup-safe
/// value while preserving the explicit consent decision.
pub(crate) fn sanitize_exported_state(value: &str) -> Result<(String, RestoredConsent), String> {
    let mut state = parse_state(value)?;
    let consent = RestoredConsent {
        status: state.status.clone(),
        explicit: state.consent_explicit == 1,
    };
    state.installation_id = None;
    state.consent_epoch = 0;
    state.observation_started_day = None;
    state.first_success_day = None;
    state.last_observed_app_version = None;
    state.pending_update_json = None;
    state.deployment_key.clear();
    state.updated_at_ms = now_millis();
    let scrubbed = serde_json::to_string(&state)
        .map_err(|error| format!("Failed to serialize scrubbed analytics state: {error}"))?;
    Ok((scrubbed, consent))
}

async fn write_state(
    connection: &mut SqliteConnection,
    state: &mut AnalyticsStateRow,
) -> Result<(), String> {
    state.updated_at_ms = now_millis();
    let json = serde_json::to_string(state)
        .map_err(|error| format!("Failed to serialize analytics state: {error}"))?;
    sqlx::query(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    )
    .bind(ANALYTICS_STATE_SETTING)
    .bind(json)
    .execute(&mut *connection)
    .await
    .map_err(|error| format!("Failed to write analytics state: {error}"))?;
    Ok(())
}

/// Creates the state record on first use and re-derives a default-policy status
/// while the user has not made an explicit choice.
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
    let mut state = match read_state(&mut transaction).await? {
        Some(state) => state,
        None => AnalyticsStateRow {
            policy_version,
            status: if default_enabled {
                "enabled"
            } else {
                "disabled"
            }
            .to_string(),
            consent_explicit: 0,
            installation_id: Some(uuid::Uuid::new_v4().to_string()),
            consent_epoch: 0,
            observation_started_day: Some(utc_day_from_ms(now)),
            first_success_day: None,
            last_observed_app_version: None,
            pending_update_json: None,
            deployment_key: String::new(),
            updated_at_ms: now,
        },
    };
    if state.consent_explicit == 0 {
        state.policy_version = policy_version;
        state.status = if default_enabled {
            "enabled"
        } else {
            "disabled"
        }
        .to_string();
        state
            .observation_started_day
            .get_or_insert_with(|| utc_day_from_ms(now));
    }
    if state.installation_id.is_none() {
        state.installation_id = Some(uuid::Uuid::new_v4().to_string());
        state
            .observation_started_day
            .get_or_insert_with(|| utc_day_from_ms(now));
    }
    write_state(&mut transaction, &mut state).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics state transaction: {error}"))?;
    Ok(state)
}

/// Applies an explicit user choice. `None` means the caller's consent view was
/// stale and the authoritative state was left unchanged.
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
    let Some(mut state) = read_state(&mut transaction).await? else {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics consent transaction: {error}"))?;
        return Ok(None);
    };
    if state.consent_epoch != expected_epoch {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics consent transaction: {error}"))?;
        return Ok(None);
    }

    let target = if enabled { "enabled" } else { "disabled" };
    if state.status != target {
        state.status = target.to_string();
        state.consent_epoch += 1;
    }
    state.consent_explicit = 1;
    state.policy_version = policy_version;
    if state.installation_id.is_none() {
        state.installation_id = Some(uuid::Uuid::new_v4().to_string());
    }
    if !enabled {
        state.pending_update_json = None;
    }
    write_state(&mut transaction, &mut state).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics consent transaction: {error}"))?;
    Ok(Some(state))
}

/// Applies the consent choice carried by a scrubbed backup. A choice already
/// made on this machine wins. When no local record exists, a fresh local
/// identity is created.
pub(crate) async fn adopt_restored_consent(
    connection: &mut SqliteConnection,
    consent: &RestoredConsent,
) -> Result<(), String> {
    if !consent.explicit || !matches!(consent.status.as_str(), "enabled" | "disabled") {
        return Ok(());
    }
    let now = now_millis();
    let (mut state, state_existed) = match read_state(&mut *connection).await? {
        Some(state) => (state, true),
        None => (
            AnalyticsStateRow {
                policy_version: 1,
                status: consent.status.clone(),
                consent_explicit: 1,
                installation_id: Some(uuid::Uuid::new_v4().to_string()),
                consent_epoch: 0,
                observation_started_day: Some(utc_day_from_ms(now)),
                first_success_day: None,
                last_observed_app_version: None,
                pending_update_json: None,
                deployment_key: String::new(),
                updated_at_ms: now,
            },
            false,
        ),
    };
    if state_existed && state.consent_explicit == 1 {
        return Ok(());
    }
    if state.status != consent.status {
        state.consent_epoch += 1;
        state.status = consent.status.clone();
    }
    state.consent_explicit = 1;
    if state.installation_id.is_none() {
        state.installation_id = Some(uuid::Uuid::new_v4().to_string());
        state
            .observation_started_day
            .get_or_insert_with(|| utc_day_from_ms(now));
    }
    if consent.status == "disabled" {
        state.pending_update_json = None;
    }
    write_state(&mut *connection, &mut state).await
}

/// Clears pending-delivery metadata without changing consent.
pub(crate) async fn clear_pending(
    pool: &SqlitePool,
    expected_epoch: i64,
) -> Result<Option<AnalyticsStateRow>, String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics clear transaction: {error}"))?;
    let Some(mut state) = read_state(&mut transaction).await? else {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics clear transaction: {error}"))?;
        return Ok(None);
    };
    if state.consent_epoch != expected_epoch {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics clear transaction: {error}"))?;
        return Ok(None);
    }
    state.pending_update_json = None;
    write_state(&mut transaction, &mut state).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics clear transaction: {error}"))?;
    Ok(Some(state))
}

/// Persists metadata that accompanies an event accepted by the in-memory queue.
pub(crate) async fn apply_delivery_metadata(
    pool: &SqlitePool,
    consent_epoch: i64,
    marks_first_success: bool,
    pending: &PendingUpdate,
) -> Result<MetadataOutcome, String> {
    if matches!(pending, PendingUpdate::Unchanged) && !marks_first_success {
        return Ok(MetadataOutcome::Applied);
    }
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics metadata transaction: {error}"))?;
    let Some(mut state) = read_state(&mut transaction).await? else {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics metadata: {error}"))?;
        return Ok(MetadataOutcome::Disabled);
    };
    if state.status != "enabled" {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics metadata: {error}"))?;
        return Ok(MetadataOutcome::Disabled);
    }
    if state.consent_epoch != consent_epoch {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics metadata: {error}"))?;
        return Ok(MetadataOutcome::StaleEpoch);
    }
    if let PendingUpdate::Confirm(expected) = pending {
        if state.pending_update_json.as_deref() != Some(expected.as_str()) {
            transaction
                .commit()
                .await
                .map_err(|error| format!("Failed to commit analytics metadata: {error}"))?;
            return Ok(MetadataOutcome::PendingChanged);
        }
    }
    if marks_first_success {
        state
            .first_success_day
            .get_or_insert_with(|| utc_day_from_ms(now_millis()));
    }
    match pending {
        PendingUpdate::Unchanged => {}
        PendingUpdate::Set(json) => state.pending_update_json = Some(json.clone()),
        PendingUpdate::Confirm(_) => state.pending_update_json = None,
    }
    write_state(&mut transaction, &mut state).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics metadata: {error}"))?;
    Ok(MetadataOutcome::Applied)
}

pub(crate) async fn clear_pending_update(pool: &SqlitePool, expected: &str) -> Result<(), String> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.map_err(|error| {
        format!("Failed to begin analytics pending-update transaction: {error}")
    })?;
    let Some(mut state) = read_state(&mut transaction).await? else {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics pending-update: {error}"))?;
        return Ok(());
    };
    if state.pending_update_json.as_deref() == Some(expected) {
        state.pending_update_json = None;
        write_state(&mut transaction, &mut state).await?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics pending-update: {error}"))
}

pub(crate) async fn observe_app_version(pool: &SqlitePool, version: &str) -> Result<(), String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics version transaction: {error}"))?;
    let Some(mut state) = read_state(&mut transaction).await? else {
        transaction
            .commit()
            .await
            .map_err(|error| format!("Failed to commit analytics version: {error}"))?;
        return Ok(());
    };
    state.last_observed_app_version = Some(version.to_string());
    write_state(&mut transaction, &mut state).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics version: {error}"))
}

/// Stores the deployment binding alongside consent. The event queue is empty
/// after a restart, so changing this key cannot leak old events through a new
/// endpoint.
pub(crate) async fn reconcile_deployment_key(
    pool: &SqlitePool,
    current: &str,
) -> Result<bool, String> {
    let Some(mut state) = load_state(pool).await? else {
        return Ok(false);
    };
    if state.deployment_key == current {
        return Ok(false);
    }
    state.deployment_key = current.to_string();
    let mut connection = pool
        .acquire()
        .await
        .map_err(|error| format!("Failed to acquire analytics state connection: {error}"))?;
    write_state(&mut connection, &mut state).await?;
    Ok(true)
}

#[cfg(test)]
pub(crate) async fn set_pending_update_for_tests(
    pool: &SqlitePool,
    pending: Option<&str>,
) -> Result<(), String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics test state transaction: {error}"))?;
    let mut state = read_state(&mut transaction)
        .await?
        .ok_or_else(|| "analytics_state_missing".to_string())?;
    state.pending_update_json = pending.map(str::to_string);
    write_state(&mut transaction, &mut state).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics test state: {error}"))
}

#[cfg(test)]
pub(crate) async fn set_status_for_tests(
    pool: &SqlitePool,
    status: &str,
    explicit: bool,
) -> Result<(), String> {
    let mut transaction = pool
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| format!("Failed to begin analytics test state transaction: {error}"))?;
    let mut state = read_state(&mut transaction)
        .await?
        .ok_or_else(|| "analytics_state_missing".to_string())?;
    state.status = status.to_string();
    state.consent_explicit = i64::from(explicit);
    write_state(&mut transaction, &mut state).await?;
    transaction
        .commit()
        .await
        .map_err(|error| format!("Failed to commit analytics test state: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::database::DatabaseRuntime;

    #[tokio::test]
    async fn user_gets_consent_state_in_the_existing_settings_table() {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        let state = ensure_state(runtime.pool(), 1, true).await.expect("state");
        assert_eq!(state.status, "enabled");
        assert!(state.installation_id.is_some());
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM settings WHERE key = 'analytics.state.v1'"
            )
            .fetch_one(runtime.pool())
            .await
            .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('analytics_state','analytics_outbox')"
            )
            .fetch_one(runtime.pool())
            .await
            .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn user_gets_a_stale_epoch_rejected_without_overwriting_consent() {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        let initial = ensure_state(runtime.pool(), 1, true).await.expect("state");
        assert!(
            set_enabled(runtime.pool(), false, initial.consent_epoch + 1, 1)
                .await
                .expect("set enabled")
                .is_none()
        );
        let reloaded = load_state(runtime.pool())
            .await
            .expect("load")
            .expect("state");
        assert_eq!(reloaded.status, initial.status);
        assert_eq!(reloaded.consent_epoch, initial.consent_epoch);
    }
}
