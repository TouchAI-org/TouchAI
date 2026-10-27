// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 前端日志批量入口。
//!
//! 前端负责采集和脱敏，这里负责兜底：限制批次和行长度、按字段名再脱敏一次，
//! 最后组装成一行可解析的 logfmt 记录。

use std::collections::BTreeMap;

use log::Level;
use serde::Deserialize;
use serde_json::Value;

use super::format::{escape_value, OBS_TARGET};

const MAX_BATCH_SIZE: usize = 200;
const MAX_LINE_BYTES: usize = 4096;
const MAX_EVENT_NAME_LENGTH: usize = 64;
const REDACTED: &str = "[redacted]";

/// 一条前端事件。字段名与 `ObservabilityService` 的线上格式一致。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEnvelope {
    pub level: u8,
    pub event: String,
    #[serde(default)]
    pub window: Option<String>,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub span_id: Option<String>,
    #[serde(default)]
    pub msg: Option<String>,
    #[serde(default)]
    pub attrs: BTreeMap<String, Value>,
}

impl LogEnvelope {
    fn level(&self) -> Level {
        match self.level {
            1 => Level::Trace,
            2 => Level::Debug,
            4 => Level::Warn,
            5 => Level::Error,
            _ => Level::Info,
        }
    }

    /// 组装 `event run=... k=v msg="..."`，不含时间戳前缀。
    pub(crate) fn to_line(&self, run: &str) -> String {
        let mut fields = Vec::with_capacity(self.attrs.len() + 6);
        fields.push(format!("run={}", escape_value(run)));

        if let Some(window) = &self.window {
            fields.push(format!("window={}", escape_value(window)));
        }
        if let Some(trace_id) = &self.trace_id {
            fields.push(format!("trace_id={}", escape_value(trace_id)));
        }
        if let Some(span_id) = &self.span_id {
            fields.push(format!("span_id={}", escape_value(span_id)));
        }

        for (key, value) in &self.attrs {
            let key = sanitize_key(key);
            if key.is_empty() {
                continue;
            }
            if is_secret_key(&key) {
                fields.push(format!("{key}={REDACTED}"));
                continue;
            }
            if let Some(value) = format_value(value) {
                fields.push(format!("{key}={value}"));
            }
        }

        let mut truncated = false;
        if let Some(message) = &self.msg {
            truncated = message.len() > 1024;
            let message = truncate(message, 1024);
            fields.push(format!("msg={}", escape_value(&message)));
        }

        let mut line = format!("{} {}", sanitize_event_name(&self.event), fields.join(" "));
        if truncated || line.len() > MAX_LINE_BYTES {
            line = truncate(
                &line,
                MAX_LINE_BYTES.saturating_sub(" truncated=true".len()),
            );
            line.push_str(" truncated=true");
        }
        line
    }
}

/// 批次入口。超出上限的部分直接丢弃，不阻塞调用方。
pub fn ingest_batch(batch: Vec<LogEnvelope>) -> Result<(), String> {
    let run = super::run_id().to_string();

    for envelope in batch.into_iter().take(MAX_BATCH_SIZE) {
        log::log!(target: OBS_TARGET, envelope.level(), "{}", envelope.to_line(&run));
    }

    Ok(())
}

/// 返回本次运行的稳定标识，供前端日志对齐 Rust 日志。
pub fn run_id_string() -> String {
    super::run_id().to_string()
}

fn sanitize_event_name(event: &str) -> String {
    let normalized = event.to_ascii_lowercase();
    let sanitized: String = normalized
        .chars()
        .filter(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
        .take(MAX_EVENT_NAME_LENGTH)
        .collect();

    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
    }
}

fn sanitize_key(key: &str) -> String {
    key.to_ascii_lowercase()
        .chars()
        .filter(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '.' | '_' | '-')
        })
        .take(64)
        .collect()
}

fn is_secret_key(key: &str) -> bool {
    key.split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .any(|part| {
            matches!(
                part,
                "authorization"
                    | "cookie"
                    | "password"
                    | "passwd"
                    | "secret"
                    | "token"
                    | "key"
                    | "apikey"
                    | "credential"
            )
        })
}

fn format_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::String(value) => Some(escape_value(&truncate(value, 1024))),
        Value::Array(_) | Value::Object(_) => {
            let serialized = serde_json::to_string(value).ok()?;
            Some(format!("<json bytes={}>", serialized.len()))
        }
    }
}

fn truncate(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope(event: &str) -> LogEnvelope {
        LogEnvelope {
            level: 4,
            event: event.to_string(),
            window: Some("main".to_string()),
            trace_id: Some("4bf92f3577b34da6a3ce929d0e0e4736".to_string()),
            span_id: Some("00f067aa0ba902b7".to_string()),
            msg: None,
            attrs: BTreeMap::new(),
        }
    }

    #[test]
    fn user_sees_run_trace_and_window_on_every_event() {
        let mut event = envelope("agent.request.failed");
        event
            .attrs
            .insert("error.code".to_string(), json!("provider.rate_limited"));

        let line = event.to_line("7f3a9c");

        assert_eq!(
            line,
            "agent.request.failed run=7f3a9c window=main \
             trace_id=4bf92f3577b34da6a3ce929d0e0e4736 span_id=00f067aa0ba902b7 \
             error.code=provider.rate_limited"
        );
    }

    #[test]
    fn user_does_not_see_secret_attributes_in_the_log() {
        let mut event = envelope("mcp.connect.failed");
        event
            .attrs
            .insert("authorization".to_string(), json!("Bearer secret-value"));
        event
            .attrs
            .insert("api_token".to_string(), json!("secret-token"));

        let line = event.to_line("7f3a9c");

        assert!(!line.contains("secret-value"));
        assert!(!line.contains("secret-token"));
        assert!(line.contains("authorization=[redacted]"));
    }

    #[test]
    fn user_does_not_see_secret_attributes_written_in_mixed_case() {
        let mut event = envelope("mcp.connect.failed");
        event
            .attrs
            .insert("Authorization".to_string(), json!("Bearer secret-value"));
        event
            .attrs
            .insert("apiKey".to_string(), json!("secret-token"));

        let line = event.to_line("7f3a9c");

        assert!(!line.contains("secret-value"));
        assert!(!line.contains("secret-token"));
        assert!(line.contains("authorization=[redacted]"));
        assert!(line.contains("apikey=[redacted]"));
    }

    #[test]
    fn user_gets_a_single_line_even_when_the_message_has_newlines() {
        let mut event = envelope("legacy.console");
        event.msg = Some("first\nsecond\rthird".to_string());

        let line = event.to_line("7f3a9c");

        assert!(!line.contains('\n'));
        assert!(!line.contains('\r'));
    }

    #[test]
    fn user_gets_a_bounded_line_when_the_payload_is_huge() {
        let mut event = envelope("legacy.console");
        event.msg = Some("x".repeat(20_000));

        let line = event.to_line("7f3a9c");

        assert!(line.len() <= MAX_LINE_BYTES);
        assert!(line.ends_with("truncated=true"));
    }

    #[test]
    fn user_gets_an_unknown_event_name_replaced() {
        let mut event = envelope("Agent Request Failed!");
        event.event = "Agent Request Failed!".to_string();

        let line = event.to_line("7f3a9c");

        assert!(line.starts_with("agentrequestfailed "));
    }
}
