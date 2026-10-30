// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Umami-compatible HTTP adapter for the public single-event wire contract.
//!
//! The reverse proxy maps `{baseUrl}/send` straight to Umami's own `/api/send`;
//! there is no gateway transformation and no receiver-side idempotency in this
//! phase. Delivery is confirmed only by the exact success shape Umami returns,
//! never by a bare 2xx.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

/// Placeholders required by vanilla Umami. They are not geographic and the
/// proxy strips every client IP/geo header, so Umami stores no location.
pub(crate) const WIRE_HOSTNAME: &str = "touchai-desktop.invalid";
pub(crate) const WIRE_URL: &str = "/";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_LIMIT: usize = 32 * 1024;

/// The immutable, validated event body persisted locally and sent unchanged on
/// every retry. `eventId` and `occurredAtMs` never change.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AnalyticsEventEnvelope {
    pub(crate) schema_version: u32,
    pub(crate) event_id: String,
    pub(crate) occurred_at_ms: i64,
    pub(crate) installation_id: String,
    pub(crate) analytics_session_id: Option<String>,
    pub(crate) event_name: String,
    pub(crate) app_version: String,
    pub(crate) release_channel: String,
    pub(crate) os_family: String,
    pub(crate) architecture: String,
    pub(crate) attributes: JsonMap<String, JsonValue>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SendOutcome {
    /// Umami confirmed ingestion with its exact success body.
    Accepted,
    /// The server will never accept this event; delete and count it.
    PermanentRejection { reason: String },
    /// Endpoint/auth/path is wrong: stop sending and retry far later.
    ConfigurationFailure { reason: String },
    /// Honour the server's Retry-After before trying the same row again.
    RetryAfter { delay_ms: i64 },
    /// Transient failure; retry the same row with backoff.
    Retry { reason: String },
}

pub(crate) fn build_wire_body(
    envelope: &AnalyticsEventEnvelope,
    website_id: &str,
    client_sent_at_ms: i64,
) -> Result<JsonValue, String> {
    let mut data = envelope.attributes.clone();
    data.insert(
        "event_id".to_string(),
        JsonValue::String(envelope.event_id.clone()),
    );
    data.insert(
        "occurred_at_ms".to_string(),
        JsonValue::Number(envelope.occurred_at_ms.into()),
    );
    data.insert(
        "schema_version".to_string(),
        JsonValue::Number(envelope.schema_version.into()),
    );
    if let Some(session_id) = &envelope.analytics_session_id {
        data.insert(
            "analytics_session_id".to_string(),
            JsonValue::String(session_id.clone()),
        );
    }
    data.insert(
        "app_version".to_string(),
        JsonValue::String(envelope.app_version.clone()),
    );
    data.insert(
        "release_channel".to_string(),
        JsonValue::String(envelope.release_channel.clone()),
    );
    data.insert(
        "os_family".to_string(),
        JsonValue::String(envelope.os_family.clone()),
    );
    data.insert(
        "architecture".to_string(),
        JsonValue::String(envelope.architecture.clone()),
    );
    data.insert(
        "client_sent_at_ms".to_string(),
        JsonValue::Number(client_sent_at_ms.into()),
    );

    let payload = JsonValue::Object(JsonMap::from_iter([
        (
            "website".to_string(),
            JsonValue::String(website_id.to_string()),
        ),
        (
            "id".to_string(),
            JsonValue::String(envelope.installation_id.clone()),
        ),
        (
            "name".to_string(),
            JsonValue::String(envelope.event_name.clone()),
        ),
        (
            "timestamp".to_string(),
            JsonValue::Number((envelope.occurred_at_ms.div_euclid(1000)).into()),
        ),
        (
            "hostname".to_string(),
            JsonValue::String(WIRE_HOSTNAME.to_string()),
        ),
        ("url".to_string(), JsonValue::String(WIRE_URL.to_string())),
        ("data".to_string(), JsonValue::Object(data)),
    ]));

    Ok(JsonValue::Object(JsonMap::from_iter([
        ("type".to_string(), JsonValue::String("event".to_string())),
        ("payload".to_string(), payload),
    ])))
}

/// Vanilla Umami answers a successfully ingested event with a JSON object
/// containing `beep: "boop"`. Anything else (a bare 2xx, a bot page, a health
/// check) is not a confirmed delivery and the row is retried.
pub(crate) fn is_analytics_acceptance(body: &[u8]) -> bool {
    match serde_json::from_slice::<JsonValue>(body) {
        Ok(JsonValue::Object(map)) => map.get("beep").and_then(JsonValue::as_str) == Some("boop"),
        _ => false,
    }
}

pub(crate) fn classify_response(
    status: u16,
    body: &[u8],
    retry_after_seconds: Option<i64>,
) -> SendOutcome {
    if (200..300).contains(&status) && is_analytics_acceptance(body) {
        return SendOutcome::Accepted;
    }
    match status {
        400 | 413 | 422 => SendOutcome::PermanentRejection {
            reason: format!("rejected_status_{status}"),
        },
        401 | 403 | 404 | 410 => SendOutcome::ConfigurationFailure {
            reason: format!("configuration_status_{status}"),
        },
        429 => SendOutcome::RetryAfter {
            delay_ms: retry_after_seconds.unwrap_or(60).clamp(1, 3600) * 1000,
        },
        _ => SendOutcome::Retry {
            reason: format!("unexpected_status_{status}"),
        },
    }
}

pub(crate) fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<i64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<i64>()
        .ok()
}

pub(crate) struct AnalyticsTransport {
    client: reqwest::Client,
    send_url: String,
    website_id: String,
}

impl AnalyticsTransport {
    pub(crate) fn new(send_url: String, website_id: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("Failed to build analytics http client: {error}"))?;
        Ok(Self {
            client,
            send_url,
            website_id,
        })
    }

    pub(crate) async fn send(&self, envelope: &AnalyticsEventEnvelope) -> SendOutcome {
        let now = super::store::now_millis();
        let body = match build_wire_body(envelope, &self.website_id, now) {
            Ok(body) => body,
            Err(error) => {
                return SendOutcome::PermanentRejection {
                    reason: format!("wire_build_failed:{error}"),
                };
            }
        };

        let response = self
            .client
            .post(&self.send_url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body.to_string())
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                return SendOutcome::Retry {
                    reason: format!("transport_error:{error}"),
                };
            }
        };

        let status = response.status().as_u16();
        let retry_after = parse_retry_after(response.headers());
        if let Some(length) = response.content_length() {
            if length as usize > RESPONSE_LIMIT {
                return SendOutcome::Retry {
                    reason: "response_too_large".to_string(),
                };
            }
        }
        let body = response.bytes().await.unwrap_or_default();
        if body.len() > RESPONSE_LIMIT {
            return SendOutcome::Retry {
                reason: "response_too_large".to_string(),
            };
        }
        classify_response(status, &body, retry_after)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope() -> AnalyticsEventEnvelope {
        AnalyticsEventEnvelope {
            schema_version: 1,
            event_id: "1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a701".to_string(),
            occurred_at_ms: 1_760_000_000_000,
            installation_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_string(),
            analytics_session_id: Some("0f1c2a3b-4d5e-4f60-8a91-b2c3d4e5f601".to_string()),
            event_name: "app.started".to_string(),
            app_version: "1.2.2".to_string(),
            release_channel: "stable".to_string(),
            os_family: "linux".to_string(),
            architecture: "x86_64".to_string(),
            attributes: JsonMap::from_iter([
                (
                    "run_id".to_string(),
                    JsonValue::String("92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09".to_string()),
                ),
                (
                    "startup_source".to_string(),
                    JsonValue::String("foreground".to_string()),
                ),
            ]),
        }
    }

    #[test]
    fn user_gets_the_umami_required_website_hostname_and_url_in_one_wire_event() {
        let wire = build_wire_body(
            &envelope(),
            "11111111-1111-4111-8111-111111111111",
            1_760_000_000_500,
        )
        .expect("wire body");

        assert_eq!(wire["type"], "event");
        assert_eq!(
            wire["payload"]["website"],
            "11111111-1111-4111-8111-111111111111"
        );
        assert_eq!(
            wire["payload"]["id"],
            "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
        );
        assert_eq!(wire["payload"]["name"], "app.started");
        assert_eq!(wire["payload"]["timestamp"], 1_760_000_000_i64);
        assert_eq!(wire["payload"]["hostname"], WIRE_HOSTNAME);
        assert_eq!(wire["payload"]["url"], WIRE_URL);
        assert_eq!(
            wire["payload"]["data"]["event_id"],
            "1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a701"
        );
        assert_eq!(
            wire["payload"]["data"]["run_id"],
            "92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09"
        );
    }

    #[test]
    fn user_does_not_lose_an_event_when_only_a_bare_2xx_returns() {
        assert!(!is_analytics_acceptance(b""));
        assert!(!is_analytics_acceptance(b"<html>bot check</html>"));
        assert_eq!(
            classify_response(200, b"{\"ok\":true}", None),
            SendOutcome::Retry {
                reason: "unexpected_status_200".to_string()
            }
        );
    }

    #[test]
    fn user_gets_delivery_only_from_the_umami_success_body() {
        assert!(is_analytics_acceptance(br#"{"beep":"boop"}"#));
        assert_eq!(
            classify_response(200, br#"{"beep":"boop"}"#, None),
            SendOutcome::Accepted
        );
    }

    #[test]
    fn user_gets_permanent_rejections_and_config_failures_separated() {
        assert!(matches!(
            classify_response(400, b"bad", None),
            SendOutcome::PermanentRejection { .. }
        ));
        assert!(matches!(
            classify_response(404, b"", None),
            SendOutcome::ConfigurationFailure { .. }
        ));
        assert_eq!(
            classify_response(429, b"", Some(30)),
            SendOutcome::RetryAfter { delay_ms: 30_000 }
        );
    }
}
