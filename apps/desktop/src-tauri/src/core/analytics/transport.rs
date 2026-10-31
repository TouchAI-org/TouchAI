// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Umami-compatible HTTP adapter for the public single-event wire contract.
//!
//! The reverse proxy maps `{baseUrl}/send` straight to Umami's own `/api/send`;
//! there is no gateway transformation and no receiver-side idempotency in this
//! phase. Delivery is confirmed only by the exact success shape Umami returns,
//! never by a bare 2xx.

use std::{future::Future, pin::Pin, time::Duration};

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
    /// Umami saved the event and answered with its normal success body.
    Accepted,
    /// The server will never accept this event; delete and count it.
    PermanentRejection { reason: String },
    /// Endpoint/auth/path or protocol/UA is wrong: stop sending and retry far later.
    ConfigurationFailure { reason: String },
    /// Honour the server's Retry-After before trying the same row again.
    RetryAfter { delay_ms: i64 },
    /// Transient failure; retry the same row with backoff.
    Retry { reason: String },
}

/// Object-safe sender so the runtime can be exercised with a test double. The
/// production implementation is [`AnalyticsTransport`].
pub(crate) trait EventSender: Send + Sync {
    fn send<'a>(
        &'a self,
        envelope: &'a AnalyticsEventEnvelope,
    ) -> Pin<Box<dyn Future<Output = SendOutcome> + Send + 'a>>;
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

/// Umami v3.4.1 `POST /api/send` saves the event and then answers with
/// `{ cache, sessionId, visitId }`. Only that normal success shape counts as a
/// delivery; a bare 2xx, an error envelope or any other body is not.
pub(crate) fn is_analytics_acceptance(body: &[u8]) -> bool {
    fn non_empty_string(map: &JsonMap<String, JsonValue>, key: &str) -> bool {
        map.get(key)
            .and_then(JsonValue::as_str)
            .is_some_and(|value| !value.is_empty())
    }
    match serde_json::from_slice::<JsonValue>(body) {
        Ok(JsonValue::Object(map)) => {
            non_empty_string(&map, "sessionId") && non_empty_string(&map, "visitId")
        }
        _ => false,
    }
}

/// Umami returns `{ beep: "boop" }` from the bot check, before any event is
/// saved. It is a 200 that means "not stored", so it must never be treated as a
/// delivery. It is a fixed protocol/User-Agent fault, not a per-event problem.
pub(crate) fn is_bot_rejection(body: &[u8]) -> bool {
    matches!(
        serde_json::from_slice::<JsonValue>(body),
        Ok(JsonValue::Object(map))
            if map.get("beep").and_then(JsonValue::as_str) == Some("boop")
    )
}

pub(crate) fn classify_response(
    status: u16,
    body: &[u8],
    retry_after_seconds: Option<i64>,
) -> SendOutcome {
    if (200..300).contains(&status) {
        if is_analytics_acceptance(body) {
            return SendOutcome::Accepted;
        }
        if is_bot_rejection(body) {
            // Bot rejection is a fixed protocol/UA configuration fault: pause and
            // retry with bounded backoff rather than discarding the event.
            return SendOutcome::ConfigurationFailure {
                reason: "bot_rejected".to_string(),
            };
        }
        return SendOutcome::Retry {
            reason: format!("unconfirmed_success_body_{status}"),
        };
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
    let value = headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .to_string();
    if let Ok(seconds) = value.parse::<i64>() {
        return Some(seconds);
    }
    // HTTP-date form (IMF-fixdate), e.g. "Wed, 21 Oct 2015 07:28:00 GMT".
    let when = http_date_epoch_seconds(&value)?;
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    Some((when - now).max(0))
}

/// Parses an IMF-fixdate HTTP-date into Unix seconds without the `time`
/// `parsing` feature. Returns `None` for any other format.
fn http_date_epoch_seconds(value: &str) -> Option<i64> {
    let rest = value.trim().split_once(", ")?.1;
    let mut parts = rest.split_whitespace();
    let day: u8 = parts.next()?.parse().ok()?;
    let month = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i32 = parts.next()?.parse().ok()?;
    let mut clock = parts.next()?.split(':');
    let hour: u8 = clock.next()?.parse().ok()?;
    let minute: u8 = clock.next()?.parse().ok()?;
    let second: u8 = clock.next()?.parse().ok()?;
    if !matches!(parts.next(), Some("GMT" | "UTC")) {
        return None;
    }
    let month = time::Month::try_from(month).ok()?;
    let date = time::Date::from_calendar_date(year, month, day).ok()?;
    let time = time::Time::from_hms(hour, minute, second).ok()?;
    Some(
        time::PrimitiveDateTime::new(date, time)
            .assume_utc()
            .unix_timestamp(),
    )
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
        // `client_sent_at_ms` is an ephemeral transport field: it records when this
        // attempt left the client. The server's report fingerprint excludes it, so
        // the stored event_id/occurred_at/core stay immutable across retries.
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

impl EventSender for AnalyticsTransport {
    fn send<'a>(
        &'a self,
        envelope: &'a AnalyticsEventEnvelope,
    ) -> Pin<Box<dyn Future<Output = SendOutcome> + Send + 'a>> {
        Box::pin(async move { AnalyticsTransport::send(self, envelope).await })
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
        assert_eq!(
            wire["payload"]["data"]["client_sent_at_ms"],
            1_760_000_000_500_i64
        );
    }

    #[test]
    fn user_does_not_lose_an_event_when_only_a_bare_2xx_returns() {
        assert!(!is_analytics_acceptance(b""));
        assert!(!is_analytics_acceptance(b"<html>bot check</html>"));
        assert_eq!(
            classify_response(200, b"{\"ok\":true}", None),
            SendOutcome::Retry {
                reason: "unconfirmed_success_body_200".to_string()
            }
        );
    }

    #[test]
    fn user_gets_delivery_only_from_the_umami_normal_success_body() {
        let success = br#"{"cache":"token","sessionId":"0f1c2a3b-4d5e-4f60-8a91-b2c3d4e5f601","visitId":"7a8b9c0d-1e2f-4031-8456-7890abcdef01"}"#;
        assert!(is_analytics_acceptance(success));
        assert_eq!(classify_response(200, success, None), SendOutcome::Accepted);
        // A success body missing the session/visit ids is not a delivery.
        assert!(!is_analytics_acceptance(br#"{"cache":"token"}"#));
    }

    #[test]
    fn user_keeps_the_event_when_umami_bot_rejects_with_beep() {
        assert!(!is_analytics_acceptance(br#"{"beep":"boop"}"#));
        assert!(is_bot_rejection(br#"{"beep":"boop"}"#));
        assert_eq!(
            classify_response(200, br#"{"beep":"boop"}"#, None),
            SendOutcome::ConfigurationFailure {
                reason: "bot_rejected".to_string()
            }
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

    #[test]
    fn user_gets_retry_after_from_an_http_date() {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::RETRY_AFTER,
            "Wed, 21 Oct 2015 07:28:00 GMT".parse().unwrap(),
        );
        // A past HTTP-date clamps to zero rather than a negative delay.
        assert_eq!(parse_retry_after(&headers), Some(0));
    }
}
