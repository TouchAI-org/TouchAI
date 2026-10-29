// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 前端日志批量入口。
//!
//! 前端负责采集和脱敏，这里负责兜底：限制批次和行长度、按字段名再脱敏一次，
//! 最后组装成一行可解析的 logfmt 记录。

use std::collections::BTreeMap;

use log::Level;
use serde::Deserialize;
use serde_json::Value;

use crate::core::mcp::redact::{looks_like_secret_value, redact_url};

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
            let sanitized = sanitize_key(key);
            if sanitized.is_empty() {
                continue;
            }
            if is_secret_key(key) {
                fields.push(format!("{sanitized}={REDACTED}"));
                continue;
            }
            if let Some(value) = format_value(value) {
                fields.push(format!("{sanitized}={value}"));
            }
        }

        let mut truncated = false;
        if let Some(message) = &self.msg {
            let message = redact_value_text(message);
            truncated = message.len() > 1024;
            let message = truncate(&message, 1024);
            fields.push(format!("msg={}", escape_value(&message)));
        }

        // 按整字段裁剪：半个字段（例如截断的引号值）会让 logfmt 解析出错。
        let budget = MAX_LINE_BYTES.saturating_sub(" truncated=true".len());
        let mut line = sanitize_event_name(&self.event);
        for field in fields {
            if line.len() + 1 + field.len() > budget {
                truncated = true;
                break;
            }
            line.push(' ');
            line.push_str(&field);
        }

        if truncated {
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

/// 字段名先按 camelCase 拆词，避免 `accessToken` 被当成一个普通单词放过。
fn key_parts(key: &str) -> Vec<String> {
    let characters: Vec<char> = key.chars().collect();
    let mut split = String::with_capacity(key.len() + 4);

    for (index, character) in characters.iter().enumerate() {
        let previous = index.checked_sub(1).map(|position| characters[position]);
        let next = characters.get(index + 1);
        let starts_word = previous.is_some_and(|previous| {
            previous.is_ascii_lowercase()
                || previous.is_ascii_digit()
                || (previous.is_ascii_uppercase()
                    && next.is_some_and(|next| next.is_ascii_lowercase()))
        });

        if starts_word && character.is_ascii_uppercase() {
            split.push('_');
        }
        split.push(*character);
    }

    split
        .to_ascii_lowercase()
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_secret_key(key: &str) -> bool {
    // 拆词之外再比一次整键：`ToKen` 会被拆成 `to` 和 `ken`，整键匹配才认得出。
    let normalized: String = key
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();

    is_secret_word(&normalized) || key_parts(key).iter().any(|part| is_secret_word(part))
}

fn is_secret_word(word: &str) -> bool {
    matches!(
        word,
        "authorization"
            | "cookie"
            | "password"
            | "passwd"
            | "secret"
            | "token"
            | "key"
            | "apikey"
            | "credential"
            | "auth"
    )
}

fn format_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(value) => Some(value.to_string()),
        Value::Number(value) => Some(value.to_string()),
        Value::String(value) => Some(escape_value(&truncate(&redact_value_text(value), 1024))),
        Value::Array(_) | Value::Object(_) => {
            let serialized = serde_json::to_string(value).ok()?;
            Some(format!("<json bytes={}>", serialized.len()))
        }
    }
}

/// 字段名没有密钥含义时，值本身仍可能带 URL 凭据、Bearer 令牌或独立令牌。
/// 这里按空白逐 token 扫描，并保留原有分隔符，避免改变日志的可读性。
fn redact_value_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut redact = Redact::None;

    for segment in value.split_inclusive(char::is_whitespace) {
        let token = segment.trim_end_matches(char::is_whitespace);
        let whitespace = &segment[token.len()..];

        if token.is_empty() {
            output.push_str(whitespace);
            continue;
        }

        let (prefix, core, suffix) = split_wrapping_punctuation(token);
        let redacted = match redact {
            Redact::Rest => REDACTED.to_string(),
            Redact::OneToken => {
                redact = Redact::None;
                REDACTED.to_string()
            }
            Redact::None => {
                if core.eq_ignore_ascii_case("bearer") || core.eq_ignore_ascii_case("basic") {
                    redact = Redact::OneToken;
                    core.to_string()
                } else if core.eq_ignore_ascii_case("digest") {
                    // Digest 后面是整段参数列表，只盖住第一个 token 会漏掉其余部分。
                    redact = Redact::Rest;
                    core.to_string()
                } else {
                    redact_free_token(core)
                }
            }
        };

        output.push_str(prefix);
        output.push_str(&redacted);
        output.push_str(suffix);
        output.push_str(whitespace);
    }

    output
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Redact {
    None,
    OneToken,
    Rest,
}

fn redact_free_token(token: &str) -> String {
    if is_url_like(token) {
        return redact_url(token);
    }
    if let Some((name, value)) = token.split_once('=') {
        if is_secret_key(name) || looks_like_secret_value(value) {
            return format!("{name}={REDACTED}");
        }
        if is_url_like(value) {
            return format!("{name}={}", redact_url(value));
        }
    }
    if looks_like_secret_value(token) {
        return REDACTED.to_string();
    }
    token.to_string()
}

/// 拆掉 token 两端的引号、括号和标点，只对核心部分脱敏。
fn split_wrapping_punctuation(token: &str) -> (&str, &str, &str) {
    let start = token
        .char_indices()
        .find(|(_, character)| !matches!(character, '"' | '\'' | '(' | '[' | '{' | '<'))
        .map(|(index, _)| index)
        .unwrap_or(token.len());
    let end = token
        .char_indices()
        .rev()
        .find(|(index, character)| {
            *index >= start
                && !matches!(
                    character,
                    '"' | '\'' | ')' | ']' | '}' | '>' | ',' | ';' | ':'
                )
        })
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(start);

    (&token[..start], &token[start..end], &token[end..])
}

fn is_url_like(token: &str) -> bool {
    let Some((scheme, rest)) = token.split_once("://") else {
        return false;
    };

    !rest.is_empty()
        && scheme
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphabetic())
        && scheme.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
        })
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
    fn user_does_not_see_secrets_left_in_a_harmless_attribute_value() {
        let mut event = envelope("agent.request.failed");
        event.attrs.insert(
            "error.detail".to_string(),
            json!(
                "GET postgres://user:pass@db.example.test/app?token=secret \
                 Authorization: Bearer abcdefghijklmnop sk-live-secret"
            ),
        );
        event.msg = Some("retry auth=opaque-secret from https://example.test/path".to_string());

        let line = event.to_line("7f3a9c");

        assert!(!line.contains("pass"));
        assert!(!line.contains("secret"));
        assert!(!line.contains("abcdefghijklmnop"));
        assert!(!line.contains("/app"));
        assert!(!line.contains("/path"));
        assert!(line.contains("db.example.test"));
        assert!(line.contains("example.test"));
    }

    #[test]
    fn user_does_not_see_basic_or_digest_credentials_without_a_header() {
        let mut event = envelope("agent.request.failed");
        event.attrs.insert(
            "error.detail".to_string(),
            json!("retry using Basic dXNlcjpwYXNz and Digest YWRtaW46c2VjcmV0"),
        );

        let line = event.to_line("7f3a9c");

        assert!(!line.contains("dXNlcjpwYXNz"));
        assert!(!line.contains("YWRtaW46c2VjcmV0"));
        assert!(line.contains("Basic"));
        assert!(line.contains("Digest"));
    }

    #[test]
    fn user_does_not_see_a_parameter_when_the_credential_is_a_digest() {
        let mut event = envelope("agent.request.failed");
        event.attrs.insert(
            "error.detail".to_string(),
            json!("Digest username=\"u\", nonce=\"n\", response=\"signature\""),
        );

        let line = event.to_line("7f3a9c");

        assert!(!line.contains("username="));
        assert!(!line.contains("nonce="));
        assert!(!line.contains("signature"));
        assert!(line.contains("Digest"));
    }

    #[test]
    fn user_does_not_see_a_secret_when_the_key_has_irregular_capitalization() {
        let mut event = envelope("mcp.connect.failed");
        event
            .attrs
            .insert("ToKen".to_string(), json!("plain-irregular-token"));

        let line = event.to_line("7f3a9c");

        assert!(!line.contains("plain-irregular-token"));
    }

    #[test]
    fn user_does_not_see_camel_case_secret_attributes() {
        let mut event = envelope("mcp.connect.failed");
        event
            .attrs
            .insert("accessToken".to_string(), json!("plain-access-token"));
        event
            .attrs
            .insert("clientSecret".to_string(), json!("plain-client-secret"));
        event
            .attrs
            .insert("privateKey".to_string(), json!("plain-private-key"));
        event.attrs.insert("sessionId".to_string(), json!("kept"));

        let line = event.to_line("7f3a9c");

        assert!(!line.contains("plain-access-token"));
        assert!(!line.contains("plain-client-secret"));
        assert!(!line.contains("plain-private-key"));
        assert!(line.contains("accesstoken=[redacted]"));
        assert!(line.contains("clientsecret=[redacted]"));
        assert!(line.contains("privatekey=[redacted]"));
        assert!(line.contains("sessionid=kept"));
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
    fn user_gets_only_complete_fields_when_the_line_is_too_long() {
        let mut event = envelope("legacy.console");
        for index in 0..40 {
            event
                .attrs
                .insert(format!("k{index:02}"), json!("v".repeat(300)));
        }

        let line = event.to_line("7f3a9c");

        assert!(line.len() <= MAX_LINE_BYTES);
        assert!(line.ends_with(" truncated=true"));

        let body = line.trim_end_matches(" truncated=true");
        let mut kept = 0;
        for field in body.split(' ') {
            if let Some(rest) = field.strip_prefix('k') {
                let (_, value) = rest.split_once('=').expect("field keeps its value");
                assert_eq!(value.len(), 300, "partial field: {field}");
                kept += 1;
            }
        }
        assert!(kept > 0);
        assert!(!body.contains("k39="));
    }

    #[test]
    fn user_gets_an_unknown_event_name_replaced() {
        let mut event = envelope("Agent Request Failed!");
        event.event = "Agent Request Failed!".to_string();

        let line = event.to_line("7f3a9c");

        assert!(line.starts_with("agentrequestfailed "));
    }
}
