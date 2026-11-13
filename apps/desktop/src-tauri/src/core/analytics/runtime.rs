// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Consent, identity, native session, operation context and the bounded
//! best-effort in-memory sender orchestration.
//!
//! The WebView submits typed metadata only. The native runtime owns the process
//! run identity, the startup classification, the analytics session, the consent
//! epoch and the in-memory queue. Only consent and small delivery metadata touch
//! the shared `touchai.db` pool.

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
use crate::core::product_config::{product_config, ProductAnalytics, ANALYTICS_PROTOCOL_VERSION};

use super::events;
use super::queue::{self, AnalyticsQueue, EnqueueOutcome, QueueInsert, QueuedEvent};
use super::store::{self, AnalyticsStateRow, MetadataOutcome, PendingUpdate};
use super::transport::{
    prepare_batch, AnalyticsEventEnvelope, AnalyticsTransport, EventSender, PreparedAnalyticsBatch,
    SendOutcome,
};
use super::{
    AnalyticsConsentStatus, AnalyticsEnvironment, AnalyticsLifecycleContext,
    AnalyticsOperationHandle, AnalyticsStartupKind, AnalyticsState, AnalyticsSubmitResult,
    AnalyticsSubmitStatus, AnalyticsTrackRequest,
};

const POLICY_VERSION: i64 = 1;
const MIN_OCCURRED_AT_MS: i64 = 1_577_836_800_000;
const SEND_INTERVAL: Duration = Duration::from_secs(5);
/// Upper bound for the loop before each send in one flush pass.
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
const PENDING_UPDATE_MAX_BYTES: usize = 640;
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
    interaction_admitted: bool,
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
                interaction_admitted: false,
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

    fn get(&mut self, id: &str) -> Option<(Option<String>, i64, bool)> {
        self.prune();
        self.records.get(id).map(|record| {
            (
                record.session_id.clone(),
                record.consent_epoch,
                record.interaction_admitted,
            )
        })
    }

    fn set_session(&mut self, id: &str, session_id: String, interaction_admitted: bool) {
        if let Some(record) = self.records.get_mut(id) {
            record.session_id = Some(session_id);
            record.interaction_admitted |= interaction_admitted;
        }
    }

    fn remove(&mut self, id: &str) {
        self.records.remove(id);
    }

    /// Revokes every handle bound to an abandoned session, so a late completion
    /// is rejected as stale instead of reintroducing the session's id.
    fn remove_session(&mut self, session_id: &str) {
        self.records
            .retain(|_, record| record.session_id.as_deref() != Some(session_id));
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

struct AnalyticsConfig {
    policy_version: i64,
    default_enabled: bool,
    build_eligible: bool,
    transport: Option<Arc<dyn EventSender>>,
    /// The endpoint + project id this build delivers to.
    deployment_key: String,
}

#[derive(Debug, Clone)]
struct PendingBatchMember {
    event_id: String,
    consent_epoch: i64,
}

/// The exact immutable request reserved for retry. New events cannot join it
/// and a transient retry reuses its ordered members, body and batch id.
#[derive(Debug, Clone)]
struct PendingDeliveryBatch {
    generation: u64,
    prepared: PreparedAnalyticsBatch,
    members: Vec<PendingBatchMember>,
    attempt_count: i64,
    retry_at_ms: i64,
    expires_at_ms: i64,
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
    /// Wall-clock instant of the latest consent status/epoch transition. A
    /// WebView operation started before this instant cannot prove which
    /// generation it belonged to, so native refuses to issue a handle.
    consent_changed_at_ms: AtomicI64,
    build_eligible: bool,
    transport_ready: bool,
    session: Mutex<Option<NativeSession>>,
    operations: Mutex<OperationRegistry>,
    exposures: Mutex<HashSet<String>>,
    /// Best-effort events for this process only. Restarting the app drops them.
    queue: Mutex<AnalyticsQueue>,
    /// A request awaiting an acknowledgement, configuration failure or expiry.
    pending_batch: Mutex<Option<PendingDeliveryBatch>>,
    pending_batch_generation: AtomicU64,
    /// Serializes consent and session transitions that accompany queue changes.
    state_lock: Mutex<()>,
    /// Process-wide run identity. Native-owned; the WebView reads it and never
    /// invents a process start.
    run_id: String,
    startup_source: String,
    activation: StdMutex<StartupActivation>,
    app_started_emitted: AtomicBool,
    /// Serializes the single sender.
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
        let build_eligible = config.as_ref().is_some_and(|config| config.build_eligible);
        let run_id = uuid::Uuid::new_v4().to_string();
        let startup_source = normalize_startup_source(&startup_source);

        let app_version_for_pending = app_version.clone();
        let runtime = Self {
            inner: Arc::new(AnalyticsRuntimeInner {
                database,
                config,
                enabled: AtomicBool::new(false),
                consent_epoch: AtomicI64::new(0),
                consent_changed_at_ms: AtomicI64::new(0),
                build_eligible,
                transport_ready,
                session: Mutex::new(None),
                operations: Mutex::new(OperationRegistry::default()),
                exposures: Mutex::new(HashSet::new()),
                queue: Mutex::new(AnalyticsQueue::default()),
                pending_batch: Mutex::new(None),
                pending_batch_generation: AtomicU64::new(0),
                state_lock: Mutex::new(()),
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
        if !self
            .inner
            .config
            .as_ref()
            .is_some_and(|config| config.transport.is_some())
        {
            return;
        }
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
        if !self
            .inner
            .config
            .as_ref()
            .is_some_and(|config| config.transport.is_some())
        {
            return;
        }
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

    /// Reconciles in-memory delivery state after a database restore. Consent can
    /// change outside the analytics command during a full import, so the queue
    /// and native bindings must be invalidated before the next read or send.
    pub(crate) async fn synchronize_after_restore(&self) -> Result<(), String> {
        let _state = self.inner.state_lock.lock().await;
        let row = store::load_state(self.inner.database.pool())
            .await?
            .ok_or_else(|| "analytics_state_missing".to_string())?;
        self.inner.refresh_state(&row).await;
        Ok(())
    }

    pub async fn set_enabled(
        &self,
        enabled: bool,
        expected_epoch: i64,
    ) -> Result<AnalyticsState, String> {
        let Some(config) = &self.inner.config else {
            return self.inner.build_state().await;
        };
        if enabled && (!self.inner.build_eligible || !self.inner.transport_ready) {
            return self.inner.build_state().await;
        }
        let _state = self.inner.state_lock.lock().await;
        let updated = store::set_enabled(
            self.inner.database.pool(),
            enabled,
            expected_epoch,
            config.policy_version,
        )
        .await?;
        if let Some(row) = updated {
            if !enabled {
                self.inner.queue.lock().await.clear();
                self.inner.invalidate_pending_batch().await;
            }
            self.inner.refresh_state(&row).await;
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
        let _state = self.inner.state_lock.lock().await;
        match store::clear_pending(self.inner.database.pool(), expected_epoch).await? {
            Some(row) => {
                self.inner.queue.lock().await.clear();
                self.inner.invalidate_pending_batch().await;
                self.inner.apply_state(&row);
                // A cleared start must not be referenced by later operations.
                self.inner.clear_session().await;
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
        let result = self.complete_startup_activation(None).await;
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
    #[cfg(test)]
    pub async fn begin_operation(&self) -> AnalyticsOperationHandle {
        self.begin_operation_at(store::now_millis()).await
    }

    /// Issues a handle only when the caller's synchronous action-start instant
    /// is newer than every observed consent transition. Passing an older or
    /// future timestamp fails closed instead of binding the action to current
    /// consent that the user enabled while the IPC request was queued.
    pub(crate) async fn begin_operation_at(&self, started_at_ms: i64) -> AnalyticsOperationHandle {
        let _state = self.inner.state_lock.lock().await;
        let now = store::now_millis();
        let consent_changed_at_ms = self.inner.consent_changed_at_ms.load(Ordering::SeqCst);
        if !self.inner.build_eligible
            || !self.inner.transport_ready
            || started_at_ms < MIN_OCCURRED_AT_MS
            || started_at_ms > now
            || started_at_ms <= consent_changed_at_ms
        {
            return AnalyticsOperationHandle {
                operation_id: String::new(),
                enabled: false,
                consent_epoch: self.inner.consent_epoch.load(Ordering::SeqCst),
            };
        }
        let session_id = self
            .inner
            .session
            .lock()
            .await
            .as_ref()
            .and_then(|session| {
                (session.last_activity.elapsed() <= SESSION_IDLE).then(|| session.id.clone())
            });
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

    /// Captures an operation without letting analytics writer contention delay a
    /// user action. Cancellation while waiting for the writer leaves no handle.
    pub async fn begin_operation_with_timeout(
        &self,
        timeout: Duration,
    ) -> Option<AnalyticsOperationHandle> {
        tokio::time::timeout(timeout, self.begin_operation_at(store::now_millis()))
            .await
            .ok()
    }

    pub async fn complete_operation(&self, operation_id: &str) {
        self.inner.operations.lock().await.remove(operation_id);
    }

    pub async fn track(&self, request: AnalyticsTrackRequest) -> AnalyticsSubmitResult {
        self.track_with_install_handoff(request, None).await
    }

    /// Records an install handoff using native-authoritative versions. The
    /// event attributes remain constrained by the public wire contract; the
    /// exact versions are carried separately into pending metadata so a valid
    /// long SemVer can still be confirmed after the restart.
    pub(crate) async fn track_install_handoff(
        &self,
        mut request: AnalyticsTrackRequest,
        from_version: Option<String>,
        to_version: String,
    ) -> AnalyticsSubmitResult {
        request.attributes.remove("from_version");
        request.attributes.remove("to_version");
        if let Some(from_version) = from_version
            .as_deref()
            .filter(|value| events::is_version_shaped(value))
        {
            request.attributes.insert(
                "from_version".to_string(),
                JsonValue::String(from_version.to_string()),
            );
        }
        if events::is_version_shaped(&to_version) {
            request.attributes.insert(
                "to_version".to_string(),
                JsonValue::String(to_version.clone()),
            );
        }
        self.track_with_install_handoff(
            request,
            Some(InstallHandoffVersions {
                from_version,
                to_version,
            }),
        )
        .await
    }

    /// Records the install handoff and releases its original operation under one
    /// total deadline. Installer exit must never wait on the analytics writer or
    /// SQLite contention; a timed-out handoff is best-effort telemetry.
    pub(crate) async fn track_install_handoff_before_exit(
        &self,
        request: AnalyticsTrackRequest,
        from_version: Option<String>,
        to_version: String,
        operation_id: Option<&str>,
        timeout: Duration,
    ) {
        let Some(operation_id) = operation_id.filter(|operation_id| !operation_id.is_empty())
        else {
            return;
        };
        let handoff = async {
            let _ = self
                .track_install_handoff(request, from_version, to_version)
                .await;
            self.complete_operation(operation_id).await;
        };
        if tokio::time::timeout(timeout, handoff).await.is_err() {
            log::debug!(target: "analytics", "install handoff deadline expired");
        }
    }

    async fn track_with_install_handoff(
        &self,
        request: AnalyticsTrackRequest,
        install_versions: Option<InstallHandoffVersions>,
    ) -> AnalyticsSubmitResult {
        if let Some(id) = request.operation_id.as_deref() {
            if self.inner.operations.lock().await.get(id).is_none() {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Rejected,
                    "stale_operation",
                );
            }
        }
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
            return self
                .complete_startup_activation(request.operation_id.as_deref())
                .await;
        }
        if self.inner.config.is_none() {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "not_configured",
            );
        }
        if !self.inner.build_eligible {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "development_build",
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
        // Context resolution and queue admission share one lock so another
        // window cannot capture a provisional session whose queue commit fails.
        let _state = self.inner.state_lock.lock().await;
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
        self.inner.refresh_state(&state).await;
        if state.status != "enabled" {
            return AnalyticsSubmitResult::new(AnalyticsSubmitStatus::Disabled);
        }
        if let Err(error) = self.inner.purge_expired_sessions(store::now_millis()).await {
            return AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Error, error);
        }

        // The native runtime owns the process session. This ownership response
        // does not imply a matching start was persisted or accepted remotely.
        if request.event_name == "analytics.session_started" {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Deduplicated,
                "native_session_owned",
            );
        }

        // Resolve the consent epoch and any session already bound to the handle.
        // An unknown handle has expired, been evicted, or been revoked by an
        // opt-out: the event belongs to an operation the runtime no longer
        // describes, so it fails closed instead of borrowing the current session
        // or a newer consent epoch.
        let (operation, captured_session, epoch, interaction_admitted) =
            match request.operation_id.as_deref() {
                Some(id) => match self.inner.operations.lock().await.get(id) {
                    Some((session_id, epoch, interaction_admitted)) => (
                        Some(id.to_string()),
                        session_id,
                        epoch,
                        interaction_admitted,
                    ),
                    None => {
                        return AnalyticsSubmitResult::with_reason(
                            AnalyticsSubmitStatus::Rejected,
                            "stale_operation",
                        )
                    }
                },
                None => (
                    None,
                    None,
                    self.inner.consent_epoch.load(Ordering::SeqCst),
                    false,
                ),
            };

        let is_interaction = is_user_interaction(&request.event_name, &request.attributes);
        let (session_id, started_session) = match (captured_session, is_interaction) {
            // A handle captures a session at action start, but its first real
            // interaction must still admit that session. Crossing the idle
            // boundary while capture is pending opens a fresh session.
            (Some(session_id), true) if !interaction_admitted => {
                self.inner.admit_operation_interaction(session_id).await
            }
            // Once an interaction has been admitted, every later completion is
            // immutable even if that original session has since gone idle.
            (Some(session_id), _) => (Some(session_id), false),
            (None, _) => self.inner.resolve_session(is_interaction).await,
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

        let pending = install_handoff_pending(
            &request,
            epoch,
            install_versions.as_ref().map(|versions| {
                (
                    versions.to_version.as_str(),
                    versions.from_version.as_deref(),
                )
            }),
        )
        .map(PendingUpdate::Set)
        .unwrap_or(PendingUpdate::Unchanged);
        let primary_event_id = inserts.last().map(|insert| insert.event_id.clone());
        let result = self
            .inner
            .enqueue_inserts(inserts, pending, primary_event_id)
            .await;

        if result.status == AnalyticsSubmitStatus::Queued {
            // The session is live now: reset the per-session exposures and bind
            // the operation handle to the immutable session that was queued.
            if started_session {
                if let Some(session_id) = &session_id {
                    *self.inner.session.lock().await = Some(NativeSession {
                        id: session_id.clone(),
                        last_activity: Instant::now(),
                    });
                }
                self.inner.exposures.lock().await.clear();
            }
            if let (Some(operation), Some(session_id)) = (&operation, &session_id) {
                self.inner.operations.lock().await.set_session(
                    operation,
                    session_id.clone(),
                    is_interaction,
                );
            }
            // The exposure key is recorded only after the event was queued.
            if let Some(key) = exposure_key {
                let mut exposures = self.inner.exposures.lock().await;
                if exposures.len() >= EXPOSURE_MAX {
                    // Bounded: drop the whole set rather than grow without limit.
                    exposures.clear();
                }
                exposures.insert(key);
            }
        }
        result
    }

    /// Emits one native-owned startup completion for the current activation.
    /// The activation is consumed before the write so concurrent focus/track
    /// callers cannot persist two rows for the same activation.
    async fn complete_startup_activation(
        &self,
        operation_id: Option<&str>,
    ) -> AnalyticsSubmitResult {
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
        if !self.inner.build_eligible {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Unavailable,
                "development_build",
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
            .persist_native_event(&state, "app.startup_completed", attributes, operation_id)
            .await
    }

    async fn flush_once(&self) -> Result<(), String> {
        let _guard = self.inner.flush_lock.lock().await;
        self.flush_impl().await
    }

    async fn flush_impl(&self) -> Result<(), String> {
        if !self.inner.build_eligible {
            return Ok(());
        }
        let Some(config) = &self.inner.config else {
            return Ok(());
        };
        let Some(transport) = &config.transport else {
            return Ok(());
        };
        let now = store::now_millis();
        {
            let _state = self.inner.state_lock.lock().await;
            let state = store::load_state(self.inner.database.pool())
                .await?
                .ok_or_else(|| "analytics_state_missing".to_string())?;
            self.inner.refresh_state(&state).await;
            if state.status != "enabled" {
                return Ok(());
            }
            self.inner.purge_expired_sessions(now).await?;
        }
        let started = Instant::now();

        loop {
            if started.elapsed() >= FLUSH_BUDGET {
                break;
            }
            // Consent can be withdrawn while a batch is being built or retried;
            // re-check the gate before every HTTP attempt. An in-flight request
            // cannot be recalled locally.
            if !self.inner.enabled.load(Ordering::SeqCst) {
                break;
            }

            let now = store::now_millis();
            let pending = self.inner.pending_batch.lock().await.clone();
            let (prepared, generation, members, attempt_count) = if let Some(pending) = pending {
                if now < pending.retry_at_ms {
                    break;
                }
                if now >= pending.expires_at_ms {
                    self.inner
                        .discard_pending_batch(pending.generation, &pending.members)
                        .await;
                    continue;
                }
                (
                    pending.prepared,
                    pending.generation,
                    pending.members,
                    pending.attempt_count,
                )
            } else {
                let (rows, pending_starts) = {
                    let queue = self.inner.queue.lock().await;
                    (
                        queue.due_batch(now, queue::SEND_BATCH_LIMIT),
                        queue.pending_session_starts(),
                    )
                };
                if rows.is_empty() {
                    break;
                }
                // A due dependent must never overtake its session start while
                // that start is backing off. A start is kept in its own batch.
                let mut batch: Vec<(QueuedEvent, AnalyticsEventEnvelope)> = Vec::new();

                for row in rows {
                    if started.elapsed() >= FLUSH_BUDGET {
                        break;
                    }
                    if !self.inner.queue.lock().await.contains(
                        &row.event_id,
                        row.consent_epoch,
                        now,
                    ) {
                        continue;
                    }
                    let envelope: AnalyticsEventEnvelope =
                        match serde_json::from_str(&row.payload_json) {
                            Ok(envelope) => envelope,
                            Err(error) => {
                                self.drop_corrupt_row(
                                    &row,
                                    format!("stored_payload_corrupt:{error}"),
                                )
                                .await?;
                                continue;
                            }
                        };
                    if row.event_name != "analytics.session_started" {
                        if let Some(retry_at) = envelope
                            .analytics_session_id
                            .as_deref()
                            .and_then(|session_id| pending_starts.get(session_id).copied())
                        {
                            // `hold_until` never moves an event earlier, so its
                            // own backoff is preserved.
                            self.inner
                                .queue
                                .lock()
                                .await
                                .hold_until(&row.event_id, retry_at);
                            continue;
                        }
                    }
                    let is_session_start = row.event_name == "analytics.session_started";
                    batch.push((row, envelope));
                    if is_session_start {
                        break;
                    }
                }

                if batch.is_empty() {
                    break;
                }
                // Consent withdrawal or clear-pending can remove entries while
                // the batch is assembled. A partial stale batch is deferred.
                let sendable_now = store::now_millis();
                let all_sendable = {
                    let queue = self.inner.queue.lock().await;
                    batch.iter().all(|(row, _)| {
                        queue.contains(&row.event_id, row.consent_epoch, sendable_now)
                    })
                };
                if !all_sendable || !self.inner.enabled.load(Ordering::SeqCst) {
                    break;
                }

                let wire_events: Vec<AnalyticsEventEnvelope> =
                    batch.iter().map(|(_, envelope)| envelope.clone()).collect();
                let prepared = prepare_batch(&wire_events)?;
                let members: Vec<PendingBatchMember> = batch
                    .iter()
                    .map(|(row, _)| PendingBatchMember {
                        event_id: row.event_id.clone(),
                        consent_epoch: row.consent_epoch,
                    })
                    .collect();
                let attempt_count = batch
                    .iter()
                    .map(|(row, _)| row.attempt_count)
                    .max()
                    .unwrap_or(0);
                let expires_at_ms = batch
                    .iter()
                    .map(|(row, _)| row.expires_at)
                    .min()
                    .unwrap_or(sendable_now);

                let generation = {
                    let mut pending = self.inner.pending_batch.lock().await;
                    if pending.is_some() {
                        continue;
                    }
                    if !self.inner.enabled.load(Ordering::SeqCst) {
                        break;
                    }
                    let generation = self
                        .inner
                        .pending_batch_generation
                        .fetch_add(1, Ordering::SeqCst)
                        + 1;
                    *pending = Some(PendingDeliveryBatch {
                        generation,
                        prepared: prepared.clone(),
                        members: members.clone(),
                        attempt_count,
                        retry_at_ms: sendable_now,
                        expires_at_ms,
                    });
                    generation
                };
                (prepared, generation, members, attempt_count)
            };

            let sendable_now = store::now_millis();
            let all_sendable = {
                let queue = self.inner.queue.lock().await;
                members.iter().all(|member| {
                    queue.contains(&member.event_id, member.consent_epoch, sendable_now)
                })
            };
            if !all_sendable || !self.inner.enabled.load(Ordering::SeqCst) {
                self.inner.discard_pending_batch(generation, &members).await;
                continue;
            }

            match transport.send_batch(&prepared).await {
                SendOutcome::Accepted => {
                    {
                        let mut queue = self.inner.queue.lock().await;
                        for (member, envelope) in members.iter().zip(&prepared.events) {
                            queue.remove(&member.event_id);
                            // Health reports describe the product-event counters.
                            // Counting their own delivery makes those counters
                            // self-referential.
                            if envelope.event_name != "analytics.health_reported" {
                                self.inner.counters.accepted.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                    }
                    self.inner.clear_pending_batch_if(generation).await;
                    continue;
                }
                SendOutcome::ConfigurationFailure { reason } => {
                    let next = store::now_millis() + CONFIG_RETRY_MS;
                    if self.inner.clear_pending_batch_if(generation).await {
                        let mut queue = self.inner.queue.lock().await;
                        for member in &members {
                            queue.reschedule(&member.event_id, next);
                        }
                    }
                    self.inner
                        .counters
                        .send_failure
                        .fetch_add(members.len() as u64, Ordering::Relaxed);
                    log::warn!(target: "analytics", "analytics send paused: {reason}");
                    break;
                }
                SendOutcome::RetryAfter { delay_ms } => {
                    let next = store::now_millis() + delay_ms;
                    if self
                        .inner
                        .reschedule_pending_batch(generation, &members, next, attempt_count)
                        .await
                    {
                        let mut queue = self.inner.queue.lock().await;
                        for member in &members {
                            queue.reschedule(&member.event_id, next);
                        }
                    }
                    self.inner
                        .counters
                        .send_failure
                        .fetch_add(members.len() as u64, Ordering::Relaxed);
                    break;
                }
                SendOutcome::Retry { reason } => {
                    let next = store::now_millis() + backoff_ms(attempt_count);
                    if self
                        .inner
                        .reschedule_pending_batch(generation, &members, next, attempt_count)
                        .await
                    {
                        let mut queue = self.inner.queue.lock().await;
                        for member in &members {
                            queue.reschedule(&member.event_id, next);
                        }
                    }
                    self.inner
                        .counters
                        .send_failure
                        .fetch_add(members.len() as u64, Ordering::Relaxed);
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

    async fn drop_corrupt_row(&self, row: &QueuedEvent, reason: String) -> Result<(), String> {
        self.inner.counters.rejected.fetch_add(1, Ordering::Relaxed);
        log::debug!(target: "analytics", "local permanent rejection: {reason}");
        if row.event_name == "analytics.session_started" {
            let session_id = queue::session_id_from_payload(&row.payload_json);
            self.inner.abandon_session(session_id.as_deref()).await?;
        } else {
            self.inner.queue.lock().await.remove(&row.event_id);
        }
        Ok(())
    }
}

impl AnalyticsRuntimeInner {
    /// Commits a group through the bounded in-memory queue. `primary_event_id`
    /// is the id of the event the caller submitted.
    async fn commit_inserts(
        &self,
        inserts: Vec<QueueInsert>,
        pending: PendingUpdate,
        primary_event_id: Option<String>,
        operation_id: Option<&str>,
    ) -> AnalyticsSubmitResult {
        let _state = self.state_lock.lock().await;
        if let Some(operation_id) = operation_id {
            let Some((_, epoch, _)) = self.operations.lock().await.get(operation_id) else {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Rejected,
                    "stale_operation",
                );
            };
            if inserts.iter().any(|insert| insert.consent_epoch != epoch) {
                return AnalyticsSubmitResult::new(AnalyticsSubmitStatus::StaleEpoch);
            }
        }
        self.enqueue_inserts(inserts, pending, primary_event_id)
            .await
    }

    /// Caller holds writer ownership and ingress admission through this commit.
    async fn enqueue_inserts(
        &self,
        inserts: Vec<QueueInsert>,
        pending: PendingUpdate,
        primary_event_id: Option<String>,
    ) -> AnalyticsSubmitResult {
        let Some(consent_epoch) = inserts.first().map(|insert| insert.consent_epoch) else {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Error,
                "empty_analytics_batch",
            );
        };
        if inserts
            .iter()
            .any(|insert| insert.consent_epoch != consent_epoch)
        {
            return AnalyticsSubmitResult::with_reason(
                AnalyticsSubmitStatus::Error,
                "mixed_consent_epoch",
            );
        }
        let marks_first_success = inserts.iter().any(|insert| insert.marks_first_success);
        let event_ids: Vec<String> = inserts
            .iter()
            .map(|insert| insert.event_id.clone())
            .collect();
        let (outcome, _ignored) = {
            let mut queue = self.queue.lock().await;
            queue.enqueue_batch(inserts, store::now_millis())
        };
        match outcome {
            EnqueueOutcome::Queued => {}
            EnqueueOutcome::Unavailable => {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Unavailable,
                    "queue_full",
                )
            }
            EnqueueOutcome::Rejected => {
                return AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Rejected,
                    "payload_too_large",
                )
            }
        }

        match store::apply_delivery_metadata(
            self.database.pool(),
            consent_epoch,
            marks_first_success,
            &pending,
        )
        .await
        {
            Ok(MetadataOutcome::Applied) => {
                self.notify.notify_one();
                AnalyticsSubmitResult {
                    status: AnalyticsSubmitStatus::Queued,
                    event_id: primary_event_id,
                    reason: None,
                }
            }
            Ok(MetadataOutcome::Disabled) => {
                self.remove_queued_events(&event_ids).await;
                AnalyticsSubmitResult::new(AnalyticsSubmitStatus::Disabled)
            }
            Ok(MetadataOutcome::StaleEpoch) => {
                self.remove_queued_events(&event_ids).await;
                AnalyticsSubmitResult::new(AnalyticsSubmitStatus::StaleEpoch)
            }
            Ok(MetadataOutcome::PendingChanged) => {
                self.remove_queued_events(&event_ids).await;
                AnalyticsSubmitResult::with_reason(
                    AnalyticsSubmitStatus::Deduplicated,
                    "pending_update_changed",
                )
            }
            Err(error) => {
                self.remove_queued_events(&event_ids).await;
                AnalyticsSubmitResult::with_reason(AnalyticsSubmitStatus::Error, error)
            }
        }
    }

    async fn remove_queued_events(&self, event_ids: &[String]) {
        let mut queue = self.queue.lock().await;
        for event_id in event_ids {
            queue.remove(event_id);
        }
    }

    /// Persists a passive native event with no caller-derived session or
    /// timestamp. Used for process lifecycle and health facts.
    async fn persist_native_event(
        &self,
        state: &AnalyticsStateRow,
        event_name: &str,
        attributes: JsonMap<String, JsonValue>,
        operation_id: Option<&str>,
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
        self.commit_inserts(
            vec![insert],
            PendingUpdate::Unchanged,
            event_id,
            operation_id,
        )
        .await
    }

    /// Emits `app.started` at most once for this process, and only when the
    /// stored state is enabled and the deployment was deliverable at init.
    async fn emit_app_started(&self, state: &AnalyticsStateRow) -> Result<(), String> {
        if state.status != "enabled" || !self.build_eligible || !self.transport_ready {
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
            .persist_native_event(state, "app.started", attributes, None)
            .await;
        if result.status == AnalyticsSubmitStatus::Queued {
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
        if self.config.is_none()
            || !self.build_eligible
            || !self.transport_ready
            || !self.enabled.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        let state = store::load_state(self.database.pool())
            .await?
            .ok_or_else(|| "analytics_state_missing".to_string())?;
        if state.status != "enabled" {
            return Ok(());
        }
        let (queue_depth, _) = self.queue.lock().await.stats();
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
            .persist_native_event(&state, "analytics.health_reported", attributes, None)
            .await
            .status
        {
            AnalyticsSubmitStatus::Queued
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

    async fn invalidate_pending_batch(&self) {
        let mut pending = self.pending_batch.lock().await;
        self.pending_batch_generation.fetch_add(1, Ordering::SeqCst);
        *pending = None;
    }

    async fn clear_pending_batch_if(&self, generation: u64) -> bool {
        let mut pending = self.pending_batch.lock().await;
        if pending
            .as_ref()
            .is_none_or(|batch| batch.generation != generation)
        {
            return false;
        }
        self.pending_batch_generation.fetch_add(1, Ordering::SeqCst);
        *pending = None;
        true
    }

    async fn reschedule_pending_batch(
        &self,
        generation: u64,
        _members: &[PendingBatchMember],
        next_attempt_at: i64,
        attempt_count: i64,
    ) -> bool {
        let mut pending = self.pending_batch.lock().await;
        let Some(batch) = pending
            .as_mut()
            .filter(|batch| batch.generation == generation)
        else {
            return false;
        };
        batch.retry_at_ms = next_attempt_at;
        batch.attempt_count = attempt_count.saturating_add(1);
        true
    }

    async fn discard_pending_batch(&self, generation: u64, members: &[PendingBatchMember]) {
        if !self.clear_pending_batch_if(generation).await {
            return;
        }
        let mut queue = self.queue.lock().await;
        for member in members {
            queue.remove(&member.event_id);
        }
    }

    /// Imports can adopt consent through the shared database transaction. Retire
    /// native bindings when the durable epoch moves before collecting or sending.
    /// Caller holds the writer lock.
    async fn refresh_state(&self, row: &AnalyticsStateRow) {
        let enabled = row.status == "enabled";
        let previous_enabled = self.enabled.load(Ordering::SeqCst);
        let previous_epoch = self.consent_epoch.load(Ordering::SeqCst);
        if enabled != previous_enabled || row.consent_epoch != previous_epoch {
            self.consent_changed_at_ms
                .store(store::now_millis(), Ordering::SeqCst);
        }
        if !enabled || row.consent_epoch != previous_epoch {
            self.queue.lock().await.clear();
            self.invalidate_pending_batch().await;
            self.clear_session().await;
        }
        self.apply_state(row);
    }

    async fn clear_session(&self) {
        *self.session.lock().await = None;
        self.operations.lock().await.clear();
        self.exposures.lock().await.clear();
    }

    /// Releases an abandoned session's active binding while preserving a later
    /// session that another operation already opened.
    async fn release_session_if(&self, session_id: &str) {
        let mut guard = self.session.lock().await;
        if guard.as_ref().map(|session| session.id.as_str()) == Some(session_id) {
            *guard = None;
        }
    }

    /// Fail-closed cleanup after the receiver permanently rejected a session
    /// start. Its queued rows, handles and in-memory binding are revoked under
    /// the same writer lock, so no concurrent ingress can reintroduce the reference.
    async fn abandon_session(&self, session_id: Option<&str>) -> Result<(), String> {
        let _state = self.state_lock.lock().await;
        let dropped = match session_id {
            Some(session_id) => self.queue.lock().await.drop_session(session_id),
            // If corruption lost the binding, no queued session can be proven
            // independent. Clear pending work rather than send possible orphans.
            None => {
                let mut queue = self.queue.lock().await;
                let dropped = queue.stats().0 as u64;
                queue.clear();
                self.invalidate_pending_batch().await;
                self.clear_session().await;
                dropped
            }
        };
        if let Some(session_id) = session_id {
            self.operations.lock().await.remove_session(session_id);
            self.release_session_if(session_id).await;
        }
        log::warn!(
            target: "analytics",
            "abandoned a rejected analytics session rows={dropped}"
        );
        Ok(())
    }

    /// Caller holds the writer lock so expiry and native revocation cannot race
    /// with an event capturing the session.
    async fn purge_expired_sessions(&self, now: i64) -> Result<(), String> {
        let abandoned = self.queue.lock().await.purge_expired(now);
        for session_id in abandoned {
            match session_id {
                Some(session_id) => {
                    self.operations.lock().await.remove_session(&session_id);
                    self.release_session_if(&session_id).await;
                }
                None => self.clear_session().await,
            }
        }
        Ok(())
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
                // Do not publish a provisional id; cancellation or a failed
                // commit must not leave a session with no durable start.
                let id = uuid::Uuid::new_v4().to_string();
                return (Some(id), true);
            }
            if let Some(session) = guard.as_mut() {
                session.last_activity = now;
            }
        }
        (guard.as_ref().map(|session| session.id.clone()), false)
    }

    /// Admits the first interaction for an operation that captured a session at
    /// action start. If the still-current session has crossed the idle boundary,
    /// return a fresh provisional id; otherwise refresh the original session.
    async fn admit_operation_interaction(
        &self,
        captured_session_id: String,
    ) -> (Option<String>, bool) {
        let mut guard = self.session.lock().await;
        let Some(current) = guard.as_mut() else {
            return (Some(captured_session_id), false);
        };
        if current.id != captured_session_id {
            return (Some(captured_session_id), false);
        }
        let now = Instant::now();
        if now.duration_since(current.last_activity) > SESSION_IDLE {
            return (Some(uuid::Uuid::new_v4().to_string()), true);
        }
        current.last_activity = now;
        (Some(captured_session_id), false)
    }

    /// Builds the native `analytics.session_started` row for a new session,
    /// carrying the first-observed/first-success metadata from stored state.
    fn build_session_started_insert(
        &self,
        state: &AnalyticsStateRow,
        session_id: &str,
        consent_epoch: i64,
        occurred_at_ms: i64,
    ) -> Result<QueueInsert, String> {
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
    ) -> Result<QueueInsert, String> {
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
        let (queue_depth, pending_bytes) = self.queue.lock().await.stats();
        let (status, consent_epoch) = if self.config.is_none() {
            (AnalyticsConsentStatus::Uninitialized, 0)
        } else {
            match store::load_state(self.database.pool()).await? {
                Some(row) => (
                    AnalyticsConsentStatus::from_db(&row.status),
                    row.consent_epoch,
                ),
                None => (AnalyticsConsentStatus::Uninitialized, 0),
            }
        };
        Ok(AnalyticsState {
            status,
            consent_epoch,
            queue_depth,
            pending_bytes,
            build_eligible: self.build_eligible,
            transport_ready: self.transport_ready,
        })
    }

    /// On a native start, either confirm the restart that followed a successful
    /// install handoff (enqueuing `restart_confirmed` and clearing the pending
    /// metadata in one transaction) or discard stale metadata. A restored backup,
    /// an unfinished update, a missing operation id and a changed consent epoch
    /// all fail the match and are never turned into a false confirmation.
    async fn resolve_restart_confirmation(
        &self,
        row: &AnalyticsStateRow,
        app_version: &str,
    ) -> Result<(), String> {
        let Some(pending_json) = &row.pending_update_json else {
            return Ok(());
        };
        // Nothing is queued while this deployment cannot deliver, so the pending
        // handoff is kept for a later provisioned start instead of being turned
        // into a confirmation that could never be sent.
        if !self.transport_ready {
            return Ok(());
        }
        // Turning sharing off must not consume a handoff that was recorded while
        // it was on. Re-enabling can then resolve that handoff on a later start.
        if row.status != "enabled" {
            return Ok(());
        }
        let confirmation = parse_pending_update(pending_json).and_then(|pending| {
            let operation_id = pending.operation_id.clone()?;
            let matches = pending.to_version == app_version
                && pending.from_version.as_deref() != Some(app_version)
                && pending.consent_epoch == row.consent_epoch;
            matches.then_some((pending, operation_id))
        });
        let Some((pending, operation_id)) = confirmation else {
            return store::clear_pending_update(self.database.pool(), pending_json).await;
        };
        let mut attributes = JsonMap::new();
        attributes.insert(
            "update_operation_id".to_string(),
            JsonValue::String(operation_id),
        );
        attributes.insert(
            "phase".to_string(),
            JsonValue::String("restart_confirmed".to_string()),
        );
        if let Some(from_version) = pending
            .from_version
            .as_deref()
            .filter(|value| events::is_version_shaped(value))
        {
            attributes.insert(
                "from_version".to_string(),
                JsonValue::String(from_version.to_string()),
            );
        }
        if events::is_version_shaped(&pending.to_version) {
            attributes.insert(
                "to_version".to_string(),
                JsonValue::String(pending.to_version.clone()),
            );
        }
        attributes.insert(
            "result".to_string(),
            JsonValue::String("success".to_string()),
        );
        attributes.insert(
            "source".to_string(),
            JsonValue::String(normalize_update_source(pending.source.as_deref()).to_string()),
        );
        let request = AnalyticsTrackRequest {
            event_name: "app.update_transition".to_string(),
            occurred_at_ms: store::now_millis(),
            operation_id: None,
            attributes,
        };
        let insert = self.build_event_insert(row, None, row.consent_epoch, &request, false)?;
        // Queued clears the pending metadata after the event enters the memory
        // queue. Any other outcome leaves it in place for the next start.
        let result = self
            .enqueue_inserts(
                vec![insert],
                PendingUpdate::Confirm(pending_json.clone()),
                None,
            )
            .await;
        match result.status {
            AnalyticsSubmitStatus::Queued => Ok(()),
            // A queue-full start and a concurrent resolver both leave the stored
            // handoff intact for a later attempt.
            AnalyticsSubmitStatus::Unavailable
            | AnalyticsSubmitStatus::Deduplicated
            | AnalyticsSubmitStatus::Disabled => Ok(()),
            AnalyticsSubmitStatus::StaleEpoch
            | AnalyticsSubmitStatus::Rejected
            | AnalyticsSubmitStatus::Error => Err(result
                .reason
                .unwrap_or_else(|| format!("restart_confirmation_{:?}", result.status))),
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
) -> Result<QueueInsert, String> {
    let event_id = envelope.event_id.clone();
    let payload_json = serde_json::to_string(&envelope).map_err(|error| error.to_string())?;
    Ok(QueueInsert {
        event_id,
        consent_epoch,
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

#[derive(Debug, Clone)]
struct InstallHandoffVersions {
    from_version: Option<String>,
    to_version: String,
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
    if json.len() > PENDING_UPDATE_MAX_BYTES {
        return None;
    }
    let pending: PendingUpdateMeta = serde_json::from_str(json).ok()?;
    // Pending metadata may retain a valid long SemVer that cannot fit in the
    // public wire attribute. A restored or hand-edited row is still bounded and
    // shape-checked before it can influence a confirmation.
    if !events::is_pending_version_shaped(&pending.to_version) {
        return None;
    }
    if let Some(from_version) = &pending.from_version {
        if !events::is_pending_version_shaped(from_version) {
            return None;
        }
    }
    if let Some(operation_id) = &pending.operation_id {
        if !events::is_canonical_uuid(operation_id) {
            return None;
        }
    }
    Some(pending)
}

/// The registry accepts only `background`, `user` or `other` as the update
/// source, so stored metadata is normalized instead of trusted verbatim.
fn normalize_update_source(source: Option<&str>) -> &'static str {
    match source {
        Some("background") => "background",
        Some("user") => "user",
        _ => "other",
    }
}

/// Builds the bounded pending metadata for an `install_handoff` transition that
/// succeeded. `None` for every other transition, so nothing else writes it.
fn install_handoff_pending(
    request: &AnalyticsTrackRequest,
    consent_epoch: i64,
    authoritative_versions: Option<(&str, Option<&str>)>,
) -> Option<String> {
    if request.event_name != "app.update_transition" {
        return None;
    }
    if request.attributes.get("phase").and_then(JsonValue::as_str) != Some("install_handoff") {
        return None;
    }
    if request.attributes.get("result").and_then(JsonValue::as_str) != Some("success") {
        return None;
    }
    let (to_version, from_version) = match authoritative_versions {
        Some((to_version, from_version)) => (to_version, from_version),
        None => (
            request
                .attributes
                .get("to_version")
                .and_then(JsonValue::as_str)?,
            request
                .attributes
                .get("from_version")
                .and_then(JsonValue::as_str),
        ),
    };
    if !events::is_pending_version_shaped(to_version) {
        return None;
    }
    let from_version = from_version.filter(|value| events::is_pending_version_shaped(value));
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
    if let Some(value) = from_version {
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

fn resolve_analytics_config(
    analytics: &ProductAnalytics,
    build_eligible: bool,
) -> Option<AnalyticsConfig> {
    if analytics.protocol_version != ANALYTICS_PROTOCOL_VERSION {
        return None;
    }
    // Release eligibility is a build property; the deployment default only
    // participates in an eligible build. Nothing here is a persisted user choice.
    let transport: Option<Arc<dyn EventSender>> =
        if build_eligible && analytics.is_transport_ready() {
            analytics
                .batch_url()
                .ok()
                .and_then(|batch_url| {
                    AnalyticsTransport::new(batch_url, analytics.project_id.trim().to_string()).ok()
                })
                .map(|transport| Arc::new(transport) as Arc<dyn EventSender>)
        } else {
            None
        };
    // The derived default only turns collection on once this build can actually
    // deliver. It is a non-explicit value, so real provisioning re-derives it
    // later without overwriting an explicit user choice, and a community build
    // never queues events that a later official build would flush.
    let default_enabled = build_eligible && analytics.default_enabled && transport.is_some();
    // Bind the queue to one deployment target. The same official build always
    // resolves the same key; a community/self build that points at its own
    // endpoint (or one with no project id) resolves a different key, so its
    // queued rows are cleared before they could flush through another target.
    let deployment_key = if build_eligible && analytics.is_transport_ready() {
        analytics
            .batch_url()
            .map(|batch_url| format!("{batch_url}|{}", analytics.project_id.trim()))
            .unwrap_or_default()
    } else {
        String::new()
    };
    Some(AnalyticsConfig {
        policy_version: POLICY_VERSION,
        default_enabled,
        build_eligible,
        transport,
        deployment_key,
    })
}

fn resolve_config_for_environment(environment: AnalyticsEnvironment) -> Option<AnalyticsConfig> {
    if environment.suppresses_collection() {
        return None;
    }
    let config = product_config().ok()?;
    config
        .services
        .analytics
        .as_ref()
        .and_then(|analytics| resolve_analytics_config(analytics, !cfg!(debug_assertions)))
}

fn resolve_config() -> Option<AnalyticsConfig> {
    resolve_config_for_environment(AnalyticsEnvironment::current())
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
            true,
        )
        .await
    }

    async fn initialize_with_sender_and_startup_for_tests(
        database: DatabaseRuntime,
        sender: Option<Arc<dyn EventSender>>,
        default_enabled: bool,
        startup_source: &str,
        started_at: Instant,
        build_eligible: bool,
    ) -> Result<Self, String> {
        let config = AnalyticsConfig {
            policy_version: POLICY_VERSION,
            default_enabled,
            build_eligible,
            transport: sender,
            deployment_key: String::new(),
        };
        let run_id = uuid::Uuid::new_v4().to_string();
        let startup_source = normalize_startup_source(startup_source);
        let runtime = Self {
            inner: Arc::new(AnalyticsRuntimeInner {
                database,
                transport_ready: config.transport.is_some(),
                build_eligible: config.build_eligible,
                config: Some(config),
                enabled: AtomicBool::new(false),
                consent_epoch: AtomicI64::new(0),
                consent_changed_at_ms: AtomicI64::new(0),
                session: Mutex::new(None),
                operations: Mutex::new(OperationRegistry::default()),
                exposures: Mutex::new(HashSet::new()),
                queue: Mutex::new(AnalyticsQueue::default()),
                pending_batch: Mutex::new(None),
                pending_batch_generation: AtomicU64::new(0),
                state_lock: Mutex::new(()),
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

    async fn age_session_for_tests(&self, idle: Duration) {
        if let Some(session) = self.inner.session.lock().await.as_mut() {
            session.last_activity = Instant::now()
                .checked_sub(idle)
                .expect("test idle duration fits the monotonic clock");
        }
    }

    /// Every persisted envelope, oldest first, for asserting session binding.
    async fn outbox_payloads_for_tests(&self) -> Vec<AnalyticsEventEnvelope> {
        self.inner
            .queue
            .lock()
            .await
            .events_for_tests()
            .iter()
            .map(|event| serde_json::from_str(&event.payload_json).expect("envelope"))
            .collect()
    }

    async fn clear_outbox_for_tests(&self) {
        self.inner.queue.lock().await.clear();
        self.inner.invalidate_pending_batch().await;
    }

    async fn queue_depth_for_tests(&self) -> i64 {
        self.inner.queue.lock().await.stats().0
    }

    async fn enqueue_for_tests(&self, insert: QueueInsert) -> EnqueueOutcome {
        self.inner
            .queue
            .lock()
            .await
            .enqueue_batch(vec![insert], store::now_millis())
            .0
    }

    async fn set_queue_next_attempt_for_tests(&self, event_name: &str, next: i64) {
        self.inner
            .queue
            .lock()
            .await
            .set_next_attempt_for_event_name(event_name, next);
    }

    async fn set_all_queue_next_attempts_for_tests(&self, next: i64) {
        self.inner.queue.lock().await.set_all_next_attempts(next);
        if let Some(pending) = self.inner.pending_batch.lock().await.as_mut() {
            pending.retry_at_ms = next;
        }
    }

    async fn expire_session_starts_for_tests(&self) {
        self.inner.queue.lock().await.expire_session_starts();
    }

    async fn corrupt_session_start_for_tests(&self) {
        self.inner
            .queue
            .lock()
            .await
            .corrupt_session_start_for_tests();
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

    fn outbox_insert(event_id: &str) -> QueueInsert {
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
        QueueInsert {
            event_id: event_id.to_string(),
            consent_epoch: 0,
            event_name: "app.started".to_string(),
            payload_json: serde_json::to_string(&envelope).expect("encode envelope"),
            priority: 100,
            marks_first_success: false,
        }
    }

    fn poison_insert(event_id: &str) -> QueueInsert {
        QueueInsert {
            event_id: event_id.to_string(),
            consent_epoch: 0,
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

    #[test]
    fn user_gets_no_analytics_configuration_when_ci_runs_the_app() {
        let environment = AnalyticsEnvironment {
            ci: true,
            ..AnalyticsEnvironment::default()
        };

        assert!(resolve_config_for_environment(environment).is_none());
    }

    #[test]
    fn user_gets_protocol_two_analytics_transport_resolved_and_protocol_one_rejected() {
        let mut analytics = ProductAnalytics {
            base_url: "https://analytics.touch-ai.org/touchai-app/v1".to_string(),
            protocol_version: ANALYTICS_PROTOCOL_VERSION,
            project_id: "8b6c4a1e-2f5d-4c9a-9b7e-1d3f5a7c9e2b".to_string(),
            default_enabled: true,
        };

        let config = resolve_analytics_config(&analytics, true).expect("protocol two transport");
        assert!(config.transport.is_some());
        assert!(!config.deployment_key.is_empty());
        assert!(config.build_eligible);

        let ineligible =
            resolve_analytics_config(&analytics, false).expect("ineligible build config");
        assert!(ineligible.transport.is_none());
        assert!(!ineligible.build_eligible);

        analytics.protocol_version = 1;
        assert!(resolve_analytics_config(&analytics, true).is_none());
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
        fn send_batch<'a>(
            &'a self,
            _batch: &'a PreparedAnalyticsBatch,
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
            assert_eq!(
                runtime
                    .enqueue_for_tests(outbox_insert(&format!("e{index}")))
                    .await,
                EnqueueOutcome::Queued
            );
        }

        let (first, second) = tokio::join!(runtime.flush_once(), runtime.flush_once());
        first.expect("first flush");
        second.expect("second flush");

        assert_eq!(probe.max_active.load(Ordering::SeqCst), 1);
        assert_eq!(
            probe.sends.load(Ordering::SeqCst),
            1,
            "four due events share one batch"
        );
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
    }

    #[tokio::test]
    async fn user_gets_a_delivered_event_removed_and_never_resent() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe.clone()).await;
        assert_eq!(
            runtime.enqueue_for_tests(outbox_insert("e1")).await,
            EnqueueOutcome::Queued
        );

        runtime.flush_once().await.expect("flush");
        assert_eq!(runtime.queue_depth_for_tests().await, 0);

        runtime.flush_once().await.expect("flush again");
        assert_eq!(probe.sends.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn user_keeps_an_event_when_the_sender_reports_a_configuration_fault() {
        let probe = Arc::new(Probe::new(|| SendOutcome::ConfigurationFailure {
            reason: "bot_rejected".to_string(),
        }));
        let (_root, runtime) = test_runtime(probe).await;
        assert_eq!(
            runtime.enqueue_for_tests(outbox_insert("e1")).await,
            EnqueueOutcome::Queued
        );

        runtime.flush_once().await.expect("flush");

        assert_eq!(
            runtime.queue_depth_for_tests().await,
            1,
            "a bot rejection must not discard the event"
        );
    }

    #[tokio::test]
    async fn user_gets_a_poison_row_dropped_without_a_transport_call() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe.clone()).await;
        assert_eq!(
            runtime.enqueue_for_tests(poison_insert("poison")).await,
            EnqueueOutcome::Queued
        );

        runtime.flush_once().await.expect("flush");

        assert_eq!(probe.sends.load(Ordering::SeqCst), 0);
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
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
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
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
            true,
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
    async fn user_gets_no_collection_from_a_development_build_even_with_stored_consent() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_and_startup_for_tests(
            database,
            Some(probe.clone()),
            true,
            "foreground",
            Instant::now(),
            false,
        )
        .await
        .expect("runtime");

        let state = runtime.state().await.expect("state");
        assert_eq!(state.status, AnalyticsConsentStatus::Enabled);
        assert!(!state.build_eligible);
        assert!(runtime.outbox_payloads_for_tests().await.is_empty());

        let operation = runtime.begin_operation().await;
        assert!(!operation.enabled);
        assert!(operation.operation_id.is_empty());

        let result = runtime
            .track(track_request("product.surface_opened", JsonMap::new()))
            .await;
        assert_eq!(result.status, AnalyticsSubmitStatus::Unavailable);
        assert_eq!(result.reason.as_deref(), Some("development_build"));

        runtime.flush().await.expect("flush");
        assert_eq!(probe.sends.load(Ordering::SeqCst), 0);
        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
    }

    #[tokio::test]
    async fn user_can_withdraw_sharing_in_an_ineligible_build_without_enabling_it() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_and_startup_for_tests(
            database,
            Some(probe),
            true,
            "foreground",
            Instant::now(),
            false,
        )
        .await
        .expect("runtime");

        let enabled = runtime.state().await.expect("enabled state");
        assert_eq!(enabled.status, AnalyticsConsentStatus::Enabled);
        assert!(!enabled.build_eligible);

        let disabled = runtime
            .set_enabled(false, enabled.consent_epoch)
            .await
            .expect("withdraw consent");
        assert_eq!(disabled.status, AnalyticsConsentStatus::Disabled);
        assert_eq!(disabled.consent_epoch, enabled.consent_epoch + 1);
        assert!(!disabled.build_eligible);

        let still_disabled = runtime
            .set_enabled(true, disabled.consent_epoch)
            .await
            .expect("enable attempt");
        assert_eq!(still_disabled.status, AnalyticsConsentStatus::Disabled);
        assert_eq!(still_disabled.consent_epoch, disabled.consent_epoch);
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
    async fn user_can_withdraw_sharing_when_transport_is_not_ready_without_enabling_it() {
        let (_root, database) = test_database().await;
        let runtime = AnalyticsRuntime::initialize_with_sender_for_tests(database, None, true)
            .await
            .expect("runtime");

        let enabled = runtime.state().await.expect("enabled state");
        assert_eq!(enabled.status, AnalyticsConsentStatus::Enabled);
        assert!(!enabled.transport_ready);

        let disabled = runtime
            .set_enabled(false, enabled.consent_epoch)
            .await
            .expect("withdraw consent");
        assert_eq!(disabled.status, AnalyticsConsentStatus::Disabled);
        assert_eq!(disabled.consent_epoch, enabled.consent_epoch + 1);
        assert!(!disabled.transport_ready);

        let still_disabled = runtime
            .set_enabled(true, disabled.consent_epoch)
            .await
            .expect("enable attempt");
        assert_eq!(still_disabled.status, AnalyticsConsentStatus::Disabled);
        assert_eq!(still_disabled.consent_epoch, disabled.consent_epoch);
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
            true,
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
        assert_eq!(result.status, AnalyticsSubmitStatus::Queued);
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
            true,
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
        assert_eq!(completed.status, AnalyticsSubmitStatus::Queued);
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
        assert_eq!(
            runtime.enqueue_for_tests(outbox_insert("delivered")).await,
            EnqueueOutcome::Queued
        );
        runtime.flush_once().await.expect("flush delivered");
        assert_eq!(
            runtime.enqueue_for_tests(outbox_insert("queued")).await,
            EnqueueOutcome::Queued
        );

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
        assert_eq!(
            runtime.enqueue_for_tests(outbox_insert("delivered")).await,
            EnqueueOutcome::Queued
        );
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
        assert_eq!(passive.status, AnalyticsSubmitStatus::Queued);
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
        assert_eq!(interaction.status, AnalyticsSubmitStatus::Queued);
        assert!(
            runtime.session_id_for_tests().await.is_some(),
            "a real interaction starts a session"
        );
    }

    #[tokio::test]
    async fn user_does_not_wait_for_analytics_while_another_event_is_being_saved() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        let writer = runtime.inner.state_lock.lock().await;

        let operation = runtime
            .begin_operation_with_timeout(Duration::from_millis(20))
            .await;

        assert!(operation.is_none());
        drop(writer);
        assert!(runtime
            .begin_operation_with_timeout(Duration::from_millis(20))
            .await
            .is_some());
    }

    #[tokio::test]
    async fn user_keeps_a_completion_on_its_original_session_when_another_window_opens_a_later_one()
    {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        let handle = runtime.begin_operation().await;
        let submitted = runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(submitted.status, AnalyticsSubmitStatus::Queued);
        let original = runtime
            .session_id_for_tests()
            .await
            .expect("submitting starts a session");

        // Another window opens a later session before the completion arrives.
        runtime
            .force_session_for_tests("11111111-1111-4111-8111-111111111111")
            .await;
        let completed = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(completed.status, AnalyticsSubmitStatus::Queued);

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
        assert_eq!(first.status, AnalyticsSubmitStatus::Queued);

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

    #[tokio::test]
    async fn user_gets_no_telemetry_when_sharing_turns_on_after_the_action_starts() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        runtime.set_enabled(false, 0).await.expect("disable");
        let started_at_ms = store::now_millis();
        // The native begin command is delayed until after the user has enabled
        // sharing again. The action-start timestamp still proves it began
        // during the disabled generation.
        runtime.set_enabled(true, 1).await.expect("enable");

        let operation = runtime.begin_operation_at(started_at_ms).await;
        assert!(
            operation.operation_id.is_empty(),
            "a stale start must not receive a bindable handle"
        );
        assert!(!operation.enabled);

        let result = runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &operation.operation_id,
            ))
            .await;
        assert_eq!(result.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(result.reason.as_deref(), Some("stale_operation"));
        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
        assert!(runtime.session_id_for_tests().await.is_none());
    }

    #[tokio::test]
    async fn user_gets_a_fresh_session_after_idle_while_the_old_completion_keeps_its_original_session(
    ) {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        let old_operation = runtime.begin_operation().await;
        let submitted = runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &old_operation.operation_id,
            ))
            .await;
        assert_eq!(submitted.status, AnalyticsSubmitStatus::Queued);
        let old_session = runtime.session_id_for_tests().await.expect("old session");

        // The second real action captures the old session while it is still
        // active, then the session crosses the idle boundary before its first
        // interaction is admitted.
        let new_operation = runtime.begin_operation().await;
        runtime
            .age_session_for_tests(Duration::from_secs(30 * 60 + 1))
            .await;

        let surface = runtime
            .track(with_operation(
                track_request(
                    "product.surface_opened",
                    JsonMap::from_iter([(
                        "surface".to_string(),
                        JsonValue::String("main".to_string()),
                    )]),
                ),
                &new_operation.operation_id,
            ))
            .await;
        assert_eq!(surface.status, AnalyticsSubmitStatus::Queued);
        let new_session = runtime.session_id_for_tests().await.expect("new session");
        assert_ne!(new_session, old_session);

        let completed = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &old_operation.operation_id,
            ))
            .await;
        assert_eq!(completed.status, AnalyticsSubmitStatus::Queued);

        let envelopes = runtime.outbox_payloads_for_tests().await;
        let surface_event = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "product.surface_opened")
            .expect("surface event");
        assert_eq!(
            surface_event.analytics_session_id.as_deref(),
            Some(new_session.as_str())
        );
        let completion = envelopes
            .iter()
            .find(|envelope| envelope.event_name == "agent.request_completed")
            .expect("completion");
        assert_eq!(
            completion.analytics_session_id.as_deref(),
            Some(old_session.as_str()),
            "an already-bound operation keeps its original completion session"
        );
    }

    #[tokio::test]
    async fn user_keeps_the_same_session_when_interactions_stay_inside_the_idle_window() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        let first_operation = runtime.begin_operation().await;
        let first = runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &first_operation.operation_id,
            ))
            .await;
        assert_eq!(first.status, AnalyticsSubmitStatus::Queued);
        let session = runtime.session_id_for_tests().await.expect("session");

        runtime
            .age_session_for_tests(Duration::from_secs(29 * 60))
            .await;
        let second_operation = runtime.begin_operation().await;
        let second = runtime
            .track(with_operation(
                track_request(
                    "product.surface_opened",
                    JsonMap::from_iter([(
                        "surface".to_string(),
                        JsonValue::String("main".to_string()),
                    )]),
                ),
                &second_operation.operation_id,
            ))
            .await;
        assert_eq!(second.status, AnalyticsSubmitStatus::Queued);
        assert_eq!(
            runtime.session_id_for_tests().await.as_deref(),
            Some(session.as_str()),
            "an interaction inside the idle window refreshes rather than reopens the session"
        );

        runtime
            .age_session_for_tests(Duration::from_secs(2 * 60))
            .await;
        let third_operation = runtime.begin_operation().await;
        let third = runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &third_operation.operation_id,
            ))
            .await;
        assert_eq!(third.status, AnalyticsSubmitStatus::Queued);
        assert_eq!(
            runtime.session_id_for_tests().await.as_deref(),
            Some(session.as_str())
        );
        assert_eq!(
            runtime
                .outbox_payloads_for_tests()
                .await
                .iter()
                .filter(|event| event.event_name == "analytics.session_started")
                .count(),
            1,
            "the refreshed interaction must not open a second session"
        );
    }

    #[tokio::test]
    async fn user_gets_no_provisional_session_when_the_start_does_not_commit() {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        for index in 0..queue::MAX_EVENTS {
            assert_eq!(
                runtime
                    .enqueue_for_tests(outbox_insert(&format!("full-{index}")))
                    .await,
                EnqueueOutcome::Queued
            );
        }

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

    /// A sender that records batch boundaries and applies a caller-supplied
    /// outcome to each batch.
    struct RecordingSender {
        names: StdMutex<Vec<String>>,
        batches: StdMutex<Vec<Vec<String>>>,
        batch_ids: StdMutex<Vec<String>>,
        bodies: StdMutex<Vec<Vec<u8>>>,
        make: Box<dyn Fn(&[AnalyticsEventEnvelope]) -> SendOutcome + Send + Sync>,
    }

    impl RecordingSender {
        fn new() -> Self {
            Self::with_outcome(|_| SendOutcome::Accepted)
        }

        fn with_outcome(
            make: impl Fn(&[AnalyticsEventEnvelope]) -> SendOutcome + Send + Sync + 'static,
        ) -> Self {
            Self {
                names: StdMutex::new(Vec::new()),
                batches: StdMutex::new(Vec::new()),
                batch_ids: StdMutex::new(Vec::new()),
                bodies: StdMutex::new(Vec::new()),
                make: Box::new(make),
            }
        }

        fn sent_names(&self) -> Vec<String> {
            self.names
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone()
        }

        fn sent_batches(&self) -> Vec<Vec<String>> {
            self.batches
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone()
        }

        fn sent_batch_ids(&self) -> Vec<String> {
            self.batch_ids
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone()
        }

        fn sent_bodies(&self) -> Vec<Vec<u8>> {
            self.bodies
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .clone()
        }
    }

    impl EventSender for RecordingSender {
        fn send_batch<'a>(
            &'a self,
            batch: &'a super::super::transport::PreparedAnalyticsBatch,
        ) -> Pin<Box<dyn Future<Output = SendOutcome> + Send + 'a>> {
            Box::pin(async move {
                let names: Vec<String> = batch
                    .events
                    .iter()
                    .map(|envelope| envelope.event_name.clone())
                    .collect();
                {
                    let mut recorded = self
                        .names
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner());
                    recorded.extend(names.iter().cloned());
                }
                self.batches
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .push(names);
                self.batch_ids
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .push(batch.batch_id.clone());
                self.bodies
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .push(batch.encoded_body.clone());
                (self.make)(&batch.events)
            })
        }
    }

    #[tokio::test]
    async fn user_keeps_one_stable_batch_when_retry_attempts_and_jitter_differ() {
        let attempts = Arc::new(AtomicI64::new(0));
        let sender = Arc::new(RecordingSender::with_outcome({
            let attempts = Arc::clone(&attempts);
            move |_batch| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    SendOutcome::Retry {
                        reason: "offline".to_string(),
                    }
                } else {
                    SendOutcome::Accepted
                }
            }
        }));
        let (_root, runtime) = test_runtime(sender.clone()).await;
        for event_id in [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ] {
            assert_eq!(
                runtime.enqueue_for_tests(outbox_insert(event_id)).await,
                EnqueueOutcome::Queued
            );
        }
        runtime
            .inner
            .queue
            .lock()
            .await
            .set_attempt_count("22222222-2222-4222-8222-222222222222", 9);

        runtime.flush_once().await.expect("first flush");

        assert_eq!(
            sender.sent_batches(),
            vec![vec!["app.started".to_string(), "app.started".to_string()]],
            "both due events share one batch"
        );
        assert_eq!(runtime.queue_depth_for_tests().await, 2);
        let attempts_after_failure: Vec<i64> = runtime
            .inner
            .queue
            .lock()
            .await
            .events_for_tests()
            .iter()
            .map(|event| event.attempt_count)
            .collect();
        assert_eq!(
            attempts_after_failure,
            vec![1, 10],
            "a batch failure increments each member from its prior attempt count"
        );
        let deadlines_after_failure: Vec<i64> = runtime
            .inner
            .queue
            .lock()
            .await
            .events_for_tests()
            .iter()
            .map(|event| event.next_attempt_at)
            .collect();
        assert_eq!(
            deadlines_after_failure.len(),
            2,
            "both original members remain reserved"
        );
        assert!(
            deadlines_after_failure
                .iter()
                .all(|deadline| *deadline == deadlines_after_failure[0]),
            "one shared retry deadline prevents jitter from splitting the batch"
        );
        assert_eq!(
            runtime
                .inner
                .pending_batch
                .lock()
                .await
                .as_ref()
                .expect("the unconfirmed batch remains reserved")
                .attempt_count,
            10,
            "the whole batch advances from the highest member attempt count"
        );

        runtime.set_all_queue_next_attempts_for_tests(0).await;
        runtime.flush_once().await.expect("retry flush");

        let batch_ids = sender.sent_batch_ids();
        let bodies = sender.sent_bodies();
        assert_eq!(batch_ids.len(), 2);
        assert_eq!(
            batch_ids[0], batch_ids[1],
            "retrying the same ordered rows preserves the receiver idempotency key"
        );
        assert_eq!(
            bodies[0], bodies[1],
            "a lost acknowledgement retries the exact immutable wire body"
        );
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
    }

    #[tokio::test]
    async fn user_keeps_a_new_event_out_of_an_unconfirmed_batch() {
        let attempts = Arc::new(AtomicI64::new(0));
        let sender = Arc::new(RecordingSender::with_outcome({
            let attempts = Arc::clone(&attempts);
            move |_batch| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    SendOutcome::Retry {
                        reason: "lost acknowledgement".to_string(),
                    }
                } else {
                    SendOutcome::Accepted
                }
            }
        }));
        let (_root, runtime) = test_runtime(sender.clone()).await;
        for event_id in [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ] {
            assert_eq!(
                runtime.enqueue_for_tests(outbox_insert(event_id)).await,
                EnqueueOutcome::Queued
            );
        }

        runtime.flush_once().await.expect("first flush");
        assert_eq!(
            runtime
                .enqueue_for_tests(outbox_insert("33333333-3333-4333-8333-333333333333"))
                .await,
            EnqueueOutcome::Queued
        );
        runtime.set_all_queue_next_attempts_for_tests(0).await;
        runtime.flush_once().await.expect("retry flush");

        let batches = sender.sent_batches();
        let bodies = sender.sent_bodies();
        let batch_ids = sender.sent_batch_ids();
        assert_eq!(
            batches[0],
            vec!["app.started".to_string(), "app.started".to_string()]
        );
        assert_eq!(
            batches[1], batches[0],
            "the retry keeps the original ordered membership"
        );
        assert_eq!(bodies[1], bodies[0], "the retry keeps the exact body");
        assert_eq!(batch_ids[1], batch_ids[0]);
        assert_eq!(
            batches[2],
            vec!["app.started".to_string()],
            "the event enqueued during retry forms a separate later batch"
        );
        assert_ne!(batch_ids[2], batch_ids[0]);
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
    }

    #[tokio::test]
    async fn user_gets_the_reservation_released_after_a_configuration_failure() {
        let attempts = Arc::new(AtomicI64::new(0));
        let sender = Arc::new(RecordingSender::with_outcome({
            let attempts = Arc::clone(&attempts);
            move |_batch| {
                if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    SendOutcome::ConfigurationFailure {
                        reason: "contract mismatch".to_string(),
                    }
                } else {
                    SendOutcome::Accepted
                }
            }
        }));
        let (_root, runtime) = test_runtime(sender.clone()).await;
        for event_id in [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ] {
            assert_eq!(
                runtime.enqueue_for_tests(outbox_insert(event_id)).await,
                EnqueueOutcome::Queued
            );
        }

        runtime.flush_once().await.expect("configuration failure");
        assert_eq!(
            runtime
                .enqueue_for_tests(outbox_insert("33333333-3333-4333-8333-333333333333"))
                .await,
            EnqueueOutcome::Queued
        );
        runtime.set_all_queue_next_attempts_for_tests(0).await;
        runtime.flush_once().await.expect("retry flush");

        assert_eq!(
            sender.sent_batches()[1].len(),
            3,
            "a configuration failure releases the old reservation so due rows can regroup"
        );
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
    }

    #[tokio::test]
    async fn user_gets_the_reservation_discarded_when_an_unconfirmed_batch_expires() {
        let attempts = Arc::new(AtomicI64::new(0));
        let sender = Arc::new(RecordingSender::with_outcome({
            let attempts = Arc::clone(&attempts);
            move |_batch| {
                attempts.fetch_add(1, Ordering::SeqCst);
                SendOutcome::Retry {
                    reason: "offline".to_string(),
                }
            }
        }));
        let (_root, runtime) = test_runtime(sender.clone()).await;
        for event_id in [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ] {
            assert_eq!(
                runtime.enqueue_for_tests(outbox_insert(event_id)).await,
                EnqueueOutcome::Queued
            );
        }

        runtime.flush_once().await.expect("first flush");
        {
            let mut pending = runtime.inner.pending_batch.lock().await;
            let batch = pending.as_mut().expect("unconfirmed reservation");
            batch.retry_at_ms = 0;
            batch.expires_at_ms = 0;
        }
        runtime.set_all_queue_next_attempts_for_tests(0).await;
        runtime.flush_once().await.expect("expiry flush");

        assert_eq!(sender.sent_batches().len(), 1);
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
        assert!(runtime.inner.pending_batch.lock().await.is_none());

        assert_eq!(
            runtime
                .enqueue_for_tests(outbox_insert("33333333-3333-4333-8333-333333333333"))
                .await,
            EnqueueOutcome::Queued
        );
        runtime.flush_once().await.expect("new batch after expiry");

        assert_eq!(
            sender.sent_batches()[1].len(),
            1,
            "an expired reservation must not absorb a later event"
        );
    }

    #[tokio::test]
    async fn user_splits_due_events_into_bounded_batches() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        for index in 0..25 {
            assert_eq!(
                runtime
                    .enqueue_for_tests(outbox_insert(&format!("event-{index:03}")))
                    .await,
                EnqueueOutcome::Queued
            );
        }

        runtime.flush_once().await.expect("flush");

        let batches = sender.sent_batches();
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![10, 10, 5]
        );
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
    }

    #[tokio::test]
    async fn user_gets_no_transport_call_when_consent_is_disabled_before_send() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        assert_eq!(
            runtime.enqueue_for_tests(outbox_insert("pending")).await,
            EnqueueOutcome::Queued
        );

        runtime.set_enabled(false, 0).await.expect("disable");
        runtime.flush_once().await.expect("flush");

        assert!(sender.sent_batches().is_empty());
    }

    #[tokio::test]
    async fn user_gets_the_session_start_sent_before_the_event_that_references_it() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;

        // A submitted request is a lifecycle event, which outranks every passive
        // event in the queue and is queued together with the session it opens.
        let submitted = runtime
            .track(track_request(
                "agent.request_submitted",
                request_submitted_attributes(),
            ))
            .await;
        assert_eq!(submitted.status, AnalyticsSubmitStatus::Queued);
        let session_id = runtime.session_id_for_tests().await.expect("session");

        let queued = runtime.outbox_payloads_for_tests().await;
        assert_eq!(queued.len(), 2, "one session start and one request event");
        let request = queued
            .iter()
            .find(|envelope| envelope.event_name == "agent.request_submitted")
            .expect("request event");
        assert_eq!(
            request.analytics_session_id.as_deref(),
            Some(session_id.as_str())
        );

        runtime.flush_once().await.expect("flush");

        assert_eq!(
            sender.sent_names(),
            vec![
                "analytics.session_started".to_string(),
                "agent.request_submitted".to_string()
            ],
            "the receiver must see the session start before the event using it"
        );
        assert_eq!(
            sender.sent_batches(),
            vec![
                vec!["analytics.session_started".to_string()],
                vec!["agent.request_submitted".to_string()],
            ],
            "the session start gets its own batch so unrelated rows are not held by it"
        );
    }

    #[tokio::test]
    async fn user_gets_dependent_events_held_when_a_session_start_retries_until_it_is_accepted() {
        for failure in ["retry_after", "transient", "configuration"] {
            let attempts = Arc::new(AtomicI64::new(0));
            let sender = Arc::new(RecordingSender::with_outcome({
                let attempts = Arc::clone(&attempts);
                move |batch: &[AnalyticsEventEnvelope]| {
                    let contains_start = batch
                        .iter()
                        .any(|envelope| envelope.event_name == "analytics.session_started");
                    if contains_start && attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        match failure {
                            "retry_after" => SendOutcome::RetryAfter {
                                delay_ms: 3_600_000,
                            },
                            "transient" => SendOutcome::Retry {
                                reason: "offline".to_string(),
                            },
                            _ => SendOutcome::ConfigurationFailure {
                                reason: "bot_rejected".to_string(),
                            },
                        }
                    } else {
                        SendOutcome::Accepted
                    }
                }
            }));
            let (_root, runtime) = test_runtime(sender.clone()).await;

            let submitted = runtime
                .track(track_request(
                    "agent.request_submitted",
                    request_submitted_attributes(),
                ))
                .await;
            assert_eq!(submitted.status, AnalyticsSubmitStatus::Queued);

            // The first attempt leaves the start queued for retry.
            runtime.flush_once().await.expect("flush");
            assert_eq!(
                sender.sent_names(),
                vec!["analytics.session_started".to_string()]
            );
            // Keep every retry deterministic, including the short transient backoff.
            runtime
                .set_queue_next_attempt_for_tests(
                    "analytics.session_started",
                    store::now_millis() + 3_600_000,
                )
                .await;

            // A dependent enqueued after the delay must not overtake the start.
            let surface = runtime
                .track(track_request(
                    "product.surface_opened",
                    JsonMap::from_iter([(
                        "surface".to_string(),
                        JsonValue::String("main".to_string()),
                    )]),
                ))
                .await;
            assert_eq!(surface.status, AnalyticsSubmitStatus::Queued);
            assert_eq!(runtime.queue_depth_for_tests().await, 3);

            // Two due dependents, one start that is not due: nothing is sent.
            runtime
                .flush_once()
                .await
                .expect("flush while the start backs off");
            assert_eq!(
                sender.sent_names(),
                vec!["analytics.session_started".to_string()],
                "no dependent may be sent while its session start is delayed"
            );
            assert_eq!(runtime.queue_depth_for_tests().await, 3);

            // Control the clock: the retry instant arrives without sleeping.
            runtime.set_all_queue_next_attempts_for_tests(0).await;

            runtime
                .flush_once()
                .await
                .expect("flush after the retry instant");
            assert_eq!(
                sender.sent_names(),
                vec![
                    "analytics.session_started".to_string(),
                    "analytics.session_started".to_string(),
                    "agent.request_submitted".to_string(),
                    "product.surface_opened".to_string(),
                ],
                "the start is delivered before the events that reference its session"
            );
            assert_eq!(runtime.queue_depth_for_tests().await, 0);
        }
    }

    #[tokio::test]
    async fn user_gets_all_pending_rows_abandoned_when_a_stored_session_start_is_corrupt() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;

        let handle = runtime.begin_operation().await;
        let submitted = runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(submitted.status, AnalyticsSubmitStatus::Queued);
        let abandoned_session = runtime.session_id_for_tests().await.expect("session");
        runtime
            .track(track_request(
                "product.surface_opened",
                JsonMap::from_iter([(
                    "surface".to_string(),
                    JsonValue::String("main".to_string()),
                )]),
            ))
            .await;
        assert_eq!(runtime.queue_depth_for_tests().await, 3);
        assert_eq!(
            runtime
                .enqueue_for_tests(outbox_insert("independent-startup"))
                .await,
            EnqueueOutcome::Queued
        );
        runtime.corrupt_session_start_for_tests().await;

        runtime.flush_once().await.expect("flush");

        assert!(
            sender.sent_names().is_empty(),
            "a corrupt start is dropped before any batch reaches the sender"
        );
        assert_eq!(
            runtime.queue_depth_for_tests().await,
            0,
            "all pending rows are cleared because no session binding can be proven"
        );
        assert!(
            runtime.session_id_for_tests().await.is_none(),
            "the abandoned session is dropped"
        );

        // The handle bound to the abandoned session is revoked, so a late
        // completion is stale instead of reintroducing the reference.
        let late = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(late.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(late.reason.as_deref(), Some("stale_operation"));
        assert_eq!(runtime.queue_depth_for_tests().await, 0);

        // A later interaction opens a fresh session with its own start row.
        runtime
            .track(track_request(
                "product.surface_opened",
                JsonMap::from_iter([(
                    "surface".to_string(),
                    JsonValue::String("main".to_string()),
                )]),
            ))
            .await;
        let queued = runtime.outbox_payloads_for_tests().await;
        let fresh_start = queued
            .iter()
            .find(|envelope| envelope.event_name == "analytics.session_started")
            .expect("new session start");
        assert_ne!(
            fresh_start.analytics_session_id.as_deref(),
            Some(abandoned_session.as_str()),
            "a new interaction must not reuse the abandoned session id"
        );
    }

    #[tokio::test]
    async fn user_gets_independent_events_sent_on_the_next_pass_when_a_session_start_has_a_configuration_fault(
    ) {
        let sender = Arc::new(RecordingSender::with_outcome(|batch| {
            if batch
                .iter()
                .any(|envelope| envelope.event_name == "analytics.session_started")
            {
                SendOutcome::ConfigurationFailure {
                    reason: "bot_rejected".to_string(),
                }
            } else {
                SendOutcome::Accepted
            }
        }));
        let (_root, runtime) = test_runtime(sender.clone()).await;
        let submitted = runtime
            .track(track_request(
                "agent.request_submitted",
                request_submitted_attributes(),
            ))
            .await;
        assert_eq!(submitted.status, AnalyticsSubmitStatus::Queued);
        runtime
            .inner
            .emit_health_once()
            .await
            .expect("independent health report");

        runtime.flush_once().await.expect("configuration fault");
        assert_eq!(
            sender.sent_names(),
            vec!["analytics.session_started".to_string()]
        );
        runtime.flush_once().await.expect("next pass");
        assert_eq!(
            sender.sent_names(),
            vec![
                "analytics.session_started".to_string(),
                "analytics.health_reported".to_string(),
            ]
        );
        assert_eq!(runtime.queue_depth_for_tests().await, 2);
    }

    #[tokio::test]
    async fn user_gets_no_old_session_events_when_an_undelivered_start_expires() {
        for reclaim_during_ingress in [false, true] {
            let sender = Arc::new(RecordingSender::new());
            let (_root, runtime) = test_runtime(sender.clone()).await;
            let handle = runtime.begin_operation().await;
            assert_eq!(
                runtime
                    .track(with_operation(
                        track_request("agent.request_submitted", request_submitted_attributes()),
                        &handle.operation_id,
                    ))
                    .await
                    .status,
                AnalyticsSubmitStatus::Queued
            );
            let old_session = runtime.session_id_for_tests().await.expect("session");
            runtime.expire_session_starts_for_tests().await;

            if reclaim_during_ingress {
                // A later interaction must not reuse a start reclaimed on ingress.
                assert_eq!(
                    runtime
                        .track(track_request(
                            "product.surface_opened",
                            JsonMap::from_iter([(
                                "surface".to_string(),
                                JsonValue::String("main".to_string()),
                            )]),
                        ))
                        .await
                        .status,
                    AnalyticsSubmitStatus::Queued
                );
            }
            runtime.flush_once().await.expect("flush");
            let late = runtime
                .track(with_operation(
                    track_request("agent.request_completed", request_completed_attributes()),
                    &handle.operation_id,
                ))
                .await;
            assert_eq!(late.status, AnalyticsSubmitStatus::Rejected);
            assert_eq!(late.reason.as_deref(), Some("stale_operation"));
            assert!(!sender
                .sent_names()
                .contains(&"agent.request_submitted".to_string()));
            assert!(runtime
                .outbox_payloads_for_tests()
                .await
                .iter()
                .all(|event| {
                    event.analytics_session_id.as_deref() != Some(old_session.as_str())
                }));
            assert_eq!(
                sender.sent_names(),
                if reclaim_during_ingress {
                    vec![
                        "analytics.session_started".to_string(),
                        "product.surface_opened".to_string(),
                    ]
                } else {
                    Vec::<String>::new()
                }
            );
        }
    }

    #[tokio::test]
    async fn user_sends_no_pre_restore_events_when_reenabling_after_a_full_opt_out_restore() {
        use crate::core::database::types::{DatabaseImportMode, DatabaseImportRequest};

        let (source_root, source) = test_database().await;
        store::ensure_state(source.pool(), POLICY_VERSION, true)
            .await
            .expect("source state");
        store::set_enabled(source.pool(), false, 0, POLICY_VERSION)
            .await
            .expect("disable source")
            .expect("matching source epoch");
        let backup_path = source_root.path().join("opt-out.db");
        source
            .export_backup(backup_path.to_str().expect("backup path"))
            .await
            .expect("export backup");

        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        let handle = runtime.begin_operation().await;
        assert_eq!(
            runtime
                .track(with_operation(
                    track_request("agent.request_submitted", request_submitted_attributes()),
                    &handle.operation_id,
                ))
                .await
                .status,
            AnalyticsSubmitStatus::Queued
        );
        let old_session = runtime.session_id_for_tests().await.expect("old session");
        let pending = pending_handoff(
            Some("11111111-1111-4111-8111-111111111111"),
            Some("1.0.0"),
            "2.0.0",
            0,
        );
        store::apply_delivery_metadata(
            runtime.inner.database.pool(),
            0,
            false,
            &PendingUpdate::Set(pending),
        )
        .await
        .expect("pending handoff");

        runtime
            .inner
            .database
            .import_backup(DatabaseImportRequest {
                source_path: backup_path.to_string_lossy().into_owned(),
                mode: DatabaseImportMode::Full,
            })
            .await
            .expect("full restore");
        runtime
            .synchronize_after_restore()
            .await
            .expect("synchronize restore");
        let restored = runtime.state().await.expect("restored state");
        assert_eq!(restored.status, AnalyticsConsentStatus::Disabled);
        assert_eq!(restored.consent_epoch, 1);
        assert_eq!(restored.queue_depth, 0);
        assert!(store::load_state(runtime.inner.database.pool())
            .await
            .expect("load")
            .expect("row")
            .pending_update_json
            .is_none());

        runtime
            .set_enabled(true, restored.consent_epoch)
            .await
            .expect("enable again");
        runtime.flush_once().await.expect("flush after reenable");
        assert!(
            sender.sent_names().is_empty(),
            "no old event or handoff is replayed"
        );
        let late = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(late.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(late.reason.as_deref(), Some("stale_operation"));

        assert_eq!(
            runtime
                .track(track_request(
                    "product.surface_opened",
                    JsonMap::from_iter([(
                        "surface".to_string(),
                        JsonValue::String("main".to_string()),
                    )]),
                ))
                .await
                .status,
            AnalyticsSubmitStatus::Queued
        );
        assert_ne!(
            runtime.session_id_for_tests().await.as_deref(),
            Some(old_session.as_str())
        );
        runtime.flush_once().await.expect("flush fresh session");
        assert_eq!(
            sender.sent_names(),
            vec![
                "analytics.session_started".to_string(),
                "product.surface_opened".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn user_gets_a_fresh_session_when_tracking_after_pending_events_are_cleared() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        let handle = runtime.begin_operation().await;
        runtime
            .track(with_operation(
                track_request("agent.request_submitted", request_submitted_attributes()),
                &handle.operation_id,
            ))
            .await;
        let old_session = runtime.session_id_for_tests().await.expect("session");

        runtime.clear_pending(0).await.expect("clear");
        let late = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(late.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(late.reason.as_deref(), Some("stale_operation"));
        runtime
            .track(track_request(
                "product.surface_opened",
                JsonMap::from_iter([(
                    "surface".to_string(),
                    JsonValue::String("main".to_string()),
                )]),
            ))
            .await;
        assert_ne!(
            runtime.session_id_for_tests().await.as_deref(),
            Some(old_session.as_str())
        );
        runtime.flush_once().await.expect("flush");
        assert_eq!(
            sender.sent_names(),
            vec![
                "analytics.session_started".to_string(),
                "product.surface_opened".to_string(),
            ]
        );
    }

    #[tokio::test]
    async fn user_gets_a_stale_completion_rejected_without_queued_events_when_reenabling_after_opt_out(
    ) {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;

        let handle = runtime.begin_operation().await;
        // Withdrawing consent revokes every handle bound to the old epoch; opting
        // back in creates a newer epoch that the old handle must not borrow.
        runtime.set_enabled(false, 0).await.expect("opt out");
        runtime.set_enabled(true, 1).await.expect("opt in");

        let result = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &handle.operation_id,
            ))
            .await;

        assert_eq!(result.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(result.reason.as_deref(), Some("stale_operation"));
        assert!(
            runtime.session_id_for_tests().await.is_none(),
            "a stale handle must not start a session"
        );
        assert_eq!(runtime.queue_depth_for_tests().await, 0);
    }

    #[tokio::test]
    async fn user_gets_an_expired_operation_rejected_while_handleless_lifecycle_events_still_persist(
    ) {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        let handle = runtime.begin_operation().await;
        runtime
            .inner
            .operations
            .lock()
            .await
            .records
            .get_mut(&handle.operation_id)
            .expect("operation")
            .created = Instant::now() - OPERATION_TTL - Duration::from_secs(1);

        let expired = runtime
            .track(with_operation(
                track_request("agent.request_completed", request_completed_attributes()),
                &handle.operation_id,
            ))
            .await;
        assert_eq!(expired.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(expired.reason.as_deref(), Some("stale_operation"));
        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
        assert!(runtime.session_id_for_tests().await.is_none());

        let lifecycle = runtime
            .track(track_request("app.startup_completed", JsonMap::new()))
            .await;
        assert_eq!(lifecycle.status, AnalyticsSubmitStatus::Queued);
        runtime.flush_once().await.expect("flush lifecycle");
        assert_eq!(
            sender.sent_names(),
            vec!["app.startup_completed".to_string()]
        );
    }

    #[tokio::test]
    async fn user_gets_no_startup_event_when_a_supplied_operation_is_revoked_while_waiting_to_persist(
    ) {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender).await;
        let handle = runtime.begin_operation().await;
        let writer = runtime.inner.state_lock.lock().await;
        let tracking = tokio::spawn({
            let runtime = runtime.clone();
            let operation_id = handle.operation_id.clone();
            async move {
                runtime
                    .track(with_operation(
                        track_request("app.startup_completed", JsonMap::new()),
                        &operation_id,
                    ))
                    .await
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        runtime.complete_operation(&handle.operation_id).await;
        drop(writer);

        let result = tracking.await.expect("tracking task");
        assert_eq!(result.status, AnalyticsSubmitStatus::Rejected);
        assert_eq!(result.reason.as_deref(), Some("stale_operation"));
        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
    }

    fn pending_handoff(
        operation_id: Option<&str>,
        from_version: Option<&str>,
        to_version: &str,
        consent_epoch: i64,
    ) -> String {
        let mut metadata = JsonMap::new();
        if let Some(operation_id) = operation_id {
            metadata.insert(
                "operationId".to_string(),
                JsonValue::String(operation_id.to_string()),
            );
        }
        if let Some(from_version) = from_version {
            metadata.insert(
                "fromVersion".to_string(),
                JsonValue::String(from_version.to_string()),
            );
        }
        metadata.insert(
            "toVersion".to_string(),
            JsonValue::String(to_version.to_string()),
        );
        metadata.insert("source".to_string(), JsonValue::String("user".to_string()));
        metadata.insert(
            "consentEpoch".to_string(),
            JsonValue::Number(consent_epoch.into()),
        );
        JsonValue::Object(metadata).to_string()
    }

    fn install_handoff_attributes() -> JsonMap<String, JsonValue> {
        JsonMap::from_iter([
            (
                "update_operation_id".to_string(),
                JsonValue::String("11111111-1111-4111-8111-111111111111".to_string()),
            ),
            (
                "phase".to_string(),
                JsonValue::String("install_handoff".to_string()),
            ),
            (
                "result".to_string(),
                JsonValue::String("success".to_string()),
            ),
            ("source".to_string(), JsonValue::String("user".to_string())),
        ])
    }

    #[tokio::test]
    async fn user_gets_a_bounded_install_exit_when_the_analytics_writer_is_occupied() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        let handle = runtime.begin_operation().await;
        let request = with_operation(
            track_request("app.update_transition", install_handoff_attributes()),
            &handle.operation_id,
        );
        let writer = runtime.inner.state_lock.lock().await;
        let started = Instant::now();

        tokio::time::timeout(
            Duration::from_secs(1),
            runtime.track_install_handoff_before_exit(
                request,
                Some("1.0.0".to_string()),
                "2.0.0".to_string(),
                Some(&handle.operation_id),
                Duration::from_millis(20),
            ),
        )
        .await
        .expect("install exit must not wait for the analytics writer");

        assert!(started.elapsed() >= Duration::from_millis(20));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(writer);
        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
        assert!(sender.sent_names().is_empty());
    }

    #[tokio::test]
    async fn user_gets_no_install_handoff_from_a_revoked_operation() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        let handle = runtime.begin_operation().await;
        runtime.set_enabled(false, 0).await.expect("disable");
        runtime.set_enabled(true, 1).await.expect("enable");
        let request = with_operation(
            track_request("app.update_transition", install_handoff_attributes()),
            &handle.operation_id,
        );

        runtime
            .track_install_handoff_before_exit(
                request,
                Some("1.0.0".to_string()),
                "2.0.0".to_string(),
                Some(&handle.operation_id),
                Duration::from_millis(50),
            )
            .await;

        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
        assert!(sender.sent_names().is_empty());
    }

    #[tokio::test]
    async fn user_gets_no_install_handoff_from_an_expired_or_missing_operation() {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender.clone()).await;
        let handle = runtime.begin_operation().await;
        if let Some(record) = runtime
            .inner
            .operations
            .lock()
            .await
            .records
            .get_mut(&handle.operation_id)
        {
            record.created = Instant::now() - OPERATION_TTL - Duration::from_secs(1);
        }
        let request = with_operation(
            track_request("app.update_transition", install_handoff_attributes()),
            &handle.operation_id,
        );

        runtime
            .track_install_handoff_before_exit(
                request,
                Some("1.0.0".to_string()),
                "2.0.0".to_string(),
                Some(&handle.operation_id),
                Duration::from_millis(50),
            )
            .await;
        runtime
            .track_install_handoff_before_exit(
                with_operation(
                    track_request("app.update_transition", install_handoff_attributes()),
                    "missing-operation",
                ),
                Some("1.0.0".to_string()),
                "2.0.0".to_string(),
                Some("missing-operation"),
                Duration::from_millis(50),
            )
            .await;

        assert!(runtime.outbox_payloads_for_tests().await.is_empty());
        assert!(sender.sent_names().is_empty());
    }

    #[tokio::test]
    async fn user_gets_a_restart_confirmed_when_native_versions_are_longer_than_the_wire_limit() {
        for length in [65, 200] {
            let from_version = format!("1.0.0+{}", "b".repeat(length - 6));
            let to_version = format!("2.0.0+{}", "a".repeat(length - 6));
            assert_eq!(from_version.len(), length);
            assert_eq!(to_version.len(), length);

            let sender = Arc::new(RecordingSender::new());
            let (_root, runtime) = test_runtime(sender).await;
            let handle = runtime.begin_operation().await;
            let request = with_operation(
                track_request("app.update_transition", install_handoff_attributes()),
                &handle.operation_id,
            );

            assert_eq!(
                runtime
                    .track_install_handoff(request, Some(from_version.clone()), to_version.clone(),)
                    .await
                    .status,
                AnalyticsSubmitStatus::Queued
            );
            let install_events = runtime.outbox_payloads_for_tests().await;
            let install_handoff = install_events
                .iter()
                .find(|event| {
                    event.attributes.get("phase").and_then(JsonValue::as_str)
                        == Some("install_handoff")
                })
                .expect("install handoff event");
            assert!(!install_handoff.attributes.contains_key("from_version"));
            assert!(!install_handoff.attributes.contains_key("to_version"));

            let row = store::load_state(runtime.inner.database.pool())
                .await
                .expect("load state")
                .expect("state row");
            let pending = row.pending_update_json.clone().expect("pending handoff");
            assert!(pending.len() <= PENDING_UPDATE_MAX_BYTES);
            let pending: JsonValue = serde_json::from_str(&pending).expect("pending json");
            assert_eq!(
                pending["fromVersion"],
                JsonValue::String(from_version.clone())
            );
            assert_eq!(pending["toVersion"], JsonValue::String(to_version.clone()));

            runtime
                .inner
                .resolve_restart_confirmation(&row, &to_version)
                .await
                .expect("confirm restart");
            let confirmations = runtime
                .outbox_payloads_for_tests()
                .await
                .into_iter()
                .filter(|event| {
                    event.attributes.get("phase").and_then(JsonValue::as_str)
                        == Some("restart_confirmed")
                })
                .collect::<Vec<_>>();
            assert_eq!(confirmations.len(), 1);
            assert!(!confirmations[0].attributes.contains_key("from_version"));
            assert!(!confirmations[0].attributes.contains_key("to_version"));
            assert!(store::load_state(runtime.inner.database.pool())
                .await
                .expect("load state")
                .expect("state row")
                .pending_update_json
                .is_none());
        }
    }

    #[tokio::test]
    async fn user_gets_sanitized_install_handoff_when_native_versions_are_not_wire_shaped() {
        let too_long_pending_version = format!("2.0.0+{}", "a".repeat(195));
        assert_eq!(too_long_pending_version.len(), 201);
        for (from_version, to_version) in [
            ("/tmp/current", "https://updates.touch-ai.org/2.0.0"),
            ("1.0.0", "/tmp/release/2.0.0"),
            ("1.0.0", "1.2.3_rc1"),
            ("1.0.0", too_long_pending_version.as_str()),
        ] {
            let sender = Arc::new(RecordingSender::new());
            let (_root, runtime) = test_runtime(sender).await;
            let handle = runtime.begin_operation().await;
            let request = with_operation(
                track_request("app.update_transition", install_handoff_attributes()),
                &handle.operation_id,
            );

            assert_eq!(
                runtime
                    .track_install_handoff(
                        request,
                        Some(from_version.to_string()),
                        to_version.to_string(),
                    )
                    .await
                    .status,
                AnalyticsSubmitStatus::Queued
            );
            let events = runtime.outbox_payloads_for_tests().await;
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].attributes["phase"], "install_handoff");
            assert_eq!(
                events[0].attributes.contains_key("from_version"),
                events::is_version_shaped(from_version)
            );
            assert_eq!(
                events[0].attributes.contains_key("to_version"),
                events::is_version_shaped(to_version)
            );
            assert!(store::load_state(runtime.inner.database.pool())
                .await
                .expect("load state")
                .expect("state row")
                .pending_update_json
                .is_none());
        }
    }

    #[tokio::test]
    async fn user_gets_a_restart_confirmed_only_for_a_matching_install_handoff() {
        const OPERATION_ID: &str = "11111111-1111-4111-8111-111111111111";

        struct Case {
            given: &'static str,
            app_version: &'static str,
            pending: String,
            provisioned: bool,
            disabled: bool,
            confirmed: bool,
            retained: bool,
        }

        let cases = [
            Case {
                given: "the next start is the handed-off version",
                app_version: "2.0.0",
                pending: pending_handoff(Some(OPERATION_ID), Some("1.0.0"), "2.0.0", 0),
                provisioned: true,
                disabled: false,
                confirmed: true,
                retained: false,
            },
            Case {
                given: "the stored handoff names the running version on both sides",
                app_version: "2.0.0",
                pending: pending_handoff(Some(OPERATION_ID), Some("2.0.0"), "2.0.0", 0),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "the install did not reach its target version",
                app_version: "1.0.0",
                pending: pending_handoff(Some(OPERATION_ID), Some("1.0.0"), "2.0.0", 0),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "the stored handoff has no operation id",
                app_version: "2.0.0",
                pending: pending_handoff(None, Some("1.0.0"), "2.0.0", 0),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "the handoff was stored under another consent epoch",
                app_version: "2.0.0",
                pending: pending_handoff(Some(OPERATION_ID), Some("1.0.0"), "2.0.0", 3),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "the stored metadata is not valid JSON",
                app_version: "2.0.0",
                pending: "{\"toVersion\":".to_string(),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "the stored version is not a release version",
                app_version: "2.0.0",
                pending: pending_handoff(Some(OPERATION_ID), Some("1.0.0"), "/tmp/2.0.0", 0),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "the stored operation id is not a canonical UUID",
                app_version: "2.0.0",
                pending: pending_handoff(Some("invalid-operation"), Some("1.0.0"), "2.0.0", 0),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "the stored metadata exceeds its size limit",
                app_version: "2.0.0",
                pending: format!(
                    "{}{}",
                    pending_handoff(Some(OPERATION_ID), Some("1.0.0"), "2.0.0", 0),
                    " ".repeat(PENDING_UPDATE_MAX_BYTES),
                ),
                provisioned: true,
                disabled: false,
                confirmed: false,
                retained: false,
            },
            Case {
                given: "sharing is turned off when the start resolves the handoff",
                app_version: "2.0.0",
                pending: pending_handoff(Some(OPERATION_ID), Some("1.0.0"), "2.0.0", 0),
                provisioned: true,
                disabled: true,
                confirmed: false,
                retained: true,
            },
            Case {
                given: "the deployment cannot deliver yet",
                app_version: "2.0.0",
                pending: pending_handoff(Some(OPERATION_ID), Some("1.0.0"), "2.0.0", 0),
                provisioned: false,
                disabled: false,
                confirmed: false,
                retained: true,
            },
        ];

        for case in cases {
            let sender = Arc::new(Probe::new(|| SendOutcome::Accepted));
            let (_root, database) = test_database().await;
            let transport: Option<Arc<dyn EventSender>> = if case.provisioned {
                Some(sender.clone())
            } else {
                None
            };
            let runtime =
                AnalyticsRuntime::initialize_with_sender_for_tests(database, transport, true)
                    .await
                    .expect("runtime");
            runtime.clear_outbox_for_tests().await;
            let pool = runtime.inner.database.pool();
            if case.disabled {
                store::set_status_for_tests(pool, "disabled", true)
                    .await
                    .expect("disable sharing");
            }
            store::set_pending_update_for_tests(pool, Some(&case.pending))
                .await
                .expect("seed pending handoff");
            let row = store::load_state(pool)
                .await
                .expect("load state")
                .expect("state row");

            runtime
                .inner
                .resolve_restart_confirmation(&row, case.app_version)
                .await
                .expect("resolve restart confirmation");

            let events = runtime.outbox_payloads_for_tests().await;
            assert_eq!(events.len(), usize::from(case.confirmed), "{}", case.given);
            if case.confirmed {
                let event = &events[0];
                assert_eq!(event.event_name, "app.update_transition", "{}", case.given);
                assert_eq!(
                    event.attributes["phase"],
                    JsonValue::String("restart_confirmed".to_string()),
                    "{}",
                    case.given
                );
                assert_eq!(
                    event.attributes["update_operation_id"],
                    JsonValue::String(OPERATION_ID.to_string()),
                    "{}",
                    case.given
                );
                assert_eq!(
                    event.attributes["from_version"],
                    JsonValue::String("1.0.0".to_string()),
                    "{}",
                    case.given
                );
                assert_eq!(
                    event.attributes["to_version"],
                    JsonValue::String("2.0.0".to_string()),
                    "{}",
                    case.given
                );
                assert_eq!(
                    event.attributes["source"],
                    JsonValue::String("user".to_string()),
                    "{}",
                    case.given
                );
            }

            let pending_after = store::load_state(pool)
                .await
                .expect("load state")
                .expect("state row")
                .pending_update_json;
            assert_eq!(
                pending_after.is_some(),
                case.retained,
                "{}: pending metadata retention",
                case.given
            );
        }
    }

    #[tokio::test]
    async fn user_gets_only_one_restart_confirmation_when_the_same_saved_handoff_is_resolved_twice()
    {
        let probe = Arc::new(Probe::new(|| SendOutcome::Accepted));
        let (_root, runtime) = test_runtime(probe).await;
        let pool = runtime.inner.database.pool();
        let pending = pending_handoff(
            Some("11111111-1111-4111-8111-111111111111"),
            Some("1.0.0"),
            "2.0.0",
            0,
        );
        store::set_pending_update_for_tests(pool, Some(&pending))
            .await
            .expect("seed pending handoff");

        let first = store::load_state(pool).await.expect("load").expect("row");
        runtime
            .inner
            .resolve_restart_confirmation(&first, "2.0.0")
            .await
            .expect("first resolution");
        // Reusing the same snapshot models overlapping startup resolution.
        runtime
            .inner
            .resolve_restart_confirmation(&first, "2.0.0")
            .await
            .expect("second resolution");

        let confirmations = runtime
            .outbox_payloads_for_tests()
            .await
            .into_iter()
            .filter(|envelope| envelope.event_name == "app.update_transition")
            .count();
        assert_eq!(
            confirmations, 1,
            "a confirmed handoff is never confirmed a second time"
        );
        assert!(store::load_state(pool)
            .await
            .expect("load")
            .expect("row")
            .pending_update_json
            .is_none());
    }

    #[tokio::test]
    async fn user_keeps_a_new_handoff_when_an_older_saved_handoff_is_resolved() {
        for old_target_matches in [false, true] {
            let sender = Arc::new(RecordingSender::new());
            let (_root, runtime) = test_runtime(sender).await;
            let pool = runtime.inner.database.pool();
            let old_pending = pending_handoff(
                Some("11111111-1111-4111-8111-111111111111"),
                Some("1.0.0"),
                "2.0.0",
                0,
            );
            store::set_pending_update_for_tests(pool, Some(&old_pending))
                .await
                .expect("old handoff");
            let old = store::load_state(pool).await.expect("load").expect("row");
            let new_pending = pending_handoff(
                Some("22222222-2222-4222-8222-222222222222"),
                Some("1.0.0"),
                "2.0.0",
                0,
            );
            store::set_pending_update_for_tests(pool, Some(&new_pending))
                .await
                .expect("new handoff");

            runtime
                .inner
                .resolve_restart_confirmation(
                    &old,
                    if old_target_matches { "2.0.0" } else { "1.0.0" },
                )
                .await
                .expect("resolve saved handoff");

            assert!(runtime.outbox_payloads_for_tests().await.is_empty());
            let current = store::load_state(pool).await.expect("load").expect("row");
            assert_eq!(
                current.pending_update_json.as_deref(),
                Some(new_pending.as_str())
            );
            runtime
                .inner
                .resolve_restart_confirmation(&current, "2.0.0")
                .await
                .expect("resolve new handoff");
            let events = runtime.outbox_payloads_for_tests().await;
            assert_eq!(events.len(), 1);
            assert_eq!(
                events[0].attributes["update_operation_id"],
                "22222222-2222-4222-8222-222222222222"
            );
        }
    }

    #[tokio::test]
    async fn user_keeps_a_restart_confirmation_when_the_queue_is_full_then_confirms_once_space_is_available(
    ) {
        let sender = Arc::new(RecordingSender::new());
        let (_root, runtime) = test_runtime(sender).await;
        let pool = runtime.inner.database.pool();
        let pending = pending_handoff(
            Some("11111111-1111-4111-8111-111111111111"),
            Some("1.0.0"),
            "2.0.0",
            0,
        );
        store::set_pending_update_for_tests(pool, Some(&pending))
            .await
            .expect("handoff");
        for index in 0..queue::MAX_EVENTS {
            assert_eq!(
                runtime
                    .enqueue_for_tests(outbox_insert(&format!("full-{index}")))
                    .await,
                EnqueueOutcome::Queued
            );
        }
        let row = store::load_state(pool).await.expect("load").expect("row");

        runtime
            .inner
            .resolve_restart_confirmation(&row, "2.0.0")
            .await
            .expect("full resolution");
        assert_eq!(
            store::load_state(pool)
                .await
                .expect("load")
                .expect("row")
                .pending_update_json
                .as_deref(),
            Some(pending.as_str())
        );
        assert_eq!(runtime.queue_depth_for_tests().await, queue::MAX_EVENTS);
        runtime.clear_outbox_for_tests().await;

        runtime
            .inner
            .resolve_restart_confirmation(&row, "2.0.0")
            .await
            .expect("retry resolution");
        let confirmations = runtime.outbox_payloads_for_tests().await;
        assert_eq!(confirmations.len(), 1);
        assert_eq!(confirmations[0].attributes["phase"], "restart_confirmed");
        assert!(store::load_state(pool)
            .await
            .expect("load")
            .expect("row")
            .pending_update_json
            .is_none());
    }

    #[tokio::test]
    async fn user_gets_restart_confirmation_only_when_a_successful_install_handoff_was_recorded() {
        for (phase, result, confirms) in [
            ("install_handoff", "success", true),
            ("download_finished", "success", false),
            ("install_handoff", "failure", false),
        ] {
            let sender = Arc::new(RecordingSender::new());
            let (_root, runtime) = test_runtime(sender.clone()).await;
            let request = track_request(
                "app.update_transition",
                JsonMap::from_iter([
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
            );

            assert_eq!(
                runtime.track(request).await.status,
                AnalyticsSubmitStatus::Queued
            );
            let row = store::load_state(runtime.inner.database.pool())
                .await
                .expect("load")
                .expect("row");
            assert_eq!(row.pending_update_json.is_some(), confirms);
            if let Some(pending) = &row.pending_update_json {
                assert!(pending.len() <= PENDING_UPDATE_MAX_BYTES);
            }
            runtime
                .inner
                .resolve_restart_confirmation(&row, "2.0.0")
                .await
                .expect("resolve restart");

            let events = runtime.outbox_payloads_for_tests().await;
            let confirmations: Vec<_> = events
                .iter()
                .filter(|event| {
                    event.attributes.get("phase").and_then(JsonValue::as_str)
                        == Some("restart_confirmed")
                })
                .collect();
            assert_eq!(
                confirmations.len(),
                usize::from(confirms),
                "{phase}: {result}"
            );
            if let Some(confirmation) = confirmations.first() {
                assert_eq!(confirmation.attributes["from_version"], "1.0.0");
                assert_eq!(confirmation.attributes["to_version"], "2.0.0");
                assert_eq!(
                    confirmation.attributes["update_operation_id"],
                    "11111111-1111-4111-8111-111111111111"
                );
                assert!(confirmation.analytics_session_id.is_none());
            }
            runtime.flush_once().await.expect("flush transitions");
            assert_eq!(sender.sent_names().len(), 1 + usize::from(confirms));
        }
    }
}
