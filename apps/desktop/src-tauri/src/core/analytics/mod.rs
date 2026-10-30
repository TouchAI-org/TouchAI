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

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

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

/// IPC payload submitted by the WebView. Identity, version and platform are
/// filled by the native runtime and are never trusted from the caller.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyticsTrackRequest {
    pub event_name: String,
    pub occurred_at_ms: i64,
    pub consent_epoch: i64,
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
