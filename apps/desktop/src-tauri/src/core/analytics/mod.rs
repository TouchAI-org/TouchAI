// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Product analytics foundation.
//!
//! Business call sites submit typed, whitelisted metadata to `AnalyticsService`
//! (TypeScript) which reaches this runtime through `NativeService/analytics.ts`
//! and the `analytics_*` commands. The runtime owns consent, installation
//! identity, the bounded outbox and the Umami-compatible sender. It reuses the
//! existing `DatabaseRuntime` SQLite pool over `touchai.db`; there is no second
//! database, connection or schema framework.

pub(crate) mod events;
mod runtime;
mod store;
mod transport;

pub use runtime::AnalyticsRuntime;
pub(crate) use store::{adopt_restored_consent, RestoredConsent, DEPLOYMENT_KEY_SETTING};

use std::{sync::OnceLock, time::Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

/// The instant the process entry point started. Set once by native setup so
/// startup duration is measured from the true process start, not from analytics
/// initialization.
static PROCESS_STARTED_AT: OnceLock<Instant> = OnceLock::new();

/// Records the process-start instant. Called once from the app entry point.
pub(crate) fn mark_process_start(instant: Instant) {
    let _ = PROCESS_STARTED_AT.set(instant);
}

pub(crate) fn process_started_at() -> Instant {
    *PROCESS_STARTED_AT.get_or_init(Instant::now)
}

/// Trusted native startup classification derived from real process facts (the
/// autostart plugin launches with `--minimized`), never from the WebView.
pub(crate) fn startup_source_from_process() -> String {
    startup_source_from_args(std::env::args())
}

fn startup_source_from_args(args: impl IntoIterator<Item = String>) -> String {
    if args.into_iter().any(|argument| argument == "--minimized") {
        "autostart".to_string()
    } else {
        "foreground".to_string()
    }
}

/// Native-authoritative consent status. `uninitialized` fails closed: no send
/// is attempted until a stored state says otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsConsentStatus {
    Uninitialized,
    Enabled,
    Disabled,
}

impl AnalyticsConsentStatus {
    pub(crate) fn from_db(value: &str) -> Self {
        match value {
            "enabled" => Self::Enabled,
            "disabled" => Self::Disabled,
            _ => Self::Uninitialized,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsState {
    pub status: AnalyticsConsentStatus,
    pub consent_epoch: i64,
    pub queue_depth: i64,
    pub pending_bytes: i64,
    pub transport_ready: bool,
}

/// The native-owned activation kind used by the startup instrumentation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsStartupKind {
    Cold,
    Reactivation,
}

impl AnalyticsStartupKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Cold => "cold",
            Self::Reactivation => "reactivation",
        }
    }
}

/// Native-owned process lifecycle facts for the startup instrumentation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsLifecycleContext {
    pub run_id: String,
    pub startup_id: String,
    pub startup_kind: AnalyticsStartupKind,
    pub startup_source: String,
    pub elapsed_ms: i64,
}

/// An opaque, native-issued operation handle. The WebView passes the id back on
/// later events; the native runtime owns the session and epoch bound to it, so a
/// caller can never supply an authoritative session id.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsOperationHandle {
    pub operation_id: String,
    pub enabled: bool,
    pub consent_epoch: i64,
}

/// IPC payload submitted by the WebView. Identity, version and platform are
/// filled by the native runtime and are never trusted from the caller. The
/// consent epoch and the session both come from the native operation handle, not
/// from the caller.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsTrackRequest {
    pub event_name: String,
    pub occurred_at_ms: i64,
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub attributes: JsonMap<String, JsonValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalyticsSubmitStatus {
    Persisted,
    Disabled,
    Unavailable,
    Rejected,
    StaleEpoch,
    Deduplicated,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsSubmitResult {
    pub status: AnalyticsSubmitStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AnalyticsSubmitResult {
    pub(crate) fn new(status: AnalyticsSubmitStatus) -> Self {
        Self {
            status,
            event_id: None,
            reason: None,
        }
    }

    pub(crate) fn with_reason(status: AnalyticsSubmitStatus, reason: impl Into<String>) -> Self {
        Self {
            status,
            event_id: None,
            reason: Some(reason.into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::startup_source_from_args;

    #[test]
    fn user_gets_an_autostart_classification_from_the_real_launch_argument() {
        assert_eq!(
            startup_source_from_args(["--minimized".to_string()]),
            "autostart"
        );
        assert_eq!(
            startup_source_from_args(["--profile".to_string(), "default".to_string()]),
            "foreground"
        );
    }
}
