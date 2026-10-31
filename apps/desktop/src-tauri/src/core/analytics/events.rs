// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Fixed analytics event registry and whitelist validation.
//!
//! This mirrors the public contract in the private receiver
//! (`touchai-analytics`, `src/touchai_analytics/protocol.py`) and the
//! TypeScript schema in `src/services/AnalyticsService/events.ts`. A change to
//! any attribute name, enum value or numeric bound must move all three copies
//! together, and the shared fixtures prove they agree.

use serde_json::{Map as JsonMap, Value as JsonValue};

pub(crate) const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnalyticsEventName {
    AnalyticsSessionStarted,
    AnalyticsHealthReported,
    ProductSurfaceOpened,
    ProductFeatureExposed,
    ProviderConfigurationStarted,
    ProviderConfigurationCompleted,
    AgentRequestSubmitted,
    AgentFirstOutputReceived,
    AgentRequestCompleted,
    AgentToolCompleted,
    AgentApprovalResolved,
    McpConnectionCompleted,
    AttachmentPreparationCompleted,
    SearchCompleted,
    SearchResultSelected,
    ResultActionCompleted,
    AppUpdateTransition,
    AppStarted,
    AppStartupCompleted,
}

impl AnalyticsEventName {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "analytics.session_started" => Self::AnalyticsSessionStarted,
            "analytics.health_reported" => Self::AnalyticsHealthReported,
            "product.surface_opened" => Self::ProductSurfaceOpened,
            "product.feature_exposed" => Self::ProductFeatureExposed,
            "provider.configuration_started" => Self::ProviderConfigurationStarted,
            "provider.configuration_completed" => Self::ProviderConfigurationCompleted,
            "agent.request_submitted" => Self::AgentRequestSubmitted,
            "agent.first_output_received" => Self::AgentFirstOutputReceived,
            "agent.request_completed" => Self::AgentRequestCompleted,
            "agent.tool_completed" => Self::AgentToolCompleted,
            "agent.approval_resolved" => Self::AgentApprovalResolved,
            "mcp.connection_completed" => Self::McpConnectionCompleted,
            "attachment.preparation_completed" => Self::AttachmentPreparationCompleted,
            "search.completed" => Self::SearchCompleted,
            "search.result_selected" => Self::SearchResultSelected,
            "result.action_completed" => Self::ResultActionCompleted,
            "app.update_transition" => Self::AppUpdateTransition,
            "app.started" => Self::AppStarted,
            "app.startup_completed" => Self::AppStartupCompleted,
            _ => return None,
        })
    }
}

struct AttrSpec {
    key: &'static str,
    required: bool,
    kind: AttrKind,
}

enum AttrKind {
    Enum(&'static [&'static str]),
    Uuid,
    Day,
    Version,
    Int { minimum: i64, maximum: i64 },
    Bool,
}

const fn required(key: &'static str, kind: AttrKind) -> AttrSpec {
    AttrSpec {
        key,
        required: true,
        kind,
    }
}

const fn optional(key: &'static str, kind: AttrKind) -> AttrSpec {
    AttrSpec {
        key,
        required: false,
        kind,
    }
}

const fn int_kind(minimum: i64, maximum: i64) -> AttrKind {
    AttrKind::Int { minimum, maximum }
}

fn event_spec(name: AnalyticsEventName) -> &'static [AttrSpec] {
    use AnalyticsEventName::*;

    match name {
        AnalyticsSessionStarted => {
            static SPECS: &[AttrSpec] = &[
                required("configured", AttrKind::Bool),
                optional("first_observed_day", AttrKind::Day),
                optional("first_success_day", AttrKind::Day),
            ];
            SPECS
        }
        AnalyticsHealthReported => {
            static SPECS: &[AttrSpec] = &[
                required("accepted_count", int_kind(0, 1_000_000)),
                optional("duplicate_count", int_kind(0, 1_000_000)),
                optional("rejected_count", int_kind(0, 1_000_000)),
                optional("dropped_count", int_kind(0, 1_000_000)),
                optional("send_failure_count", int_kind(0, 1_000_000)),
                optional("queue_depth", int_kind(0, 1_000_000)),
                required(
                    "consent_state",
                    AttrKind::Enum(&["enabled", "disabled", "pending"]),
                ),
            ];
            SPECS
        }
        ProductSurfaceOpened => {
            static SPECS: &[AttrSpec] = &[required(
                "surface",
                AttrKind::Enum(&["shortcut", "tray", "main", "history", "other"]),
            )];
            SPECS
        }
        ProductFeatureExposed => {
            static SPECS: &[AttrSpec] = &[required(
                "feature",
                AttrKind::Enum(&[
                    "quick_search",
                    "attachments",
                    "mcp",
                    "tools",
                    "history",
                    "other",
                ]),
            )];
            SPECS
        }
        ProviderConfigurationStarted => {
            static SPECS: &[AttrSpec] = &[
                required("configuration_id", AttrKind::Uuid),
                required(
                    "provider_category",
                    AttrKind::Enum(&["openai", "anthropic", "google", "local", "other"]),
                ),
                required(
                    "entry",
                    AttrKind::Enum(&["onboarding", "settings", "test", "other"]),
                ),
            ];
            SPECS
        }
        ProviderConfigurationCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("configuration_id", AttrKind::Uuid),
                required("stage", AttrKind::Enum(&["saved", "validated"])),
                required("result", AttrKind::Enum(&["success", "failure"])),
                optional(
                    "error_category",
                    AttrKind::Enum(&["auth", "network", "invalid_config", "provider", "other"]),
                ),
                optional("duration_ms", int_kind(0, 86_400_000)),
            ];
            SPECS
        }
        AgentRequestSubmitted => {
            static SPECS: &[AttrSpec] = &[
                required("request_id", AttrKind::Uuid),
                required(
                    "request_kind",
                    AttrKind::Enum(&["chat", "tool", "agent", "other"]),
                ),
                required(
                    "surface",
                    AttrKind::Enum(&["main", "quick_search", "history", "other"]),
                ),
                required(
                    "attachment_count_bucket",
                    AttrKind::Enum(&["0", "1", "2-5", "6+"]),
                ),
                optional(
                    "capability",
                    AttrKind::Enum(&["none", "tools", "mcp", "browser", "other"]),
                ),
            ];
            SPECS
        }
        AgentFirstOutputReceived => {
            static SPECS: &[AttrSpec] = &[
                required("request_id", AttrKind::Uuid),
                required("first_output_latency_ms", int_kind(0, 86_400_000)),
            ];
            SPECS
        }
        AgentRequestCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("request_id", AttrKind::Uuid),
                required(
                    "result",
                    AttrKind::Enum(&["success", "failure", "cancelled", "unknown"]),
                ),
                required("duration_ms", int_kind(0, 86_400_000)),
                optional("provider_ttft_ms", int_kind(0, 86_400_000)),
                required("retry_count", int_kind(0, 10_000)),
                optional("tool_count", int_kind(0, 10_000)),
                optional("approval_count", int_kind(0, 10_000)),
                optional("model_switch_count", int_kind(0, 1_000)),
                optional("total_tokens", int_kind(0, 10_000_000_000)),
                optional("cost_usd_micros", int_kind(0, 10_000_000_000_000)),
                required(
                    "usage_coverage",
                    AttrKind::Enum(&["observed", "partial", "unavailable"]),
                ),
                required(
                    "persistence_result",
                    AttrKind::Enum(&["saved", "failed", "not_applicable"]),
                ),
                optional(
                    "cancel_stage",
                    AttrKind::Enum(&[
                        "submitted",
                        "streaming",
                        "tool",
                        "approval",
                        "persistence",
                        "other",
                    ]),
                ),
                optional(
                    "error_category",
                    AttrKind::Enum(&[
                        "none",
                        "auth",
                        "rate_limit",
                        "network",
                        "timeout",
                        "invalid_request",
                        "provider",
                        "other",
                    ]),
                ),
                optional(
                    "pricing_coverage",
                    AttrKind::Enum(&["observed", "partial", "unavailable"]),
                ),
                optional("llm_call_count", int_kind(0, 10_000)),
                optional("unpriced_call_count", int_kind(0, 10_000)),
                optional("cache_read_tokens", int_kind(0, 10_000_000_000)),
                optional("cache_write_tokens", int_kind(0, 10_000_000_000)),
            ];
            SPECS
        }
        AgentToolCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("request_id", AttrKind::Uuid),
                required("tool_id", AttrKind::Uuid),
                required(
                    "tool_category",
                    AttrKind::Enum(&["file", "command", "network", "browser", "mcp", "other"]),
                ),
                required(
                    "result",
                    AttrKind::Enum(&["success", "failure", "cancelled"]),
                ),
                required("duration_ms", int_kind(0, 86_400_000)),
            ];
            SPECS
        }
        AgentApprovalResolved => {
            static SPECS: &[AttrSpec] = &[
                required("request_id", AttrKind::Uuid),
                required("approval_id", AttrKind::Uuid),
                required(
                    "resolution",
                    AttrKind::Enum(&["approved", "rejected", "cancelled", "timeout"]),
                ),
                required("wait_ms", int_kind(0, 86_400_000)),
            ];
            SPECS
        }
        McpConnectionCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("connection_id", AttrKind::Uuid),
                required(
                    "connection_kind",
                    AttrKind::Enum(&["user", "background_reconnect"]),
                ),
                required(
                    "result",
                    AttrKind::Enum(&["success", "failure", "cancelled"]),
                ),
                optional("duration_ms", int_kind(0, 86_400_000)),
                optional(
                    "error_category",
                    AttrKind::Enum(&["network", "auth", "protocol", "other"]),
                ),
            ];
            SPECS
        }
        AttachmentPreparationCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("preparation_id", AttrKind::Uuid),
                required(
                    "attachment_type",
                    AttrKind::Enum(&["image", "document", "code", "other"]),
                ),
                required("count_bucket", AttrKind::Enum(&["1", "2-5", "6+"])),
                required("result", AttrKind::Enum(&["success", "failure"])),
                optional("duration_ms", int_kind(0, 86_400_000)),
                optional(
                    "error_category",
                    AttrKind::Enum(&["too_large", "unsupported", "io", "other"]),
                ),
            ];
            SPECS
        }
        SearchCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("interaction_id", AttrKind::Uuid),
                required(
                    "search_scope",
                    AttrKind::Enum(&["quick", "history", "other"]),
                ),
                required("has_results", AttrKind::Bool),
                required("duration_ms", int_kind(0, 86_400_000)),
                optional(
                    "result_count_bucket",
                    AttrKind::Enum(&["0", "1", "2-5", "6+"]),
                ),
            ];
            SPECS
        }
        SearchResultSelected => {
            static SPECS: &[AttrSpec] = &[
                required("interaction_id", AttrKind::Uuid),
                required(
                    "result_category",
                    AttrKind::Enum(&["conversation", "message", "file", "setting", "other"]),
                ),
                required("opened", AttrKind::Bool),
            ];
            SPECS
        }
        ResultActionCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("action_id", AttrKind::Uuid),
                required(
                    "action",
                    AttrKind::Enum(&["copy_answer", "copy_code", "open_external", "other"]),
                ),
                required("result", AttrKind::Enum(&["success", "failure"])),
            ];
            SPECS
        }
        AppUpdateTransition => {
            static SPECS: &[AttrSpec] = &[
                required("update_operation_id", AttrKind::Uuid),
                required(
                    "phase",
                    AttrKind::Enum(&[
                        "check_started",
                        "check_finished",
                        "download_started",
                        "download_finished",
                        "install_handoff",
                        "restart_confirmed",
                    ]),
                ),
                optional("from_version", AttrKind::Version),
                optional("to_version", AttrKind::Version),
                required(
                    "result",
                    AttrKind::Enum(&["success", "failure", "unavailable"]),
                ),
                required("source", AttrKind::Enum(&["background", "user", "other"])),
            ];
            SPECS
        }
        AppStarted => {
            static SPECS: &[AttrSpec] = &[
                required("run_id", AttrKind::Uuid),
                required(
                    "startup_source",
                    AttrKind::Enum(&["foreground", "background", "autostart", "other"]),
                ),
            ];
            SPECS
        }
        AppStartupCompleted => {
            static SPECS: &[AttrSpec] = &[
                required("startup_id", AttrKind::Uuid),
                required("startup_kind", AttrKind::Enum(&["cold", "reactivation"])),
                required(
                    "startup_source",
                    AttrKind::Enum(&["foreground", "background", "autostart", "other"]),
                ),
                required("duration_ms", int_kind(0, 86_400_000)),
            ];
            SPECS
        }
    }
}

pub(crate) fn validate_event(
    name: &str,
    attributes: &JsonMap<String, JsonValue>,
) -> Result<(), String> {
    let event = AnalyticsEventName::parse(name).ok_or_else(|| "unknown_event".to_string())?;
    let specs = event_spec(event);

    for (key, value) in attributes {
        let spec = specs
            .iter()
            .find(|spec| spec.key == key)
            .ok_or_else(|| format!("unknown_attribute:{key}"))?;
        validate_value(&spec.kind, value).map_err(|reason| format!("{key}:{reason}"))?;
    }

    for spec in specs {
        if spec.required && !attributes.contains_key(spec.key) {
            return Err(format!("missing_attribute:{}", spec.key));
        }
    }

    // Cross-field relation shared with the TypeScript schema: unpriced calls are
    // a subset of all llm calls, so it can never exceed the total when both are
    // present. Absent values stay absent (never coerced to zero).
    if event == AnalyticsEventName::AgentRequestCompleted {
        let llm_calls = attributes.get("llm_call_count").and_then(JsonValue::as_i64);
        let unpriced = attributes
            .get("unpriced_call_count")
            .and_then(JsonValue::as_i64);
        if let (Some(llm_calls), Some(unpriced)) = (llm_calls, unpriced) {
            if unpriced > llm_calls {
                return Err("unpriced_call_count_exceeds_llm_call_count".to_string());
            }
        }
    }

    Ok(())
}

/// Lower numbers survive capacity pressure longer and send first. Session starts
/// outrank request lifecycles, which outrank passive startup/health/exposure.
pub(crate) fn event_priority(name: &str) -> i64 {
    match name {
        "analytics.session_started" => 0,
        "agent.request_submitted"
        | "agent.request_completed"
        | "agent.first_output_received"
        | "agent.tool_completed"
        | "agent.approval_resolved" => 10,
        "analytics.health_reported"
        | "product.surface_opened"
        | "product.feature_exposed"
        | "app.started"
        | "app.startup_completed"
        | "app.update_transition" => 200,
        _ => 100,
    }
}

fn validate_value(kind: &AttrKind, value: &JsonValue) -> Result<(), String> {
    match kind {
        AttrKind::Enum(values) => {
            let value = value.as_str().ok_or("expected_string")?;
            if values.contains(&value) {
                Ok(())
            } else {
                Err("not_allowed".to_string())
            }
        }
        AttrKind::Uuid => {
            let value = value.as_str().ok_or("expected_string")?;
            if is_canonical_uuid(value) {
                Ok(())
            } else {
                Err("expected_uuid".to_string())
            }
        }
        AttrKind::Day => {
            let value = value.as_str().ok_or("expected_string")?;
            if is_utc_day(value) {
                Ok(())
            } else {
                Err("expected_day".to_string())
            }
        }
        AttrKind::Version => {
            let value = value.as_str().ok_or("expected_string")?;
            if is_version_shaped(value) {
                Ok(())
            } else {
                Err("expected_version".to_string())
            }
        }
        AttrKind::Int { minimum, maximum } => {
            let value = value.as_i64().ok_or("expected_integer")?;
            if value >= *minimum && value <= *maximum {
                Ok(())
            } else {
                Err("out_of_range".to_string())
            }
        }
        AttrKind::Bool => value
            .as_bool()
            .map(|_| ())
            .ok_or_else(|| "expected_boolean".to_string()),
    }
}

/// Version shape shared with the TypeScript registry and the private receiver:
/// one leading ASCII letter or digit followed by at most 63 characters from
/// `[0-9A-Za-z.+-]`.
///
/// The shape is deliberately narrow because `from_version`/`to_version` are the
/// only attribute path that carries a value originating outside this codebase.
/// It rejects a filesystem path, a URL, an error string, whitespace and any
/// non-ASCII text. It cannot tell a bare alphanumeric-dash identifier such as
/// `gpt-4o` from a release version; a vendor-qualified model id (`vendor/model`)
/// or a tagged one (`model:latest`) is rejected.
pub(crate) fn is_version_shaped(value: &str) -> bool {
    let mut bytes = value.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !first.is_ascii_alphanumeric() {
        return false;
    }
    let mut length = 1;
    for byte in bytes {
        if !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'+' | b'-')) {
            return false;
        }
        length += 1;
        if length > 64 {
            return false;
        }
    }
    true
}

fn is_utc_day(value: &str) -> bool {
    // Canonical `YYYY-MM-DD`: exactly four year digits, a hyphen, two month
    // digits, a hyphen, two day digits. This is the same rule the TypeScript
    // registry enforces with `^\d{4}-\d{2}-\d{2}$`, so neither validator
    // accepts a padded or short form the other rejects.
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        return false;
    }
    let mut parts = value.split('-');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let (Ok(year), Ok(month), Ok(day)) =
        (year.parse::<i32>(), month.parse::<u8>(), day.parse::<u8>())
    else {
        return false;
    };
    if !(1..=9999).contains(&year) {
        return false;
    }
    let Ok(month) = time::Month::try_from(month) else {
        return false;
    };
    time::Date::from_calendar_date(year, month, day).is_ok()
}

/// Canonical hyphenated UUID: `8-4-4-4-12` hexadecimal, case-insensitive.
///
/// This is the single rule shared with the TypeScript registry, so the two
/// validators accept and reject exactly the same strings.
pub(crate) fn is_canonical_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGAL_FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/services/AnalyticsService/fixtures/analytics-events.v1.json"
    ));
    const INVALID_FIXTURES: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/services/AnalyticsService/fixtures/analytics-events.invalid.v1.json"
    ));

    fn fixtures(json: &str) -> Vec<(String, JsonMap<String, JsonValue>)> {
        let document: JsonValue = serde_json::from_str(json).expect("fixture json");
        document["events"]
            .as_array()
            .expect("events array")
            .iter()
            .map(|event| {
                (
                    event["name"].as_str().expect("name").to_string(),
                    event["attributes"].as_object().expect("attributes").clone(),
                )
            })
            .collect()
    }

    #[test]
    fn user_gets_every_fixed_event_accepted_with_its_whitelist_attributes() {
        for (name, attributes) in fixtures(LEGAL_FIXTURES) {
            validate_event(&name, &attributes).unwrap_or_else(|error| {
                panic!("{name} should be accepted by Rust and TypeScript: {error}")
            });
        }
    }

    #[test]
    fn user_gets_unknown_events_and_attributes_rejected_before_persistence() {
        for (name, attributes) in fixtures(INVALID_FIXTURES) {
            assert!(
                validate_event(&name, &attributes).is_err(),
                "{name} should be rejected"
            );
        }
    }

    #[test]
    fn user_gets_the_fixture_registry_covering_all_nineteen_events() {
        let names = fixtures(LEGAL_FIXTURES)
            .into_iter()
            .map(|(name, _)| name)
            .collect::<Vec<_>>();

        assert_eq!(names.len(), 19);
        for name in names {
            assert!(AnalyticsEventName::parse(&name).is_some(), "{name}");
        }
    }

    #[test]
    fn user_gets_a_calendar_invalid_day_rejected() {
        let mut attributes = JsonMap::new();
        attributes.insert("configured".to_string(), JsonValue::Bool(true));
        attributes.insert(
            "first_observed_day".to_string(),
            JsonValue::String("2026-02-30".to_string()),
        );

        assert!(validate_event("analytics.session_started", &attributes).is_err());
    }

    #[test]
    fn user_gets_only_real_days_in_years_1_through_9999_when_submitting_observation_dates() {
        let document: JsonValue = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/services/AnalyticsService/fixtures/analytics-days.v1.json"
        )))
        .expect("shared day cases");

        for case in document["cases"].as_array().expect("day cases") {
            let day = case["day"].as_str().expect("day");
            let accepted = case["accepted"].as_bool().expect("expected acceptance");
            for key in ["first_observed_day", "first_success_day"] {
                let attributes = JsonMap::from_iter([
                    ("configured".to_string(), JsonValue::Bool(true)),
                    (key.to_string(), JsonValue::String(day.to_string())),
                ]);
                assert_eq!(
                    validate_event("analytics.session_started", &attributes).is_ok(),
                    accepted,
                    "{key}: {day:?}"
                );
            }
        }
    }

    #[test]
    fn user_gets_only_bounded_release_versions_accepted_when_submitting_update_versions() {
        // The TypeScript registry enforces the same shape with
        // `^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`, so neither validator accepts a
        // path, URL, error string, tagged model id or padded value the other
        // refuses.
        let max_length = "1".repeat(64);
        let too_long = "1".repeat(65);
        let cases = [
            ("1.2.3", true),
            ("1.2.3-beta.1+build.5", true),
            ("2026.10.1", true),
            ("0", true),
            (max_length.as_str(), true),
            (too_long.as_str(), false),
            ("", false),
            ("-1.2.3", false),
            (".1.2.3", false),
            ("/tmp/release/1.2.3", false),
            ("https://updates.touch-ai.org/1.2.3", false),
            ("Error: failed to read src/main.rs", false),
            ("openai/gpt-4o", false),
            ("gpt-4o:latest", false),
            ("1.2.3 ", false),
            ("1.2.3\n", false),
            ("1.2.3\r\n", false),
            ("1.2.3\u{2028}", false),
            ("1.2.3_rc1", false),
            ("1.2.3\u{4e2d}\u{6587}", false),
        ];

        for (value, accepted) in cases {
            for key in ["from_version", "to_version"] {
                let attributes = JsonMap::from_iter([
                    (
                        "update_operation_id".to_string(),
                        JsonValue::String("11111111-1111-4111-8111-111111111111".to_string()),
                    ),
                    (
                        "phase".to_string(),
                        JsonValue::String("check_started".to_string()),
                    ),
                    (
                        "result".to_string(),
                        JsonValue::String("success".to_string()),
                    ),
                    (
                        "source".to_string(),
                        JsonValue::String("background".to_string()),
                    ),
                    (key.to_string(), JsonValue::String(value.to_string())),
                ]);
                assert_eq!(
                    validate_event("app.update_transition", &attributes).is_ok(),
                    accepted,
                    "{key}: {value:?}"
                );
            }
        }
    }

    #[test]
    fn user_gets_paths_urls_and_error_text_rejected_when_submitting_update_versions() {
        let update = |from_version: &str, to_version: &str| {
            JsonMap::from_iter([
                (
                    "update_operation_id".to_string(),
                    JsonValue::String("11111111-1111-4111-8111-111111111111".to_string()),
                ),
                (
                    "phase".to_string(),
                    JsonValue::String("check_started".to_string()),
                ),
                (
                    "from_version".to_string(),
                    JsonValue::String(from_version.to_string()),
                ),
                (
                    "to_version".to_string(),
                    JsonValue::String(to_version.to_string()),
                ),
                (
                    "result".to_string(),
                    JsonValue::String("success".to_string()),
                ),
                (
                    "source".to_string(),
                    JsonValue::String("background".to_string()),
                ),
            ])
        };

        assert!(validate_event("app.update_transition", &update("1.2.1", "1.2.2")).is_ok());
        for (from_version, to_version) in [
            ("/tmp/build/1.2.2", "1.2.2"),
            ("1.2.1", "https://updates.touch-ai.org/1.2.2"),
            ("1.2.1", "Error: install failed"),
            ("1.2.1", "openai/gpt-4o"),
            ("1.2.1", ""),
        ] {
            assert!(
                validate_event("app.update_transition", &update(from_version, to_version)).is_err(),
                "{from_version:?} -> {to_version:?} must be rejected"
            );
        }
    }
}
