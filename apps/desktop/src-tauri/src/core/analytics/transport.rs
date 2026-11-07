// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Durable batch HTTP adapter for the R2-first analytics receiver.
//!
//! The native outbox remains the only local queue. One request carries up to the
//! runtime's existing send-batch limit, is gzip-compressed, and has a stable
//! client batch id derived from the immutable event ids. The receiver must
//! confirm that the archive write succeeded before the runtime deletes rows.

use std::{future::Future, io::Write, pin::Pin, time::Duration};

use flate2::{write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_LIMIT: usize = 32 * 1024;
const BATCH_ID_DOMAIN: &[u8] = b"touchai-analytics-batch-v1";

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

/// One immutable HTTP batch. Retries reuse the same ordered events, batch id and
/// gzipped body so receiver idempotency does not depend on recomputing either.
#[derive(Debug, Clone)]
pub(crate) struct PreparedAnalyticsBatch {
    pub(crate) events: Vec<AnalyticsEventEnvelope>,
    pub(crate) batch_id: String,
    pub(crate) encoded_body: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SendOutcome {
    /// R2 confirmed persistence for the whole batch.
    Accepted,
    /// Endpoint, project id, schema or batch contract drift. Keep every row and
    /// retry later rather than discarding a whole valid batch because one request
    /// was rejected.
    ConfigurationFailure { reason: String },
    /// Honour the server's Retry-After before trying the same rows again.
    RetryAfter { delay_ms: i64 },
    /// Transient failure; retry the same rows with backoff.
    Retry { reason: String },
}

/// Object-safe sender so the runtime can be exercised with a test double. The
/// production implementation is [`AnalyticsTransport`].
pub(crate) trait EventSender: Send + Sync {
    fn send_batch<'a>(
        &'a self,
        batch: &'a PreparedAnalyticsBatch,
    ) -> Pin<Box<dyn Future<Output = SendOutcome> + Send + 'a>>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchWireBody<'a> {
    schema_version: u32,
    events: &'a [AnalyticsEventEnvelope],
}

fn batch_body_bytes(events: &[AnalyticsEventEnvelope]) -> Result<Vec<u8>, String> {
    if events.is_empty() {
        return Err("empty_batch".to_string());
    }
    serde_json::to_vec(&BatchWireBody {
        schema_version: 1,
        events,
    })
    .map_err(|error| format!("serialize_batch:{error}"))
}

/// A UUID-shaped identifier derived from the exact ordered event id set. Reusing
/// the same outbox rows therefore produces the same receiver key even if the
/// original HTTP response was lost.
pub(crate) fn batch_id(events: &[AnalyticsEventEnvelope]) -> Result<String, String> {
    if events.is_empty() {
        return Err("empty_batch".to_string());
    }
    let mut hasher = Sha256::new();
    hasher.update(BATCH_ID_DOMAIN);
    for event in events {
        hasher.update([0]);
        hasher.update(event.event_id.as_bytes());
    }
    let mut bytes: [u8; 16] = hasher.finalize()[..16]
        .try_into()
        .map_err(|_| "batch_id_digest_length".to_string())?;
    // RFC 4122 version 5-shaped identifier so the receiver can apply its common
    // canonical UUID validation even though the namespace hash is domain-owned.
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(uuid::Uuid::from_bytes(bytes).to_string())
}

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(bytes)
        .map_err(|error| format!("gzip_write:{error}"))?;
    encoder
        .finish()
        .map_err(|error| format!("gzip_finish:{error}"))
}

pub(crate) fn prepare_batch(
    events: &[AnalyticsEventEnvelope],
) -> Result<PreparedAnalyticsBatch, String> {
    let batch_id = batch_id(events)?;
    let encoded_body = batch_body_bytes(events).and_then(|body| gzip(&body))?;
    Ok(PreparedAnalyticsBatch {
        events: events.to_vec(),
        batch_id,
        encoded_body,
    })
}

/// The receiver answers 202 with the exact stable batch id, stored event count
/// and `stored: true` only after R2 persistence. A bare 2xx is not acceptance.
pub(crate) fn is_batch_acceptance(
    body: &[u8],
    expected_batch_id: &str,
    expected_event_count: usize,
) -> bool {
    let Ok(JsonValue::Object(map)) = serde_json::from_slice::<JsonValue>(body) else {
        return false;
    };
    map.get("stored").and_then(JsonValue::as_bool) == Some(true)
        && map.get("batchId").and_then(JsonValue::as_str) == Some(expected_batch_id)
        && map.get("eventCount").and_then(JsonValue::as_u64) == Some(expected_event_count as u64)
}

pub(crate) fn classify_response(
    status: u16,
    body: &[u8],
    expected_batch_id: &str,
    expected_event_count: usize,
    retry_after_seconds: Option<i64>,
) -> SendOutcome {
    if (200..300).contains(&status) {
        if is_batch_acceptance(body, expected_batch_id, expected_event_count) {
            return SendOutcome::Accepted;
        }
        return SendOutcome::Retry {
            reason: format!("unconfirmed_success_body_{status}"),
        };
    }
    match status {
        // Batch-level rejection is deliberately not converted into deleting each
        // row. A receiver/schema rollout mismatch must not erase a valid local
        // queue; rows remain bounded by the existing 72-hour TTL.
        400 | 409 | 413 | 415 | 422 => SendOutcome::ConfigurationFailure {
            reason: format!("batch_rejected_status_{status}"),
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
    batch_url: String,
    project_id: String,
}

impl AnalyticsTransport {
    pub(crate) fn new(batch_url: String, project_id: String) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| format!("Failed to build analytics http client: {error}"))?;
        Ok(Self {
            client,
            batch_url,
            project_id,
        })
    }

    pub(crate) async fn send_batch(&self, batch: &PreparedAnalyticsBatch) -> SendOutcome {
        let response = self
            .client
            .post(&self.batch_url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::CONTENT_ENCODING, "gzip")
            .header("x-touchai-batch-id", &batch.batch_id)
            .header("x-touchai-project-id", &self.project_id)
            .body(batch.encoded_body.clone())
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
        classify_response(
            status,
            &body,
            &batch.batch_id,
            batch.events.len(),
            retry_after,
        )
    }
}

impl EventSender for AnalyticsTransport {
    fn send_batch<'a>(
        &'a self,
        batch: &'a PreparedAnalyticsBatch,
    ) -> Pin<Box<dyn Future<Output = SendOutcome> + Send + 'a>> {
        Box::pin(async move { AnalyticsTransport::send_batch(self, batch).await })
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use flate2::read::GzDecoder;

    use super::*;

    fn envelope(event_id: &str, event_name: &str) -> AnalyticsEventEnvelope {
        AnalyticsEventEnvelope {
            schema_version: 1,
            event_id: event_id.to_string(),
            occurred_at_ms: 1_760_000_000_000,
            installation_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_string(),
            analytics_session_id: Some("0f1c2a3b-4d5e-4f60-8a91-b2c3d4e5f601".to_string()),
            event_name: event_name.to_string(),
            app_version: "1.2.2".to_string(),
            release_channel: "stable".to_string(),
            os_family: "linux".to_string(),
            architecture: "x86_64".to_string(),
            attributes: JsonMap::from_iter([(
                "run_id".to_string(),
                JsonValue::String("92a3b4c5-d6e7-4bf8-8c09-eafb0c1d2e09".to_string()),
            )]),
        }
    }

    #[test]
    fn user_gets_one_gzip_batch_with_a_stable_uuid_from_the_event_ids() {
        let events = vec![
            envelope(
                "1a2b3c4d-5e6f-4a70-8b91-c2d3e4f5a701",
                "analytics.session_started",
            ),
            envelope(
                "2b3c4d5e-6f70-4b81-9ca2-d3e4f5a6b702",
                "agent.request_submitted",
            ),
        ];
        let first = batch_id(&events).expect("batch id");
        let second = batch_id(&events).expect("stable batch id");
        assert_eq!(first, second);
        assert_eq!(&first[14..15], "5", "version nibble");
        assert!(matches!(&first[19..20], "8" | "9" | "a" | "b"));

        let body = batch_body_bytes(&events).expect("batch json");
        let compressed = gzip(&body).expect("gzip");
        let mut decoded = Vec::new();
        GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut decoded)
            .expect("gunzip");
        assert_eq!(decoded, body);

        let wire: JsonValue = serde_json::from_slice(&body).expect("wire json");
        assert_eq!(wire["schemaVersion"], 1);
        assert_eq!(wire["events"].as_array().expect("events").len(), 2);
        assert!(wire["events"][0].get("clientSentAtMs").is_none());
    }

    #[test]
    fn user_does_not_lose_rows_when_only_a_bare_2xx_returns() {
        let batch_id = "11111111-1111-5111-8111-111111111111";
        assert!(!is_batch_acceptance(b"", batch_id, 2));
        assert!(!is_batch_acceptance(b"{\"stored\":true}", batch_id, 2));
        assert_eq!(
            classify_response(202, br#"{"ok":true}"#, batch_id, 2, None),
            SendOutcome::Retry {
                reason: "unconfirmed_success_body_202".to_string()
            }
        );
    }

    #[test]
    fn user_gets_delivery_only_from_the_exact_archive_acknowledgement() {
        let batch_id = "11111111-1111-5111-8111-111111111111";
        let success =
            br#"{"stored":true,"batchId":"11111111-1111-5111-8111-111111111111","eventCount":2}"#;
        assert!(is_batch_acceptance(success, batch_id, 2));
        assert_eq!(
            classify_response(202, success, batch_id, 2, None),
            SendOutcome::Accepted
        );
        assert!(!is_batch_acceptance(success, batch_id, 1));
    }

    #[test]
    fn user_keeps_a_batch_when_the_receiver_rejects_the_batch_contract() {
        let batch_id = "11111111-1111-5111-8111-111111111111";
        for status in [400, 409, 413, 415, 422, 401, 403, 404, 410] {
            assert!(
                matches!(
                    classify_response(status, b"", batch_id, 2, None),
                    SendOutcome::ConfigurationFailure { .. }
                ),
                "status {status}"
            );
        }
        assert_eq!(
            classify_response(429, b"", batch_id, 2, Some(30)),
            SendOutcome::RetryAfter { delay_ms: 30_000 }
        );
        assert!(matches!(
            classify_response(503, b"", batch_id, 2, None),
            SendOutcome::Retry { .. }
        ));
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
