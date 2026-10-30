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

use super::events;
use super::store::{self, AnalyticsOutboxRow, AnalyticsStateRow, EnqueueOutcome, OutboxInsert};
use super::transport::{AnalyticsEventEnvelope, AnalyticsTransport, EventSender, SendOutcome};
use super::{
    AnalyticsConsentStatus, AnalyticsState, AnalyticsSubmitResult, AnalyticsSubmitStatus,
    AnalyticsTrackRequest,
};

const POLICY_VERSION: i64 = 1;
const MIN_OCCURRED_AT_MS: i64 = 1_577_836_800_000;
const SEND_INTERVAL: Duration = Duration::from_secs(30);
/// Upper bound for a manual/background flush pass so a slow endpoint cannot hold
/// the sender for the whole batch worth of timeouts.
const FLUSH_BUDGET: Duration = Duration::from_secs(12);
const BACKOFF_BASE_MS: i64 = 1_000;
const BACKOFF_MAX_MS: i64 = 300_000;
const CONFIG_RETRY_MS: i64 = 300_000;
const FUTURE_OCCURRED_AT_TOLERANCE_MS: i64 = 86_400_000;

struct AnalyticsConfig {
    policy_version: i64,
    default_enabled: bool,
    transport: Option<Arc<dyn EventSender>>,
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
    /// Serializes the single sender: the background loop and a manual flush can
    /// never process the same rows at the same time.
    flush_lock: Mutex<()>,
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
                flush_lock: Mutex::new(()),
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
        match store::clear_pending(self.inner.database.pool(), expected_epoch).await? {
            Some(row) => {
                self.inner.apply_state(&row);
                self.inner.build_state().await
            }
            // The caller's consent view is stale. Report it instead of returning an
            // unchanged queue that the UI would report as a successful clear.
            None => Err("stale_consent_epoch".to_string()),
        }
    }

    pub async fn flush(&self) -> Result<(), String> {
        self.flush_once().await
    }

    pub async fn track(&self, request: AnalyticsTrackRequest) -> AnalyticsSubmitResult {
        if self.inner.config.is_none() {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "not_configured",
            );
        }
        // An unprovisioned or unreadable deployment fails closed: no event is
        // queued until the endpoint is ready. The stored consent decision is left
        // untouched, so real provisioning later is not silently suppressed.
        if !self.inner.transport_ready {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "analytics_not_provisioned",
            );
        }

        if events::validate_event(&request.event_name, &request.attributes).is_err() {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Rejected,
                "invalid_attributes",
            );
        }
        if request.occurred_at_ms < MIN_OCCURRED_AT_MS
            || request.occurred_at_ms > store::now_millis() + FUTURE_OCCURRED_AT_TOLERANCE_MS
        {
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
        // Read the success marker before `attributes` moves into the envelope so
        // the persisted payload and the outbox row agree.
        let marks_first_success = marks_first_success(&request.event_name, &request.attributes);
        let envelope = AnalyticsEventEnvelope {
            schema_version: events::SCHEMA_VERSION,
            event_id: uuid::Uuid::new_v4().to_string(),
            occurred_at_ms: request.occurred_at_ms,
            client_sent_at_ms: store::now_millis(),
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
            schema_version: i64::from(events::SCHEMA_VERSION),
            event_name: request.event_name.clone(),
            payload_json,
            priority: events::event_priority(&request.event_name),
            marks_first_success,
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
        // Single sender: the background loop and a manual flush take this lock so
        // the same row is never sent twice and attempt counts do not double-count.
        let _guard = self.inner.flush_lock.lock().await;
        let started = std::time::Instant::now();
        let batch = store::due_batch(pool, now).await?;

        for row in batch {
            if started.elapsed() >= FLUSH_BUDGET {
                break;
            }
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
        transport: &Arc<dyn EventSender>,
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
    let transport: Option<Arc<dyn EventSender>> = if analytics.is_transport_ready() {
        analytics
            .send_url()
            .ok()
            .and_then(|send_url| {
                AnalyticsTransport::new(send_url, analytics.website_id.trim().to_string()).ok()
            })
            .map(|transport| Arc::new(transport) as Arc<dyn EventSender>)
    } else {
        None
    };
    // The derived default only turns collection on once this build can actually
    // deliver. It is a non-explicit value, so real provisioning re-derives it
    // later without overwriting an explicit user choice, and a community build
    // never queues events that a later official build would flush.
    let default_enabled =
        !cfg!(debug_assertions) && analytics.default_enabled && transport.is_some();
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
impl AnalyticsRuntime {
    /// Test constructor with an injected sender so the sender loop can be
    /// exercised without network. `None` models an unprovisioned deployment.
    async fn initialize_with_sender_for_tests(
        database: DatabaseRuntime,
        sender: Option<Arc<dyn EventSender>>,
        default_enabled: bool,
    ) -> Result<Self, String> {
        let config = AnalyticsConfig {
            policy_version: POLICY_VERSION,
            default_enabled,
            transport: sender,
        };
        let runtime = Self {
            inner: Arc::new(AnalyticsRuntimeInner {
                database,
                transport_ready: config.transport.is_some(),
                config: Some(config),
                enabled: AtomicBool::new(false),
                consent_epoch: AtomicI64::new(0),
                session_id: Mutex::new(None),
                flush_lock: Mutex::new(()),
                counters: Counters::default(),
                notify: Notify::new(),
                app_version: "1.0.0-test".to_string(),
                release_channel: "stable".to_string(),
                os_family: "linux".to_string(),
                architecture: "x86_64".to_string(),
            }),
        };
        let row = store::ensure_state(
            runtime.inner.database.pool(),
            POLICY_VERSION,
            default_enabled,
        )
        .await?;
        runtime.inner.apply_state(&row);
        Ok(runtime)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, pin::Pin, sync::atomic::AtomicI64};

    async fn test_database() -> (tempfile::TempDir, DatabaseRuntime) {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        (root, runtime)
    }

    fn outbox_insert(event_id: &str) -> OutboxInsert {
        // A real, decodable persisted envelope: the sender parses `payload_json`
        // back into an envelope, so a placeholder body would look like a poison
        // row and be dropped before any transport call.
        let now = store::now_millis();
        let envelope = AnalyticsEventEnvelope {
            schema_version: 1,
            event_id: event_id.to_string(),
            occurred_at_ms: now,
            client_sent_at_ms: now,
            installation_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_string(),
            analytics_session_id: None,
            event_name: "app.started".to_string(),
            app_version: "1.0.0-test".to_string(),
            release_channel: "stable".to_string(),
            os_family: "linux".to_string(),
            architecture: "x86_64".to_string(),
            attributes: JsonMap::new(),
        };
        OutboxInsert {
            event_id: event_id.to_string(),
            consent_epoch: 0,
            schema_version: 1,
            event_name: "app.started".to_string(),
            payload_json: serde_json::to_string(&envelope).expect("encode envelope"),
            priority: 100,
            marks_first_success: false,
        }
    }

    fn poison_insert(event_id: &str) -> OutboxInsert {
        OutboxInsert {
            event_id: event_id.to_string(),
            consent_epoch: 0,
            schema_version: 1,
            event_name: "app.started".to_string(),
            payload_json: r#"{"not":"an envelope"}"#.to_string(),
            priority: 100,
            marks_first_success: false,
        }
    }

    struct Probe {
        active: AtomicI64,
        max_active: AtomicI64,
        sends: AtomicI64,
        hold: Duration,
        make: Box<dyn Fn() -> SendOutcome + Send + Sync>,
    }

    impl Probe {
        fn new(make: impl Fn() -> SendOutcome + Send + Sync + 'static) -> Self {
            Self {
                active: AtomicI64::new(0),
                max_active: AtomicI64::new(0),
                sends: AtomicI64::new(0),
                hold: Duration::from_millis(30),
                make: Box::new(make),
            }
        }
    }

    impl EventSender for Probe {
        fn send<'a>(
            &'a self,
            _envelope: &'a AnalyticsEventEnvelope,
        ) -> Pin<Box<dyn Future<Output = SendOutcome> + Send + 'a>> {
            Box::pin(async move {
                let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
                self.max_active.fetch_max(active, Ordering::SeqCst);
                tokio::time::sleep(self.hold).await;
                self.active.fetch_sub(1, Ordering::SeqCst);
                self.sends.fetch_add(1, Ordering::SeqCst);
                (self.make)()
            })
        }
    }

    #[tokio::test]
    async fn user_does_not_send_the_same_rows_twice_when_a_manual_flush_overlaps_the_sender() {
        let (_root, database) = test_database().await;
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let runtime =
            AnalyticsRuntime::initialize_with_sender_for_tests(database, Some(probe.clone()), true)
                .await
                .expect("runtime");

        for index in 0..4 {
            store::enqueue(
                runtime.inner.database.pool(),
                outbox_insert(&format!("e{index}")),
            )
            .await
            .expect("enqueue");
        }

        let (first, second) = tokio::join!(runtime.flush_once(), runtime.flush_once());
        first.expect("first flush");
        second.expect("second flush");

        assert_eq!(probe.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(probe.sends.load(Ordering::SeqCst), 4);
        assert_eq!(
            store::queue_stats(runtime.inner.database.pool())
                .await
                .expect("stats")
                .0,
            0
        );
    }

    #[tokio::test]
    async fn user_gets_a_delivered_event_removed_and_never_resent() {
        let (_root, database) = test_database().await;
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let runtime =
            AnalyticsRuntime::initialize_with_sender_for_tests(database, Some(probe.clone()), true)
                .await
                .expect("runtime");
        store::enqueue(runtime.inner.database.pool(), outbox_insert("e1"))
            .await
            .expect("enqueue");

        runtime.flush_once().await.expect("flush");
        assert_eq!(
            store::queue_stats(runtime.inner.database.pool())
                .await
                .expect("stats")
                .0,
            0
        );

        runtime.flush_once().await.expect("flush again");
        assert_eq!(probe.sends.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn user_keeps_an_event_when_the_sender_reports_a_configuration_fault() {
        let (_root, database) = test_database().await;
        let probe = Arc::new(Probe::new(|| SendOutcome::ConfigurationFailure {
            reason: "bot_rejected".to_string(),
        }));
        let runtime =
            AnalyticsRuntime::initialize_with_sender_for_tests(database, Some(probe.clone()), true)
                .await
                .expect("runtime");
        store::enqueue(runtime.inner.database.pool(), outbox_insert("e1"))
            .await
            .expect("enqueue");

        runtime.flush_once().await.expect("flush");

        assert_eq!(
            store::queue_stats(runtime.inner.database.pool())
                .await
                .expect("stats")
                .0,
            1,
            "a bot rejection must not discard the event"
        );
    }

    #[tokio::test]
    async fn user_gets_a_poison_row_dropped_without_a_transport_call() {
        let (_root, database) = test_database().await;
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let runtime =
            AnalyticsRuntime::initialize_with_sender_for_tests(database, Some(probe.clone()), true)
                .await
                .expect("runtime");
        store::enqueue(runtime.inner.database.pool(), poison_insert("poison"))
            .await
            .expect("enqueue");

        runtime.flush_once().await.expect("flush");

        // A payload that cannot be decoded is deleted as a permanent rejection and
        // never reaches the transport.
        assert_eq!(probe.sends.load(Ordering::SeqCst), 0);
        assert_eq!(
            store::queue_stats(runtime.inner.database.pool())
                .await
                .expect("stats")
                .0,
            0
        );
    }

    #[tokio::test]
    async fn user_gets_no_collection_until_the_deployment_is_provisioned() {
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_for_tests(database, None, false)
            .await
            .expect("runtime");

        let result = runtime
            .track(AnalyticsTrackRequest {
                event_name: "app.started".to_string(),
                occurred_at_ms: store::now_millis(),
                consent_epoch: 0,
                attributes: JsonMap::from_iter([
                    (
                        "run_id".to_string(),
                        serde_json::Value::String(
                            "92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09".to_string(),
                        ),
                    ),
                    (
                        "startup_source".to_string(),
                        serde_json::Value::String("foreground".to_string()),
                    ),
                ]),
            })
            .await;

        assert_eq!(result.status, AnalyticsSubmitStatus::Unavailable);
        assert_eq!(result.reason.as_deref(), Some("analytics_not_provisioned"));
        assert_eq!(
            store::queue_stats(runtime.inner.database.pool())
                .await
                .expect("stats")
                .0,
            0
        );
    }

    #[tokio::test]
    async fn user_gets_an_explicit_stale_result_when_clearing_with_an_outdated_epoch() {
        let (_root, database) = test_database().await;
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let runtime =
            AnalyticsRuntime::initialize_with_sender_for_tests(database, Some(probe), true)
                .await
                .expect("runtime");

        let error = runtime
            .clear_pending(99)
            .await
            .expect_err("a stale epoch must not report a successful clear");
        assert_eq!(error, "stale_consent_epoch");
    }

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
