// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Consent, identity, native session, operation context, bounded single-writer
//! ingress and the bounded sender orchestration.
//!
//! The WebView submits typed metadata only. The native runtime owns the process
//! run identity, the startup classification, the analytics session, the consent
//! epoch and the outbox. Every write goes through one admission gate and one
//! writer so the shared `touchai.db` pool never sees a burst of competing
//! analytics transactions.

use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{Duration, Instant},
};

use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio::sync::{Mutex, Notify};

use crate::core::database::DatabaseRuntime;
use crate::core::product_config::product_config;

use super::events;
use super::store::{
    self, AnalyticsOutboxRow, AnalyticsStateRow, EnqueueOutcome, OutboxInsert, PendingUpdate,
};
use super::transport::{AnalyticsEventEnvelope, AnalyticsTransport, EventSender, SendOutcome};
use super::{
    AnalyticsConsentStatus, AnalyticsLifecycleContext, AnalyticsOperationHandle,
    AnalyticsStartupKind, AnalyticsState, AnalyticsSubmitResult, AnalyticsSubmitStatus,
    AnalyticsTrackRequest,
};

const POLICY_VERSION: i64 = 1;
const MIN_OCCURRED_AT_MS: i64 = 1_577_836_800_000;
const SEND_INTERVAL: Duration = Duration::from_secs(30);
/// Upper bound for the loop before each send in one flush pass. A pass can still
/// overrun by at most one in-flight send (`TOTAL_TIMEOUT`, 10s) because the budget
/// is checked between sends, not inside one.
const FLUSH_BUDGET: Duration = Duration::from_secs(12);
const BACKOFF_BASE_MS: i64 = 1_000;
const BACKOFF_MAX_MS: i64 = 300_000;
const CONFIG_RETRY_MS: i64 = 300_000;
const FUTURE_OCCURRED_AT_TOLERANCE_MS: i64 = 86_400_000;
const MAX_HEALTH_COUNT: u64 = 1_000_000;
const MAX_DURATION_MS: i64 = 86_400_000;
const HEALTH_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// A session ends after 30 minutes without a user interaction. Idleness is
/// measured on the native monotonic clock, never on a caller timestamp.
const SESSION_IDLE: Duration = Duration::from_secs(30 * 60);
/// Upper bound for the bounded pending-update metadata blob.
const PENDING_UPDATE_MAX_BYTES: usize = 512;
/// Bounded in-memory ingress admission. It counts rows, including work reserved
/// but not yet committed, so a burst cannot outrun the single writer.
const INGRESS_MAX_ENTRIES: i64 = 128;
const INGRESS_MAX_BYTES: i64 = 256 * 1024;
/// Bounded native operation registry. Handles expire and the map is capped so a
/// long-lived process cannot grow it without limit.
const OPERATION_TTL: Duration = Duration::from_secs(2 * 60 * 60);
const OPERATION_MAX: usize = 256;
/// Bounded feature-exposure dedup set; cleared whenever the session changes.
const EXPOSURE_MAX: usize = 4_096;

/// A native-owned analytics session. The WebView never supplies this id.
struct NativeSession {
    id: String,
    last_activity: Instant,
}

/// One foreground activation. The cold activation starts at process start; a
/// genuine foreground reactivation gets a new native id and monotonic start.
struct StartupActivation {
    id: String,
    kind: AnalyticsStartupKind,
    source: String,
    started_at: Instant,
    foreground: bool,
    completed: bool,
}

#[derive(Debug, Clone)]
struct StartupCompletion {
    id: String,
    kind: AnalyticsStartupKind,
    source: String,
    duration_ms: i64,
}

impl StartupActivation {
    fn completion(&self) -> StartupCompletion {
        StartupCompletion {
            id: self.id.clone(),
            kind: self.kind,
            source: self.source.clone(),
            duration_ms: elapsed_ms(self.started_at),
        }
    }
}

/// A native-issued operation handle captured at request start. It binds the
/// immutable original session and consent epoch so a completion that arrives
/// after another window opened a later session is never re-tagged.
struct OperationRecord {
    session_id: Option<String>,
    consent_epoch: i64,
    created: Instant,
}

#[derive(Default)]
struct OperationRegistry {
    records: HashMap<String, OperationRecord>,
    order: VecDeque<String>,
}

impl OperationRegistry {
    fn begin(&mut self, session_id: Option<String>, consent_epoch: i64) -> String {
        self.prune();
        let id = uuid::Uuid::new_v4().to_string();
        self.records.insert(
            id.clone(),
            OperationRecord {
                session_id,
                consent_epoch,
                created: Instant::now(),
            },
        );
        self.order.push_back(id.clone());
        while self.order.len() > OPERATION_MAX {
            if let Some(oldest) = self.order.pop_front() {
                self.records.remove(&oldest);
            }
        }
        id
    }

    fn get(&self, id: &str) -> Option<(Option<String>, i64)> {
        self.records
            .get(id)
            .map(|record| (record.session_id.clone(), record.consent_epoch))
    }

    fn set_session(&mut self, id: &str, session_id: String) {
        if let Some(record) = self.records.get_mut(id) {
            record.session_id = Some(session_id);
        }
    }

    fn remove(&mut self, id: &str) {
        self.records.remove(id);
    }

    fn clear(&mut self) {
        self.records.clear();
        self.order.clear();
    }

    fn prune(&mut self) {
        let Some(cutoff) = Instant::now().checked_sub(OPERATION_TTL) else {
            return;
        };
        self.records.retain(|_, record| record.created >= cutoff);
        let records = &self.records;
        self.order.retain(|id| records.contains_key(id));
    }
}

#[derive(Default)]
struct Admission {
    entries: i64,
    bytes: i64,
}

/// The admission gate. Counters live behind a synchronous mutex so the guard can
/// release them from `Drop` without an await, which keeps a cancelled caller
/// from leaking capacity.
#[derive(Default)]
struct Ingress {
    admission: StdMutex<Admission>,
}

struct IngressGuard {
    ingress: Arc<Ingress>,
    entries: i64,
    bytes: i64,
}

impl Drop for IngressGuard {
    fn drop(&mut self) {
        let mut admission = self
            .ingress
            .admission
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        admission.entries = (admission.entries - self.entries).max(0);
        admission.bytes = (admission.bytes - self.bytes).max(0);
    }
}

impl Ingress {
    /// Reserves `entries` rows and `bytes` for the caller. Returns `None` when
    /// the entry or byte budget is exhausted, so the caller fails fast instead of
    /// growing a waiting queue. The reservation is released when the guard drops,
    /// including on cancellation.
    fn try_admit(self: &Arc<Self>, entries: i64, bytes: i64) -> Option<IngressGuard> {
        let mut admission = self
            .admission
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if admission.entries + entries > INGRESS_MAX_ENTRIES
            || admission.bytes + bytes > INGRESS_MAX_BYTES
        {
            return None;
        }
        admission.entries += entries;
        admission.bytes += bytes;
        Some(IngressGuard {
            ingress: Arc::clone(self),
            entries,
            bytes,
        })
    }
}

struct AnalyticsConfig {
    policy_version: i64,
    default_enabled: bool,
    transport: Option<Arc<dyn EventSender>>,
    /// The endpoint + project id this build delivers to. It binds the outbox to
    /// one deployment so rows produced for a different endpoint are never sent
    /// through this one.
    deployment_key: String,
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
    session: Mutex<Option<NativeSession>>,
    operations: Mutex<OperationRegistry>,
    exposures: Mutex<HashSet<String>>,
    ingress: Arc<Ingress>,
    /// Serializes the durable writer: only one analytics write transaction runs
    /// at a time, so a burst cannot turn into many competing SQLite writes.
    write_lock: Mutex<()>,
    /// Process-wide run identity. Native-owned; the WebView reads it and never
    /// invents a process start.
    run_id: String,
    startup_source: String,
    activation: StdMutex<StartupActivation>,
    app_started_emitted: AtomicBool,
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
    /// Prepares the runtime from `product.json`, the native process facts and the
    /// stored consent row. It does not start the background sender; `spawn_sender`
    /// does that. `started_at` is the true native process-start instant and
    /// `startup_source` is the trusted classification, both set once by native
    /// setup before any event is emitted.
    pub async fn initialize(
        database: DatabaseRuntime,
        app_version: String,
        startup_source: String,
        started_at: Instant,
    ) -> Result<Self, String> {
        let config = resolve_config();
        let release_channel = resolve_release_channel(&database).await;
        let (os_family, architecture) = platform();
        let transport_ready = config
            .as_ref()
            .map(|config| config.transport.is_some())
            .unwrap_or(false);
        let run_id = uuid::Uuid::new_v4().to_string();
        let startup_source = normalize_startup_source(&startup_source);

        let app_version_for_pending = app_version.clone();
        let runtime = Self {
            inner: Arc::new(AnalyticsRuntimeInner {
                database,
                config,
                enabled: AtomicBool::new(false),
                consent_epoch: AtomicI64::new(0),
                transport_ready,
                session: Mutex::new(None),
                operations: Mutex::new(OperationRegistry::default()),
                exposures: Mutex::new(HashSet::new()),
                ingress: Arc::new(Ingress::default()),
                write_lock: Mutex::new(()),
                run_id: run_id.clone(),
                startup_source: startup_source.clone(),
                activation: StdMutex::new(StartupActivation {
                    id: run_id,
                    kind: AnalyticsStartupKind::Cold,
                    source: startup_source.clone(),
                    started_at,
                    foreground: startup_source == "foreground",
                    completed: false,
                }),
                app_started_emitted: AtomicBool::new(false),
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
            // Drop any queued rows that belong to a different deployment before
            // this build can send them. Best-effort: a failure leaves collection
            // disabled rather than blocking startup.
            if let Err(error) = store::reconcile_deployment_key(
                runtime.inner.database.pool(),
                &config.deployment_key,
            )
            .await
            {
                log::debug!(target: "analytics", "deployment reconcile failed: {error}");
            }
            runtime.inner.apply_state(&row);
            // Confirm a real restart after an install handoff, or discard stale
            // pending metadata, before any new session can start.
            if let Err(error) = runtime
                .inner
                .resolve_restart_confirmation(&row, &app_version_for_pending)
                .await
            {
                log::debug!(target: "analytics", "pending update resolution failed: {error}");
            }
            let _ =
                store::observe_app_version(runtime.inner.database.pool(), &app_version_for_pending)
                    .await;
            if row.status == "enabled" && runtime.inner.transport_ready {
                if let Err(error) = runtime.inner.emit_app_started(&row).await {
                    log::debug!(target: "analytics", "native app.started emission failed: {error}");
                }
            }
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

    /// Starts the bounded hourly health reporter. The first report is one full
    /// interval after startup; missed ticks are skipped rather than replayed.
    pub fn spawn_health_reporter(&self) {
        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            let start = tokio::time::Instant::now() + HEALTH_INTERVAL;
            let mut interval = tokio::time::interval_at(start, HEALTH_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if let Err(error) = runtime.inner.emit_health_once().await {
                    log::debug!(target: "analytics", "health report failed: {error}");
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
            } else {
                // Withdrawing consent also drops the in-memory session, the
                // operation handles and the exposure set so nothing captured
                // under the old epoch can leak into the new one.
                self.inner.clear_session().await;
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

    /// A manual flush that coalesces with an in-flight pass instead of queueing a
    /// second one. Returns `Ok` immediately when another pass already owns the
    /// sender.
    pub async fn flush(&self) -> Result<(), String> {
        let _guard = match self.inner.flush_lock.try_lock() {
            Ok(guard) => guard,
            Err(_) => return Ok(()),
        };
        self.flush_impl().await
    }

    /// Native-owned process identity and current activation facts. `elapsed_ms`
    /// is measured on the native monotonic clock from the activation start, so
    /// the WebView never subtracts a foreign clock or invents a startup source.
    pub async fn lifecycle_context(&self) -> AnalyticsLifecycleContext {
        let activation = self
            .inner
            .activation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        AnalyticsLifecycleContext {
            run_id: self.inner.run_id.clone(),
            startup_id: activation.id.clone(),
            startup_kind: activation.kind,
            startup_source: activation.source.clone(),
            elapsed_ms: elapsed_ms(activation.started_at),
        }
    }

    /// Starts a new native activation when a real foreground entry actually
    /// brings the surface back. A pending cold foreground activation is kept.
    pub fn begin_foreground_activation(&self) {
        self.inner.begin_foreground_activation();
    }

    /// Completes the current activation once the foreground entry really reached
    /// the user. It never starts or refreshes an analytics session, and an
    /// activation that was not a foreground start emits nothing.
    pub async fn complete_foreground_activation(&self) {
        let result = self.complete_startup_activation().await;
        if result.status == AnalyticsSubmitStatus::Error {
            log::debug!(
                target: "analytics",
                "startup completion failed: {}",
                result.reason.unwrap_or_default()
            );
        }
    }

    /// Issues an opaque operation handle. Native binds the current session (if
    /// any) and the current consent epoch; the caller only passes the handle back
    /// on later events, so the WebView never supplies a session id.
    pub async fn begin_operation(&self) -> AnalyticsOperationHandle {
        let session_id = self
            .inner
            .session
            .lock()
            .await
            .as_ref()
            .map(|session| session.id.clone());
        let enabled = self.inner.enabled.load(Ordering::SeqCst);
        let consent_epoch = self.inner.consent_epoch.load(Ordering::SeqCst);
        let operation_id = self
            .inner
            .operations
            .lock()
            .await
            .begin(session_id, consent_epoch);
        AnalyticsOperationHandle {
            operation_id,
            enabled,
            consent_epoch,
        }
    }

    pub async fn complete_operation(&self, operation_id: &str) {
        self.inner.operations.lock().await.remove(operation_id);
    }

    pub async fn track(&self, request: AnalyticsTrackRequest) -> AnalyticsSubmitResult {
        // Native-owned lifecycle events cannot be authored by the WebView. The
        // health report is also native-only so caller-submitted values can never
        // inflate the counters they describe.
        if matches!(
            request.event_name.as_str(),
            "app.started" | "analytics.health_reported"
        ) {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Rejected,
                "native_event_owned",
            );
        }
        // A WebView may signal that startup is complete, but native replaces
        // every authoritative field with the current activation context.
        if request.event_name == "app.startup_completed" {
            return self.complete_startup_activation().await;
        }
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

        // The native runtime owns the process session. A frontend-submitted session
        // start is not trusted and is reported as a duplicate of the native
        // lifecycle event rather than stored.
        if request.event_name == "analytics.session_started" {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Deduplicated,
                "native_session_owned",
            );
        }

        // Resolve the consent epoch and any session already bound to the handle.
        let (operation, captured_session, epoch) = match request.operation_id.as_deref() {
            Some(id) => match self.inner.operations.lock().await.get(id) {
                Some((session_id, epoch)) => (Some(id.to_string()), session_id, epoch),
                None => (None, None, self.inner.consent_epoch.load(Ordering::SeqCst)),
            },
            None => (None, None, self.inner.consent_epoch.load(Ordering::SeqCst)),
        };

        let is_interaction = is_user_interaction(&request.event_name, &request.attributes);
        let (session_id, started_session) = match captured_session {
            // Immutable original session: never rebound to a later one.
            Some(session_id) => (Some(session_id), false),
            None => self.inner.resolve_session(is_interaction).await,
        };
        // A freshly started session is provisional until its `session_started`
        // row and the triggering event commit together below. Exposures are only
        // reset and the operation handle only bound once that batch persists.

        // Render-only feature exposure is deduplicated per session and feature,
        // and the key is recorded only after the row actually persists.
        let exposure_key = if request.event_name == "product.feature_exposed" {
            request
                .attributes
                .get("feature")
                .and_then(JsonValue::as_str)
                .map(|feature| format!("{}\u{0}{}", session_id.as_deref().unwrap_or("-"), feature))
        } else {
            None
        };
        if let Some(key) = &exposure_key {
            if self.inner.exposures.lock().await.contains(key) {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Deduplicated,
                    "feature_already_exposed",
                );
            }
        }

        let marks_first_success = marks_first_success(&request.event_name, &request.attributes);
        let mut inserts = Vec::with_capacity(2);
        if started_session {
            if let Some(session_id) = &session_id {
                match self.inner.build_session_started_insert(
                    &state,
                    session_id,
                    epoch,
                    request.occurred_at_ms,
                ) {
                    Ok(insert) => inserts.push(insert),
                    Err(error) => {
                        return AnalyticsSubmitResult::with_reason(
                            AnalyticsSubmitStatus::Error,
                            error,
                        );
                    }
                }
            }
        }
        match self.inner.build_event_insert(
            &state,
            session_id.clone(),
            epoch,
            &request,
            marks_first_success,
        ) {
            Ok(insert) => inserts.push(insert),
            Err(error) => {
                return AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Error, error);
            }
        }

        let pending = install_handoff_pending(&request, epoch)
            .map(PendingUpdate::Set)
            .unwrap_or(PendingUpdate::Unchanged);
        let primary_event_id = inserts.last().map(|insert| insert.event_id.clone());
        let result = self
            .inner
            .commit_inserts(inserts, pending, primary_event_id)
            .await;

        if result.status == AnalyticsSubmitStatus::Persisted {
            // The session is real now: reset the per-session exposures and bind
            // the operation handle to the immutable session that just committed.
            if started_session {
                self.inner.exposures.lock().await.clear();
                if let (Some(operation), Some(session_id)) = (&operation, &session_id) {
                    self.inner
                        .operations
                        .lock()
                        .await
                        .set_session(operation, session_id.clone());
                }
            }
            // The exposure key is recorded only after the row actually persisted.
            if let Some(key) = exposure_key {
                let mut exposures = self.inner.exposures.lock().await;
                if exposures.len() >= EXPOSURE_MAX {
                    // Bounded: drop the whole set rather than grow without limit.
                    exposures.clear();
                }
                exposures.insert(key);
            }
        } else if started_session {
            // The batch did not commit, so drop the provisional session: no later
            // event may reference a session with no stored `session_started` row.
            if let Some(session_id) = &session_id {
                self.inner.release_session_if(session_id).await;
            }
        }
        result
    }

    /// Emits one native-owned startup completion for the current activation.
    /// The activation is consumed before the write so concurrent focus/track
    /// callers cannot persist two rows for the same activation.
    async fn complete_startup_activation(&self) -> AnalyticsSubmitResult {
        let completion = {
            let mut activation = self
                .inner
                .activation
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if activation.completed {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Deduplicated,
                    "startup_already_completed",
                );
            }
            if !activation.foreground {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Deduplicated,
                    "startup_not_foreground",
                );
            }
            activation.completed = true;
            activation.completion()
        };

        if self.inner.config.is_none() {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "not_configured",
            );
        }
        if !self.inner.transport_ready {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "analytics_not_provisioned",
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
                )
            }
            Err(error) => {
                return AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Error, error)
            }
        };
        let attributes = JsonMap::from_iter([
            ("startup_id".to_string(), JsonValue::String(completion.id)),
            (
                "startup_kind".to_string(),
                JsonValue::String(completion.kind.as_str().to_string()),
            ),
            (
                "startup_source".to_string(),
                JsonValue::String(completion.source),
            ),
            (
                "duration_ms".to_string(),
                JsonValue::Number(completion.duration_ms.into()),
            ),
        ]);
        self.inner
            .persist_native_event(&state, "app.startup_completed", attributes)
            .await
    }

    async fn flush_once(&self) -> Result<(), String> {
        let _guard = self.inner.flush_lock.lock().await;
        self.flush_impl().await
    }

    async fn flush_impl(&self) -> Result<(), String> {
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
        let started = Instant::now();
        let batch = store::due_batch(pool, now).await?;

        for row in batch {
            if started.elapsed() >= FLUSH_BUDGET {
                break;
            }
            // Consent can be withdrawn while a batch is in flight; re-check the
            // gate before each send so no new send starts after a withdrawal. An
            // already in-flight HTTP request cannot be cancelled locally, so a
            // remote commit during the opt-out window is possible and is not
            // treated as a client failure.
            if !self.inner.enabled.load(Ordering::SeqCst) {
                break;
            }
            match self.send_row(transport, &row).await {
                SendOutcome::Accepted => {
                    store::delete_event(pool, &row.event_id).await?;
                    // Health reports describe the product-event counters. Counting
                    // their own delivery would make those counters self-referential.
                    if row.event_name != "analytics.health_reported" {
                        self.inner.counters.accepted.fetch_add(1, Ordering::Relaxed);
                    }
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
    /// Commits a group through the bounded ingress and the single durable writer.
    /// `primary_event_id` is the id of the row the caller submitted, so a persisted
    /// result still carries the stable id it was promised.
    async fn commit_inserts(
        &self,
        inserts: Vec<OutboxInsert>,
        pending: PendingUpdate,
        primary_event_id: Option<String>,
    ) -> AnalyticsSubmitResult {
        let total_bytes: i64 = inserts
            .iter()
            .map(|insert| insert.payload_json.len() as i64)
            .sum();
        let _admission = match self.ingress.try_admit(inserts.len() as i64, total_bytes) {
            Some(admission) => admission,
            None => {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Unavailable,
                    "ingress_full",
                )
            }
        };
        let _writer = self.write_lock.lock().await;
        match store::enqueue_batch(self.database.pool(), inserts, pending).await {
            Ok(EnqueueOutcome::Persisted) => {
                self.notify.notify_one();
                AnalyticsSubmitResult {
                    status: AnalyticsSubmitStatus::Persisted,
                    event_id: primary_event_id,
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

    /// Persists a passive native event with no caller-derived session or
    /// timestamp. Used for process lifecycle and health facts.
    async fn persist_native_event(
        &self,
        state: &AnalyticsStateRow,
        event_name: &str,
        attributes: JsonMap<String, JsonValue>,
    ) -> AnalyticsSubmitResult {
        if let Err(error) = events::validate_event(event_name, &attributes) {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Error,
                format!("native_event_invalid:{error}"),
            );
        }
        let request = AnalyticsTrackRequest {
            event_name: event_name.to_string(),
            occurred_at_ms: store::now_millis(),
            operation_id: None,
            attributes,
        };
        let insert =
            match self.build_event_insert(state, None, state.consent_epoch, &request, false) {
                Ok(insert) => insert,
                Err(error) => {
                    return AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Error, error)
                }
            };
        let event_id = Some(insert.event_id.clone());
        self.commit_inserts(vec![insert], PendingUpdate::Unchanged, event_id)
            .await
    }

    /// Emits `app.started` at most once for this process, and only when the
    /// stored state is enabled and the deployment was deliverable at init.
    async fn emit_app_started(&self, state: &AnalyticsStateRow) -> Result<(), String> {
        if state.status != "enabled" || !self.transport_ready {
            return Ok(());
        }
        if self.app_started_emitted.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let attributes = JsonMap::from_iter([
            ("run_id".to_string(), JsonValue::String(self.run_id.clone())),
            (
                "startup_source".to_string(),
                JsonValue::String(self.startup_source.clone()),
            ),
        ]);
        let result = self
            .persist_native_event(state, "app.started", attributes)
            .await;
        if result.status == AnalyticsSubmitStatus::Persisted {
            Ok(())
        } else {
            Err(result
                .reason
                .unwrap_or_else(|| format!("app_started_{:?}", result.status)))
        }
    }

    /// Emits one passive health report from real native counters and queue
    /// depth. It never starts/refreshes a session and does not run while the
    /// user has disabled analytics.
    async fn emit_health_once(&self) -> Result<(), String> {
        if self.config.is_none() || !self.transport_ready || !self.enabled.load(Ordering::SeqCst) {
            return Ok(());
        }
        let state = store::load_state(self.database.pool())
            .await?
            .ok_or_else(|| "analytics_state_missing".to_string())?;
        if state.status != "enabled" {
            return Ok(());
        }
        let (queue_depth, _) = store::queue_stats(self.database.pool()).await?;
        let accepted = self
            .counters
            .accepted
            .load(Ordering::Relaxed)
            .min(MAX_HEALTH_COUNT);
        let rejected = self
            .counters
            .rejected
            .load(Ordering::Relaxed)
            .min(MAX_HEALTH_COUNT);
        let send_failure = self
            .counters
            .send_failure
            .load(Ordering::Relaxed)
            .min(MAX_HEALTH_COUNT);
        let attributes = JsonMap::from_iter([
            (
                "accepted_count".to_string(),
                JsonValue::Number(accepted.into()),
            ),
            (
                "rejected_count".to_string(),
                JsonValue::Number(rejected.into()),
            ),
            (
                "send_failure_count".to_string(),
                JsonValue::Number(send_failure.into()),
            ),
            (
                "queue_depth".to_string(),
                JsonValue::Number(queue_depth.min(MAX_HEALTH_COUNT as i64).into()),
            ),
            (
                "consent_state".to_string(),
                JsonValue::String("enabled".to_string()),
            ),
        ]);
        match self
            .persist_native_event(&state, "analytics.health_reported", attributes)
            .await
            .status
        {
            AnalyticsSubmitStatus::Persisted
            | AnalyticsSubmitStatus::Disabled
            | AnalyticsSubmitStatus::Unavailable => Ok(()),
            AnalyticsSubmitStatus::StaleEpoch => Err("stale_consent_epoch".to_string()),
            AnalyticsSubmitStatus::Rejected => Err("health_report_rejected".to_string()),
            AnalyticsSubmitStatus::Deduplicated => Ok(()),
            AnalyticsSubmitStatus::Error => Err("health_report_failed".to_string()),
        }
    }

    fn begin_foreground_activation(&self) {
        let mut activation = self
            .activation
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if activation.foreground && !activation.completed {
            return;
        }
        *activation = StartupActivation {
            id: uuid::Uuid::new_v4().to_string(),
            kind: AnalyticsStartupKind::Reactivation,
            source: self.startup_source.clone(),
            started_at: Instant::now(),
            foreground: true,
            completed: false,
        };
    }

    fn apply_state(&self, row: &AnalyticsStateRow) {
        self.enabled
            .store(row.status == "enabled", Ordering::SeqCst);
        self.consent_epoch
            .store(row.consent_epoch, Ordering::SeqCst);
    }

    async fn clear_session(&self) {
        *self.session.lock().await = None;
        self.operations.lock().await.clear();
        self.exposures.lock().await.clear();
    }

    /// Drops the in-memory session only when it is still the given id, so a
    /// session whose `session_started` row never committed is not advertised to
    /// later events while a concurrent, committed session is left untouched.
    async fn release_session_if(&self, session_id: &str) {
        let mut guard = self.session.lock().await;
        if guard.as_ref().map(|session| session.id.as_str()) == Some(session_id) {
            *guard = None;
        }
    }

    /// Resolves the native session for one event. A genuine user interaction
    /// starts a fresh session when none is active or the previous one went idle,
    /// and refreshes the active one; a passive event neither starts nor refreshes,
    /// it only carries the current session id when one exists.
    async fn resolve_session(&self, is_interaction: bool) -> (Option<String>, bool) {
        let mut guard = self.session.lock().await;
        if is_interaction {
            let now = Instant::now();
            let start = match guard.as_ref() {
                None => true,
                Some(session) => now.duration_since(session.last_activity) > SESSION_IDLE,
            };
            if start {
                let id = uuid::Uuid::new_v4().to_string();
                *guard = Some(NativeSession {
                    id: id.clone(),
                    last_activity: now,
                });
                return (Some(id), true);
            }
            if let Some(session) = guard.as_mut() {
                session.last_activity = now;
            }
        }
        (guard.as_ref().map(|session| session.id.clone()), false)
    }

    /// Builds the native `analytics.session_started` row for a new session,
    /// carrying the first-observed/first-success metadata from stored state.
    fn build_session_started_insert(
        &self,
        state: &AnalyticsStateRow,
        session_id: &str,
        consent_epoch: i64,
        occurred_at_ms: i64,
    ) -> Result<OutboxInsert, String> {
        let mut attributes = JsonMap::new();
        attributes.insert(
            "configured".to_string(),
            JsonValue::Bool(state.status == "enabled"),
        );
        if let Some(day) = &state.observation_started_day {
            attributes.insert(
                "first_observed_day".to_string(),
                JsonValue::String(day.clone()),
            );
        }
        if let Some(day) = &state.first_success_day {
            attributes.insert(
                "first_success_day".to_string(),
                JsonValue::String(day.clone()),
            );
        }
        let envelope = AnalyticsEventEnvelope {
            schema_version: events::SCHEMA_VERSION,
            event_id: uuid::Uuid::new_v4().to_string(),
            occurred_at_ms,
            installation_id: state.installation_id.clone().unwrap_or_default(),
            analytics_session_id: Some(session_id.to_string()),
            event_name: "analytics.session_started".to_string(),
            app_version: self.app_version.clone(),
            release_channel: self.release_channel.clone(),
            os_family: self.os_family.clone(),
            architecture: self.architecture.clone(),
            attributes,
        };
        build_insert(envelope, consent_epoch, false, "analytics.session_started")
    }

    fn build_event_insert(
        &self,
        state: &AnalyticsStateRow,
        session_id: Option<String>,
        consent_epoch: i64,
        request: &AnalyticsTrackRequest,
        marks_first_success: bool,
    ) -> Result<OutboxInsert, String> {
        let envelope = AnalyticsEventEnvelope {
            schema_version: events::SCHEMA_VERSION,
            event_id: uuid::Uuid::new_v4().to_string(),
            occurred_at_ms: request.occurred_at_ms,
            installation_id: state.installation_id.clone().unwrap_or_default(),
            analytics_session_id: session_id,
            event_name: request.event_name.clone(),
            app_version: self.app_version.clone(),
            release_channel: self.release_channel.clone(),
            os_family: self.os_family.clone(),
            architecture: self.architecture.clone(),
            attributes: request.attributes.clone(),
        };
        build_insert(
            envelope,
            consent_epoch,
            marks_first_success,
            &request.event_name,
        )
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

    /// On a native start, either confirm the restart that followed a successful
    /// install handoff (enqueuing `restart_confirmed` and clearing the pending
    /// metadata in one transaction) or discard stale metadata. A restored backup,
    /// an unfinished update and a changed consent epoch all fail the match and are
    /// never turned into a false confirmation.
    async fn resolve_restart_confirmation(
        &self,
        row: &AnalyticsStateRow,
        app_version: &str,
    ) -> Result<(), String> {
        let Some(pending_json) = &row.pending_update_json else {
            return Ok(());
        };
        let confirmed = parse_pending_update(pending_json).filter(|pending| {
            pending.to_version == app_version
                && pending.from_version.as_deref() != Some(app_version)
                && pending.consent_epoch == row.consent_epoch
                && pending.operation_id.is_some()
        });
        let Some(pending) = confirmed else {
            return store::clear_pending_update(self.database.pool()).await;
        };
        let mut attributes = JsonMap::new();
        attributes.insert(
            "update_operation_id".to_string(),
            JsonValue::String(pending.operation_id.clone().unwrap_or_default()),
        );
        attributes.insert(
            "phase".to_string(),
            JsonValue::String("restart_confirmed".to_string()),
        );
        if let Some(from_version) = &pending.from_version {
            attributes.insert(
                "from_version".to_string(),
                JsonValue::String(from_version.clone()),
            );
        }
        attributes.insert(
            "to_version".to_string(),
            JsonValue::String(pending.to_version.clone()),
        );
        attributes.insert(
            "result".to_string(),
            JsonValue::String("success".to_string()),
        );
        attributes.insert(
            "source".to_string(),
            JsonValue::String(
                pending
                    .source
                    .clone()
                    .unwrap_or_else(|| "other".to_string()),
            ),
        );
        let request = AnalyticsTrackRequest {
            event_name: "app.update_transition".to_string(),
            occurred_at_ms: store::now_millis(),
            operation_id: None,
            attributes,
        };
        let insert = self.build_event_insert(row, None, row.consent_epoch, &request, false)?;
        // Persisted clears the pending metadata in the same transaction. Any
        // other outcome (disabled, full, stale epoch) leaves it in place so the
        // next start can retry instead of losing the confirmation.
        match store::enqueue_batch(self.database.pool(), vec![insert], PendingUpdate::Clear).await?
        {
            EnqueueOutcome::Persisted => Ok(()),
            _ => Ok(()),
        }
    }
}

impl Clone for AnalyticsRuntime {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

fn build_insert(
    envelope: AnalyticsEventEnvelope,
    consent_epoch: i64,
    marks_first_success: bool,
    event_name: &str,
) -> Result<OutboxInsert, String> {
    let event_id = envelope.event_id.clone();
    let payload_json = serde_json::to_string(&envelope).map_err(|error| error.to_string())?;
    Ok(OutboxInsert {
        event_id,
        consent_epoch,
        schema_version: i64::from(events::SCHEMA_VERSION),
        event_name: event_name.to_string(),
        payload_json,
        priority: events::event_priority(event_name),
        marks_first_success,
    })
}

fn marks_first_success(event_name: &str, attributes: &JsonMap<String, JsonValue>) -> bool {
    event_name == "agent.request_completed"
        && attributes.get("result").and_then(JsonValue::as_str) == Some("success")
}

/// A genuine user interaction. Passive lifecycle, update, health and render-only
/// exposure events are not interactions, so they never start or refresh a
/// session. A background MCP reconnect is explicitly excluded.
fn is_user_interaction(event_name: &str, attributes: &JsonMap<String, JsonValue>) -> bool {
    match event_name {
        "product.surface_opened"
        | "provider.configuration_started"
        | "provider.configuration_completed"
        | "agent.request_submitted"
        | "search.completed"
        | "search.result_selected"
        | "result.action_completed"
        | "attachment.preparation_completed" => true,
        "mcp.connection_completed" => {
            attributes
                .get("connection_kind")
                .and_then(JsonValue::as_str)
                == Some("user")
        }
        _ => false,
    }
}

fn normalize_startup_source(source: &str) -> String {
    match source {
        "foreground" | "background" | "autostart" | "other" => source.to_string(),
        _ => "other".to_string(),
    }
}

/// Native monotonic duration, clamped to the bounded wire maximum.
fn elapsed_ms(started_at: Instant) -> i64 {
    i64::try_from(started_at.elapsed().as_millis())
        .unwrap_or(MAX_DURATION_MS)
        .min(MAX_DURATION_MS)
}

/// Bounded pending-update metadata stored when a real install handoff succeeds,
/// so the next native start can confirm the restart once and atomically.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUpdateMeta {
    #[serde(default)]
    operation_id: Option<String>,
    #[serde(default)]
    from_version: Option<String>,
    to_version: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    consent_epoch: i64,
}

fn parse_pending_update(json: &str) -> Option<PendingUpdateMeta> {
    serde_json::from_str(json).ok()
}

/// Builds the bounded pending metadata for an `install_handoff` transition that
/// succeeded. `None` for every other transition, so nothing else writes it.
fn install_handoff_pending(request: &AnalyticsTrackRequest, consent_epoch: i64) -> Option<String> {
    if request.event_name != "app.update_transition" {
        return None;
    }
    if request.attributes.get("phase").and_then(JsonValue::as_str) != Some("install_handoff") {
        return None;
    }
    if request.attributes.get("result").and_then(JsonValue::as_str) != Some("success") {
        return None;
    }
    let to_version = request
        .attributes
        .get("to_version")
        .and_then(JsonValue::as_str)?;
    let mut metadata = JsonMap::new();
    if let Some(value) = request
        .attributes
        .get("update_operation_id")
        .and_then(JsonValue::as_str)
    {
        metadata.insert(
            "operationId".to_string(),
            JsonValue::String(value.to_string()),
        );
    }
    if let Some(value) = request
        .attributes
        .get("from_version")
        .and_then(JsonValue::as_str)
    {
        metadata.insert(
            "fromVersion".to_string(),
            JsonValue::String(value.to_string()),
        );
    }
    metadata.insert(
        "toVersion".to_string(),
        JsonValue::String(to_version.to_string()),
    );
    if let Some(value) = request.attributes.get("source").and_then(JsonValue::as_str) {
        metadata.insert("source".to_string(), JsonValue::String(value.to_string()));
    }
    metadata.insert(
        "consentEpoch".to_string(),
        JsonValue::Number(consent_epoch.into()),
    );
    let document = JsonValue::Object(metadata).to_string();
    if document.len() > PENDING_UPDATE_MAX_BYTES {
        return None;
    }
    Some(document)
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
    // Bind the queue to one deployment target. The same official build always
    // resolves the same key; a community/self build that points at its own
    // endpoint (or one with no project id) resolves a different key, so its
    // queued rows are cleared before they could flush through another target.
    let deployment_key = if analytics.is_transport_ready() {
        analytics
            .send_url()
            .map(|send_url| format!("{send_url}|{}", analytics.website_id.trim()))
            .unwrap_or_default()
    } else {
        String::new()
    };
    Some(AnalyticsConfig {
        policy_version: POLICY_VERSION,
        default_enabled,
        transport,
        deployment_key,
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
        Self::initialize_with_sender_and_startup_for_tests(
            database,
            sender,
            default_enabled,
            "foreground",
            Instant::now(),
        )
        .await
    }

    async fn initialize_with_sender_and_startup_for_tests(
        database: DatabaseRuntime,
        sender: Option<Arc<dyn EventSender>>,
        default_enabled: bool,
        startup_source: &str,
        started_at: Instant,
    ) -> Result<Self, String> {
        let config = AnalyticsConfig {
            policy_version: POLICY_VERSION,
            default_enabled,
            transport: sender,
            deployment_key: String::new(),
        };
        let run_id = uuid::Uuid::new_v4().to_string();
        let startup_source = normalize_startup_source(startup_source);
        let runtime = Self {
            inner: Arc::new(AnalyticsRuntimeInner {
                database,
                transport_ready: config.transport.is_some(),
                config: Some(config),
                enabled: AtomicBool::new(false),
                consent_epoch: AtomicI64::new(0),
                session: Mutex::new(None),
                operations: Mutex::new(OperationRegistry::default()),
                exposures: Mutex::new(HashSet::new()),
                ingress: Arc::new(Ingress::default()),
                write_lock: Mutex::new(()),
                run_id: run_id.clone(),
                startup_source: startup_source.clone(),
                activation: StdMutex::new(StartupActivation {
                    id: run_id,
                    kind: AnalyticsStartupKind::Cold,
                    source: startup_source.clone(),
                    started_at,
                    foreground: startup_source == "foreground",
                    completed: false,
                }),
                app_started_emitted: AtomicBool::new(false),
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
        if row.status == "enabled" && runtime.inner.transport_ready {
            runtime.inner.emit_app_started(&row).await?;
        }
        Ok(runtime)
    }

    async fn session_id_for_tests(&self) -> Option<String> {
        self.inner
            .session
            .lock()
            .await
            .as_ref()
            .map(|session| session.id.clone())
    }

    /// Simulates another window opening a later session without waiting out the
    /// idle window, so immutable-session binding can be exercised deterministically.
    async fn force_session_for_tests(&self, id: &str) {
        *self.inner.session.lock().await = Some(NativeSession {
            id: id.to_string(),
            last_activity: Instant::now(),
        });
    }

    /// Every persisted envelope, oldest first, for asserting session binding.
    async fn outbox_payloads_for_tests(&self) -> Vec<AnalyticsEventEnvelope> {
        let payloads: Vec<String> = sqlx::query_scalar(
            "SELECT payload_json FROM analytics_outbox ORDER BY enqueued_at ASC, event_id ASC",
        )
        .fetch_all(self.inner.database.pool())
        .await
        .expect("outbox payloads");
        payloads
            .iter()
            .map(|payload| serde_json::from_str(payload).expect("envelope"))
            .collect()
    }

    async fn clear_outbox_for_tests(&self) {
        sqlx::query("DELETE FROM analytics_outbox")
            .execute(self.inner.database.pool())
            .await
            .expect("clear outbox");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{future::Future, pin::Pin};

    async fn test_database() -> (tempfile::TempDir, DatabaseRuntime) {
        let root = tempfile::tempdir().expect("temp dir");
        let runtime = DatabaseRuntime::initialize_for_tests(root.path())
            .await
            .expect("database runtime");
        (root, runtime)
    }

    async fn test_runtime(sender: Arc<dyn EventSender>) -> (tempfile::TempDir, AnalyticsRuntime) {
        let (root, database) = test_database().await;
        let runtime =
            AnalyticsRuntime::initialize_with_sender_for_tests(database, Some(sender), true)
                .await
                .expect("runtime");
        runtime.clear_outbox_for_tests().await;
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

    fn track_request(
        event_name: &str,
        attributes: JsonMap<String, JsonValue>,
    ) -> AnalyticsTrackRequest {
        AnalyticsTrackRequest {
            event_name: event_name.to_string(),
            occurred_at_ms: store::now_millis(),
            operation_id: None,
            attributes,
        }
    }

    fn with_operation(
        mut request: AnalyticsTrackRequest,
        operation_id: &str,
    ) -> AnalyticsTrackRequest {
        request.operation_id = Some(operation_id.to_string());
        request
    }

    fn request_submitted_attributes() -> JsonMap<String, JsonValue> {
        JsonMap::from_iter([
            (
                "request_id".to_string(),
                JsonValue::String("92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09".to_string()),
            ),
            (
                "request_kind".to_string(),
                JsonValue::String("agent".to_string()),
            ),
            ("surface".to_string(), JsonValue::String("main".to_string())),
            (
                "attachment_count_bucket".to_string(),
                JsonValue::String("0".to_string()),
            ),
        ])
    }

    fn request_completed_attributes() -> JsonMap<String, JsonValue> {
        JsonMap::from_iter([
            (
                "request_id".to_string(),
                JsonValue::String("92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09".to_string()),
            ),
            (
                "result".to_string(),
                JsonValue::String("success".to_string()),
            ),
            ("duration_ms".to_string(), JsonValue::Number(1200.into())),
            ("retry_count".to_string(), JsonValue::Number(0.into())),
            (
                "usage_coverage".to_string(),
                JsonValue::String("observed".to_string()),
            ),
            (
                "persistence_result".to_string(),
                JsonValue::String("saved".to_string()),
            ),
        ])
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
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe.clone()).await;

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
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe.clone()).await;
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
        let probe = Arc::new(Probe::new(|| SendOutcome::ConfigurationFailure {
            reason: "bot_rejected".to_string(),
        }));
        let (_root, runtime) = test_runtime(probe).await;
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
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe.clone()).await;
        store::enqueue(runtime.inner.database.pool(), poison_insert("poison"))
            .await
            .expect("enqueue");

        runtime.flush_once().await.expect("flush");

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
            .track(track_request("product.surface_opened", JsonMap::new()))
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
    async fn user_gets_one_native_app_started_when_sharing_and_transport_are_ready_at_start() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_and_startup_for_tests(
            database,
            Some(probe),
            true,
            "autostart",
            Instant::now(),
        )
        .await
        .expect("runtime");

        let envelopes = runtime.outbox_payloads_for_tests().await;
        let started = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "app.started")
            .expect("native app.started");
        assert_eq!(
            started.attributes.get("run_id").and_then(JsonValue::as_str),
            Some(runtime.inner.run_id.as_str())
        );
        assert_eq!(
            started
                .attributes
                .get("startup_source")
                .and_then(JsonValue::as_str),
            Some("autostart")
        );
        assert!(started.analytics_session_id.is_none());
        assert!(runtime.session_id_for_tests().await.is_none());
        assert_eq!(
            envelopes
                .iter()
                .filter(|envelope| envelope.event_name == "app.started")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn user_gets_no_app_started_backfill_when_sharing_was_off_at_start() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, database) = test_database().await;
        let runtime =
            AnalyticsRuntime::initialize_with_sender_for_tests(database, Some(probe), false)
                .await
                .expect("runtime");

        runtime.set_enabled(true, 0).await.expect("enable");

        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
    }

    #[tokio::test]
    async fn user_gets_no_app_started_when_transport_was_not_ready_at_start() {
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_for_tests(database, None, true)
            .await
            .expect("runtime");

        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
    }

    #[tokio::test]
    async fn user_gets_a_webview_app_started_rejected_without_trusting_its_fields() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        let attributes = JsonMap::from_iter([
            (
                "run_id".to_string(),
                JsonValue::String("11111111-1111-4111-8111-111111111111".to_string()),
            ),
            (
                "startup_source".to_string(),
                JsonValue::String("foreground".to_string()),
            ),
        ]);

        let result = runtime
            .track(track_request("app.started", attributes))
            .await;

        assert_eq!(result.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(result.reason.as_deref(), Some("native_event_owned"));
        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
    }

    #[tokio::test]
    async fn user_gets_native_startup_fields_once_when_a_cold_activation_completes() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_and_startup_for_tests(
            database,
            Some(probe),
            true,
            "foreground",
            Instant::now() - Duration::from_secs(2),
        )
        .await
        .expect("runtime");
        runtime.clear_outbox_for_tests().await;
        let context = runtime.lifecycle_context().await;
        assert_eq!(context.startup_kind, AnalyticsStartupKind::Cold);
        assert_eq!(context.startup_id, context.run_id);
        assert!(context.elapsed_ms >= 2_000);
        let forged = JsonMap::from_iter([
            (
                "startup_id".to_string(),
                JsonValue::String("11111111-1111-4111-8111-111111111111".to_string()),
            ),
            (
                "startup_kind".to_string(),
                JsonValue::String("reactivation".to_string()),
            ),
            (
                "startup_source".to_string(),
                JsonValue::String("autostart".to_string()),
            ),
            ("duration_ms".to_string(), JsonValue::Number(1.into())),
        ]);

        let result = runtime
            .track(track_request("app.startup_completed", forged.clone()))
            .await;
        assert_eq!(result.status, AnalyticsSubmitStatus::Persisted);
        let envelopes = runtime.outbox_payloads_for_tests().await;
        let completed = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "app.startup_completed")
            .expect("startup completion");
        assert_eq!(
            completed
                .attributes
                .get("startup_id")
                .and_then(JsonValue::as_str),
            Some(context.startup_id.as_str())
        );
        assert_eq!(
            completed
                .attributes
                .get("startup_kind")
                .and_then(JsonValue::as_str),
            Some("cold")
        );
        assert_eq!(
            completed
                .attributes
                .get("startup_source")
                .and_then(JsonValue::as_str),
            Some("foreground")
        );
        assert!(completed
            .attributes
            .get("duration_ms")
            .and_then(JsonValue::as_i64)
            .is_some_and(|duration| duration >= 2_000));
        assert!(completed.analytics_session_id.is_none());
        assert!(runtime.session_id_for_tests().await.is_none());

        let duplicate = runtime
            .track(track_request("app.startup_completed", forged))
            .await;
        assert_eq!(duplicate.status, AnalyticsSubmitStatus::Deduplicated);
        assert_eq!(
            duplicate.reason.as_deref(),
            Some("startup_already_completed")
        );
        assert_eq!(
            runtime
                .outbox_payloads_for_tests()
                .await
                .iter()
                .filter(|envelope| envelope.event_name == "app.startup_completed")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn user_gets_no_startup_completion_from_an_autostart_that_never_entered_foreground() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_and_startup_for_tests(
            database,
            Some(probe),
            true,
            "autostart",
            Instant::now() - Duration::from_secs(5),
        )
        .await
        .expect("runtime");
        runtime.clear_outbox_for_tests().await;
        let cold = runtime.lifecycle_context().await;

        runtime.complete_foreground_activation().await;
        let result = runtime
            .track(track_request("app.startup_completed", JsonMap::new()))
            .await;
        assert_eq!(result.status, AnalyticsSubmitStatus::Deduplicated);
        assert_eq!(result.reason.as_deref(), Some("startup_not_foreground"));
        assert!(runtime
            .outbox_payloads_for_tests()
            .await
            .iter()
            .all(|envelope| envelope.event_name != "app.startup_completed"));

        runtime.begin_foreground_activation();
        let reactivation = runtime.lifecycle_context().await;
        assert_eq!(
            reactivation.startup_kind,
            AnalyticsStartupKind::Reactivation
        );
        assert_ne!(reactivation.startup_id, cold.startup_id);
        assert_eq!(reactivation.startup_source, "autostart");
        let completed = runtime
            .track(track_request("app.startup_completed", JsonMap::new()))
            .await;
        assert_eq!(completed.status, AnalyticsSubmitStatus::Persisted);
        let envelopes = runtime.outbox_payloads_for_tests().await;
        let startup = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "app.startup_completed")
            .expect("reactivation completion");
        assert_eq!(
            startup
                .attributes
                .get("startup_id")
                .and_then(JsonValue::as_str),
            Some(reactivation.startup_id.as_str())
        );
        assert_eq!(
            startup
                .attributes
                .get("startup_kind")
                .and_then(JsonValue::as_str),
            Some("reactivation")
        );
    }

    #[tokio::test]
    async fn user_gets_no_startup_completion_backfill_when_sharing_was_off_at_activation() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        runtime.set_enabled(false, 0).await.expect("disable");

        let while_off = runtime
            .track(track_request("app.startup_completed", JsonMap::new()))
            .await;
        assert_eq!(while_off.status, AnalyticsSubmitStatus::Disabled);

        // Turning sharing on afterwards must not resurrect the activation the
        // user never shared.
        runtime.set_enabled(true, 1).await.expect("enable");
        let after_enable = runtime
            .track(track_request("app.startup_completed", JsonMap::new()))
            .await;
        assert_eq!(after_enable.status, AnalyticsSubmitStatus::Deduplicated);
        assert!(runtime
            .outbox_payloads_for_tests()
            .await
            .iter()
            .all(|envelope| envelope.event_name != "app.startup_completed"));
    }

    #[tokio::test]
    async fn user_gets_a_health_report_with_real_counters_queue_depth_and_no_session() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        store::enqueue(runtime.inner.database.pool(), outbox_insert("delivered"))
            .await
            .expect("enqueue delivered");
        runtime.flush_once().await.expect("flush delivered");
        store::enqueue(runtime.inner.database.pool(), outbox_insert("queued"))
            .await
            .expect("enqueue queued");

        runtime.inner.emit_health_once().await.expect("health");

        let envelopes = runtime.outbox_payloads_for_tests().await;
        let health = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "analytics.health_reported")
            .expect("health report");
        assert_eq!(
            health
                .attributes
                .get("accepted_count")
                .and_then(JsonValue::as_u64),
            Some(1)
        );
        assert_eq!(
            health
                .attributes
                .get("queue_depth")
                .and_then(JsonValue::as_i64),
            Some(1)
        );
        assert_eq!(
            health
                .attributes
                .get("consent_state")
                .and_then(JsonValue::as_str),
            Some("enabled")
        );
        assert!(!health.attributes.contains_key("duplicate_count"));
        assert!(health.analytics_session_id.is_none());
        assert!(runtime.session_id_for_tests().await.is_none());
    }

    #[tokio::test]
    async fn user_does_not_inflate_accepted_events_with_health_deliveries() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        store::enqueue(runtime.inner.database.pool(), outbox_insert("delivered"))
            .await
            .expect("enqueue delivered");
        runtime.flush_once().await.expect("flush delivered");
        runtime
            .inner
            .emit_health_once()
            .await
            .expect("first health");
        runtime.flush_once().await.expect("flush health");

        runtime
            .inner
            .emit_health_once()
            .await
            .expect("second health");

        let envelopes = runtime.outbox_payloads_for_tests().await;
        let health = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "analytics.health_reported")
            .expect("health report");
        assert_eq!(
            health
                .attributes
                .get("accepted_count")
                .and_then(JsonValue::as_u64),
            Some(1)
        );
        assert_eq!(
            health
                .attributes
                .get("queue_depth")
                .and_then(JsonValue::as_i64),
            Some(0)
        );
    }

    #[tokio::test]
    async fn user_gets_no_health_report_after_opt_out() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        runtime.set_enabled(false, 0).await.expect("disable");

        runtime.inner.emit_health_once().await.expect("health");

        assert!(runtime
            .outbox_payloads_for_tests()
            .await
            .iter()
            .all(|envelope| envelope.event_name != "analytics.health_reported"));
    }

    #[tokio::test]
    async fn user_gets_an_explicit_stale_result_when_clearing_with_an_outdated_epoch() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        let error = runtime
            .clear_pending(99)
            .await
            .expect_err("a stale epoch must not report a successful clear");
        assert_eq!(error, "stale_consent_epoch");
    }

    #[tokio::test]
    async fn user_starts_a_session_only_on_a_real_interaction() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        let passive = runtime
            .track(track_request(
                "product.feature_exposed",
                JsonMap::from_iter([("feature".to_string(), JsonValue::String("mcp".to_string()))]),
            ))
            .await;
        assert_eq!(passive.status, AnalyticsSubmitStatus::Persisted);
        assert!(
            runtime.session_id_for_tests().await.is_none(),
            "a passive exposure must not start a session"
        );

        let interaction = runtime
            .track(track_request(
                "product.surface_opened",
                JsonMap::from_iter([(
                    "surface".to_string(),
                    JsonValue::String("main".to_string()),
                )]),
            ))
            .await;
        assert_eq!(interaction.status, AnalyticsSubmitStatus::Persisted);
        assert!(
            runtime.session_id_for_tests().await.is_some(),
            "a real interaction starts a session"
        );
    }

    #[tokio::test]
    async fn user_binds_a_completion_to_the_operation_session() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        let handle = runtime.begin_operation().await;
        let submitted = runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(submitted.status, AnalyticsSubmitStatus::Persisted);
        let original = runtime
            .session_id_for_tests()
            .await
            .expect("submitting starts a session");

        // Another window opens a later session before the completion arrives.
        runtime.force_session_for_tests("11111111-1111-4111-8111-111111111111");
        let completed = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(completed.status, AnalyticsSubmitStatus::Persisted);

        let envelopes = runtime.outbox_payloads_for_tests().await;
        let completion = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "agent.request_completed")
            .expect("completion row");
        assert_eq!(
            completion.analytics_session_id.as_deref(),
            Some(original.as_str()),
            "the completion keeps the immutable session captured by the operation"
        );
    }

    #[tokio::test]
    async fn user_deduplicates_a_feature_exposure_within_a_session() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        let attributes =
            || JsonMap::from_iter([("feature".to_string(), JsonValue::String("mcp".to_string()))]);

        let first = runtime
            .track(track_request("product.feature_exposed", attributes()))
            .await;
        assert_eq!(first.status, AnalyticsSubmitStatus::Persisted);

        let second = runtime
            .track(track_request("product.feature_exposed", attributes()))
            .await;
        assert_eq!(second.status, AnalyticsSubmitStatus::Deduplicated);
        assert_eq!(second.reason.as_deref(), Some("feature_already_exposed"));
    }

    #[tokio::test]
    async fn user_clears_the_session_when_sharing_is_turned_off() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        runtime
            .track(track_request(
                "product.surface_opened",
                JsonMap::from_iter([(
                    "surface".to_string(),
                    JsonValue::String("main".to_string()),
                )]),
            ))
            .await;
        assert!(runtime.session_id_for_tests().await.is_some());

        runtime.set_enabled(false, 0).await.expect("disable");
        assert!(
            runtime.session_id_for_tests().await.is_none(),
            "withdrawing consent drops the in-memory session"
        );
    }

    #[test]
    fn user_gets_ingress_capacity_released_when_a_caller_is_dropped() {
        let ingress = Arc::new(Ingress::default());
        {
            let _guard = ingress
                .try_admit(INGRESS_MAX_ENTRIES, INGRESS_MAX_BYTES)
                .expect("capacity");
            assert!(ingress.try_admit(1, 1).is_none(), "a full gate rejects");
            assert!(
                ingress.try_admit(0, 1).is_none(),
                "the byte budget is enforced"
            );
        }
        assert!(
            ingress
                .try_admit(INGRESS_MAX_ENTRIES, INGRESS_MAX_BYTES)
                .is_some(),
            "capacity returns as soon as the guard is dropped"
        );
    }

    #[tokio::test]
    async fn user_gets_no_provisional_session_when_the_start_does_not_commit() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        // Hold the whole ingress budget so the next event cannot be admitted and
        // therefore cannot commit.
        let held = runtime
            .inner
            .ingress
            .try_admit(INGRESS_MAX_ENTRIES, INGRESS_MAX_BYTES)
            .expect("hold ingress");

        let result = runtime
            .track(track_request(
                "product.surface_opened",
                JsonMap::from_iter([(
                    "surface".to_string(),
                    JsonValue::String("main".to_string()),
                )]),
            ))
            .await;
        assert_eq!(result.status, AnalyticsSubmitStatus::Unavailable);
        assert!(
            runtime.session_id_for_tests().await.is_none(),
            "a session whose start did not commit must not be advertised to later events"
        );
        drop(held);
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
        success.insert("result".to_string(), JsonValue::String("success".into()));
        let mut failure = JsonMap::new();
        failure.insert("result".to_string(), JsonValue::String("failure".into()));

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

    #[test]
    fn user_only_counts_a_user_mcp_connection_as_an_interaction() {
        let user = JsonMap::from_iter([(
            "connection_kind".to_string(),
            JsonValue::String("user".to_string()),
        )]);
        let background = JsonMap::from_iter([(
            "connection_kind".to_string(),
            JsonValue::String("background_reconnect".to_string()),
        )]);

        assert!(is_user_interaction("mcp.connection_completed", &user));
        assert!(!is_user_interaction(
            "mcp.connection_completed",
            &background
        ));
        assert!(!is_user_interaction(
            "product.feature_exposed",
            &JsonMap::new()
        ));
        assert!(is_user_interaction(
            "product.surface_opened",
            &JsonMap::new()
        ));
    }

    #[test]
    fn user_stores_bounded_pending_metadata_only_for_a_successful_install_handoff() {
        let request = |phase: &str, result: &str| AnalyticsTrackRequest {
            event_name: "app.update_transition".to_string(),
            occurred_at_ms: store::now_millis(),
            operation_id: None,
            attributes: JsonMap::from_iter([
                (
                    "update_operation_id".to_string(),
                    JsonValue::String("11111111-1111-4111-8111-111111111111".to_string()),
                ),
                ("phase".to_string(), JsonValue::String(phase.to_string())),
                ("result".to_string(), JsonValue::String(result.to_string())),
                (
                    "from_version".to_string(),
                    JsonValue::String("1.0.0".to_string()),
                ),
                (
                    "to_version".to_string(),
                    JsonValue::String("2.0.0".to_string()),
                ),
                ("source".to_string(), JsonValue::String("user".to_string())),
            ]),
        };

        let document =
            install_handoff_pending(&request("install_handoff", "success"), 3).expect("pending");
        let parsed = parse_pending_update(&document).expect("parse");
        assert_eq!(parsed.to_version, "2.0.0");
        assert_eq!(parsed.from_version.as_deref(), Some("1.0.0"));
        assert_eq!(parsed.consent_epoch, 3);

        assert!(install_handoff_pending(&request("download_finished", "success"), 3).is_none());
        assert!(install_handoff_pending(&request("install_handoff", "failure"), 3).is_none());
    }
}
