// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Consent, identity, enqueue and bounded sender orchestration.

use std::{
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde_json::Map as JsonMap;
use tokio::sync::{Mutex, Notify};

use crate::core::database::DatabaseRuntime;
use crate::core::product_config::product_config;

use super::events::{self, PROTOCOL_VERSION};
use super::store::{self, AnalyticsOutboxRow, AnalyticsStateRow, EnqueueOutcome, OutboxInsert};
use super::transport::{AnalyticsEventEnvelope, AnalyticsTransport, SendOutcome};
use super::{
    AnalyticsConsentStatus, AnalyticsState, AnalyticsSubmitResult, AnalyticsSubmitStatus,
    AnalyticsTrackRequest,
};

const POLICY_VERSION: i64 = 1;
const MIN_OCCURRED_AT_MS: i64 = 1_577_836_800_000;
const SEND_INTERVAL: Duration = Duration::from_secs(30);
const BACKOFF_BASE_MS: i64 = 1_000;
const BACKOFF_MAX_MS: i64 = 300_000;
const CONFIG_RETRY_MS: i64 = 300_000;

struct AnalyticsConfig {
    policy_version: i64,
    default_enabled: bool,
    transport: Option<AnalyticsTransport>,
}

#[derive(Default)]
struct Counters {
    accepted: AtomicU64,
    rejected: AtomicU64,
    send_failure: AtomicU64,
}

pub struct AnalyticsRuntime {
    inner: Arc<AnalyticsRuntimeInner>,
}

struct AnalyticsRuntimeInner {
    database: DatabaseRuntime,
    config: Option<AnalyticsConfig>,
    enabled: AtomicBool,
    consent_epoch: AtomicI64,
    transport_ready: bool,
    session_id: Mutex<Option<String>>,
    counters: Counters,
    notify: Notify,
    app_version: String,
    release_channel: String,
    os_family: String,
    architecture: String,
}

impl AnalyticsRuntime {
    /// Prepares the runtime from `product.json` and the stored consent row. It
    /// does not start the background sender; `spawn_sender` does that.
    pub async fn initialize(
        database: DatabaseRuntime,
        app_version: String,
    ) -> Result<Self, String> {
        let config = resolve_config();
        let release_channel = resolve_release_channel(&database).await;
        let (os_family, architecture) = platform();
        let transport_ready = config
            .as_ref()
            .map(|config| config.transport.is_some())
            .unwrap_or(false);

        let runtime = Self {
            inner: Arc::new(AnalyticsRuntimeInner {
                database,
                config,
                enabled: AtomicBool::new(false),
                consent_epoch: AtomicI64::new(0),
                transport_ready,
                session_id: Mutex::new(None),
                counters: Counters::default(),
                notify: Notify::new(),
                app_version,
                release_channel,
                os_family,
                architecture,
            }),
        };

        if let Some(config) = &runtime.inner.config {
            let row = store::ensure_state(
                runtime.inner.database.pool(),
                config.policy_version,
                config.default_enabled,
            )
            .await?;
            runtime.inner.apply_state(&row);
        }
        Ok(runtime)
    }

    pub fn spawn_sender(&self) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(SEND_INTERVAL);
            loop {
                tokio::select! {
                    _ = interval.tick() => {}
                    _ = runtime.inner.notify.notified() => {}
                }
                if let Err(error) = runtime.flush_once().await {
                    log::debug!(target: "analytics", "flush failed: {error}");
                }
            }
        });
    }

    pub async fn state(&self) -> Result<AnalyticsState, String> {
        self.inner.build_state().await
    }

    pub async fn set_enabled(
        &self,
        enabled: bool,
        expected_epoch: i64,
    ) -> Result<AnalyticsState, String> {
        let Some(config) = &self.inner.config else {
            return self.inner.build_state().await;
        };
        let updated = store::set_enabled(
            self.inner.database.pool(),
            enabled,
            expected_epoch,
            config.policy_version,
        )
        .await?;
        if let Some(row) = updated {
            self.inner.apply_state(&row);
            if enabled {
                self.inner.notify.notify_one();
            }
        }
        self.inner.build_state().await
    }

    pub async fn clear_pending(&self, expected_epoch: i64) -> Result<AnalyticsState, String> {
        if self.inner.config.is_none() {
            return self.inner.build_state().await;
        }
        let updated = store::clear_pending(self.inner.database.pool(), expected_epoch).await?;
        if let Some(row) = updated {
            self.inner.apply_state(&row);
        }
        self.inner.build_state().await
    }

    pub async fn flush(&self) -> Result<(), String> {
        self.flush_once().await
    }

    pub async fn track(&self, request: AnalyticsTrackRequest) -> AnalyticsSubmitResult {
        let Some(config) = &self.inner.config else {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "not_configured",
            );
        };

        if events::validate_event(&request.event_name, &request.attributes).is_err() {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Rejected,
                "invalid_attributes",
            );
        }
        if request.occurred_at_ms < MIN_OCCURRED_AT_MS {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Rejected,
                "invalid_timestamp",
            );
        }
        if !self.inner.enabled.load(Ordering::SeqCst) {
            return AnalyticsSubmitResult::new(AnalyticsSubmitStatus::Disabled);
        }

        let state = match store::load_state(self.inner.database.pool()).await {
            Ok(Some(state)) => state,
            Ok(None) => {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Unavailable,
                    "not_configured",
                );
            }
            Err(error) => {
                return AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Error, error)
            }
        };

        let session_id = self.inner.session_for(&request.event_name).await;
        let envelope = AnalyticsEventEnvelope {
            schema_version: events::SCHEMA_VERSION,
            event_id: uuid::Uuid::new_v4().to_string(),
            occurred_at_ms: request.occurred_at_ms,
            installation_id: state.installation_id.clone().unwrap_or_default(),
            analytics_session_id: session_id,
            event_name: request.event_name.clone(),
            app_version: self.inner.app_version.clone(),
            release_channel: self.inner.release_channel.clone(),
            os_family: self.inner.os_family.clone(),
            architecture: self.inner.architecture.clone(),
            attributes: request.attributes,
        };
        let payload_json = match serde_json::to_string(&envelope) {
            Ok(payload_json) => payload_json,
            Err(error) => {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Error,
                    error.to_string(),
                );
            }
        };

        let insert = OutboxInsert {
            event_id: envelope.event_id.clone(),
            consent_epoch: request.consent_epoch,
            schema_version: i64::from(PROTOCOL_VERSION),
            event_name: request.event_name.clone(),
            payload_json,
            priority: events::event_priority(&request.event_name),
            marks_first_success: marks_first_success(&request.event_name, &request.attributes),
        };

        match store::enqueue(self.inner.database.pool(), insert).await {
            Ok(EnqueueOutcome::Persisted) => {
                self.inner.notify.notify_one();
                AnalyticsSubmitResult {
                    status: AnalyticsSubmitStatus::Persisted,
                    event_id: Some(envelope.event_id),
                    reason: None,
                }
            }
            Ok(EnqueueOutcome::Disabled) => {
                AnalyticsSubmitResult::new(AnalyticsSubmitStatus::Disabled)
            }
            Ok(EnqueueOutcome::StaleEpoch) => {
                AnalyticsSubmitResult::new(AnalyticsSubmitStatus::StaleEpoch)
            }
            Ok(EnqueueOutcome::Unavailable) => {
                AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Unavailable, "queue_full")
            }
            Ok(EnqueueOutcome::Rejected) => AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Rejected,
                "payload_too_large",
            ),
            Err(error) => AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Error, error),
        }
    }

    async fn flush_once(&self) -> Result<(), String> {
        let Some(config) = &self.inner.config else {
            return Ok(());
        };
        let Some(transport) = &config.transport else {
            return Ok(());
        };
        if !self.inner.enabled.load(Ordering::SeqCst) {
            return Ok(());
        }

        let pool = self.inner.database.pool();
        let now = store::now_millis();
        let _ = store::purge_expired(pool, now).await;
        let batch = store::due_batch(pool, now).await?;

        for row in batch {
            // Consent can be withdrawn while a batch is in flight; re-check the
            // gate before each send so nothing leaves after a withdrawal.
            if !self.inner.enabled.load(Ordering::SeqCst) {
                break;
            }
            match self.send_row(transport, &row).await {
                SendOutcome::Accepted => {
                    store::delete_event(pool, &row.event_id).await?;
                    self.inner.counters.accepted.fetch_add(1, Ordering::Relaxed);
                }
                SendOutcome::PermanentRejection { reason } => {
                    store::delete_event(pool, &row.event_id).await?;
                    self.inner.counters.rejected.fetch_add(1, Ordering::Relaxed);
                    log::debug!(target: "analytics", "permanent rejection: {reason}");
                }
                SendOutcome::ConfigurationFailure { reason } => {
                    let next = store::now_millis() + CONFIG_RETRY_MS;
                    store::reschedule(pool, &row.event_id, next, row.attempt_count + 1).await?;
                    self.inner
                        .counters
                        .send_failure
                        .fetch_add(1, Ordering::Relaxed);
                    log::warn!(target: "analytics", "analytics send paused: {reason}");
                    break;
                }
                SendOutcome::RetryAfter { delay_ms } => {
                    let next = store::now_millis() + delay_ms;
                    store::reschedule(pool, &row.event_id, next, row.attempt_count + 1).await?;
                    self.inner
                        .counters
                        .send_failure
                        .fetch_add(1, Ordering::Relaxed);
                    break;
                }
                SendOutcome::Retry { reason } => {
                    let next = store::now_millis() + backoff_ms(row.attempt_count);
                    store::reschedule(pool, &row.event_id, next, row.attempt_count + 1).await?;
                    self.inner
                        .counters
                        .send_failure
                        .fetch_add(1, Ordering::Relaxed);
                    log::debug!(target: "analytics", "retry scheduled: {reason}");
                    break;
                }
            }
        }

        log::debug!(
            target: "analytics",
            "flush complete accepted={} rejected={} failure={}",
            self.inner.counters.accepted.load(Ordering::Relaxed),
            self.inner.counters.rejected.load(Ordering::Relaxed),
            self.inner.counters.send_failure.load(Ordering::Relaxed),
        );
        Ok(())
    }

    async fn send_row(
        &self,
        transport: &AnalyticsTransport,
        row: &AnalyticsOutboxRow,
    ) -> SendOutcome {
        let envelope: AnalyticsEventEnvelope = match serde_json::from_str(&row.payload_json) {
            Ok(envelope) => envelope,
            Err(error) => {
                return SendOutcome::PermanentRejection {
                    reason: format!("stored_payload_corrupt:{error}"),
                };
            }
        };
        transport.send(&envelope).await
    }
}

impl AnalyticsRuntimeInner {
    fn apply_state(&self, row: &AnalyticsStateRow) {
        self.enabled
            .store(row.status == "enabled", Ordering::SeqCst);
        self.consent_epoch
            .store(row.consent_epoch, Ordering::SeqCst);
    }

    async fn session_for(&self, event_name: &str) -> Option<String> {
        if event_name == "analytics.session_started" {
            let session_id = uuid::Uuid::new_v4().to_string();
            *self.session_id.lock().await = Some(session_id.clone());
            return Some(session_id);
        }
        self.session_id.lock().await.clone()
    }

    async fn build_state(&self) -> Result<AnalyticsState, String> {
        let (queue_depth, pending_bytes) = store::queue_stats(self.database.pool()).await?;
        let status = if self.config.is_none() {
            AnalyticsConsentStatus::Uninitialized
        } else {
            match store::load_state(self.database.pool()).await? {
                Some(row) => AnalyticsConsentStatus::from_db(&row.status),
                None => AnalyticsConsentStatus::Uninitialized,
            }
        };
        Ok(AnalyticsState {
            status,
            consent_epoch: self.consent_epoch.load(Ordering::SeqCst),
            queue_depth,
            pending_bytes,
            transport_ready: self.transport_ready,
        })
    }
}

impl Clone for AnalyticsRuntime {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

fn marks_first_success(event_name: &str, attributes: &JsonMap<String, serde_json::Value>) -> bool {
    event_name == "agent.request_completed"
        && attributes.get("result").and_then(serde_json::Value::as_str) == Some("success")
}

fn backoff_ms(attempt_count: i64) -> i64 {
    let exponent = attempt_count.clamp(0, 8) as u32;
    let base = BACKOFF_BASE_MS.saturating_mul(1_i64 << exponent);
    let capped = base.min(BACKOFF_MAX_MS);
    let jitter = (u128::from(uuid::Uuid::new_v4().as_u128()) % 1_000) as i64;
    (capped + jitter).min(BACKOFF_MAX_MS + 1_000)
}

fn resolve_config() -> Option<AnalyticsConfig> {
    let config = product_config().ok()?;
    let analytics = config.services.analytics.as_ref()?;
    if analytics.protocol_version != 1 {
        return None;
    }
    // Release eligibility is a build property; the deployment default only
    // participates in an eligible build. Nothing here is a persisted user choice.
    let default_enabled = !cfg!(debug_assertions) && analytics.default_enabled;
    let transport = if analytics.is_transport_ready() {
        analytics.send_url().ok().and_then(|send_url| {
            AnalyticsTransport::new(send_url, analytics.website_id.trim().to_string()).ok()
        })
    } else {
        None
    };
    Some(AnalyticsConfig {
        policy_version: POLICY_VERSION,
        default_enabled,
        transport,
    })
}

async fn resolve_release_channel(database: &DatabaseRuntime) -> String {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'app_update_channel'")
            .fetch_optional(database.pool())
            .await
            .ok()
            .flatten();
    match value.as_deref() {
        Some("beta") => "beta",
        Some("nightly") => "nightly",
        _ => "stable",
    }
    .to_string()
}

fn platform() -> (String, String) {
    let os_family = match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    };
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        _ => "other",
    };
    (os_family.to_string(), architecture.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_gets_jittered_bounded_backoff() {
        for attempt in 0..20 {
            let delay = backoff_ms(attempt);
            assert!(delay >= BACKOFF_BASE_MS, "attempt {attempt}: {delay}");
            assert!(
                delay <= BACKOFF_MAX_MS + 1_000,
                "attempt {attempt}: {delay}"
            );
        }
    }

    #[test]
    fn user_gets_only_the_success_terminal_marking_first_success() {
        let mut success = JsonMap::new();
        success.insert(
            "result".to_string(),
            serde_json::Value::String("success".into()),
        );
        let mut failure = JsonMap::new();
        failure.insert(
            "result".to_string(),
            serde_json::Value::String("failure".into()),
        );

        assert!(marks_first_success("agent.request_completed", &success));
        assert!(!marks_first_success("agent.request_completed", &failure));
        assert!(!marks_first_success("agent.request_submitted", &success));
    }

    #[test]
    fn user_gets_a_platform_mapped_to_the_public_enum() {
        let (os_family, architecture) = platform();
        assert!(["windows", "macos", "linux"].contains(&os_family.as_str()));
        assert!(["x86_64", "aarch64", "other"].contains(&architecture.as_str()));
    }
}
