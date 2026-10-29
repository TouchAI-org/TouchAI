// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! MCP 配置的日志脱敏。
//!
//! MCP 的命令参数、请求头和 URL 都可能带 API key。进入日志前只保留
//! 可以安全落盘的部分：可执行文件名、参数个数、脱敏后的参数和 URL 路径。

use reqwest::Url;

const REDACTED: &str = "[redacted]";
const REDACTED_URL: &str = "[redacted-url]";

/// 只保留 scheme、host 和 port，去掉 userinfo、path、query 和 fragment。
///
/// 解析失败或没有 host 的形态（例如 `user:pass@host/path` 会被解析成
/// scheme=`user`，`Bearer sk-live-...` 干脆解析失败）无法区分 userinfo 和路径，
/// 整段替换成固定标记，宁可少一条诊断也不落盘疑似凭据。
pub(crate) fn redact_url(raw: &str) -> String {
    match Url::parse(raw) {
        Ok(url) if url.host_str().is_some_and(|host| !host.is_empty()) => {
            let mut redacted = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
            if let Some(port) = url.port() {
                redacted.push_str(&format!(":{port}"));
            }
            // 路径里可能直接放着令牌（`/mcp/<token>`），只留固定标记。
            if url.path().len() > 1 {
                redacted.push_str("/[redacted-path]");
            }
            redacted
        }
        _ => REDACTED_URL.to_string(),
    }
}

/// 只保留可执行文件名。
///
/// 同时识别 `/` 和 `\`，因为测试可能运行在与目标平台不同的系统上。
pub(crate) fn command_label(command: &str) -> String {
    command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(command)
        .to_string()
}

/// 按参数逐个脱敏：带密钥含义的开关、请求头行和 `--flag=value` 形式。
pub(crate) fn redact_args(args: &[String]) -> Vec<String> {
    let mut redacted = Vec::with_capacity(args.len());
    let mut pending = Pending::None;

    for arg in args {
        match pending {
            Pending::Secret => {
                // 值缺失时下一个参数其实是开关：先补一个占位，再按开关重新分类。
                redacted.push(REDACTED.to_string());
                pending = Pending::None;
                if classify_flag(arg).is_none() {
                    continue;
                }
            }
            Pending::Header => {
                redacted.push(redact_header(arg));
                pending = Pending::None;
                // 值缺失时下一个参数其实是开关：先补一个占位，再按开关重新分类。
                if classify_flag(arg).is_none() {
                    continue;
                }
            }
            Pending::None => {}
        }

        match classify_flag(arg) {
            Some(Flag::InlineSecret { name }) => {
                redacted.push(format!("{name}={REDACTED}"));
            }
            Some(Flag::InlineHeader { name }) => {
                let value = arg
                    .split_once('=')
                    .map(|(_, value)| value)
                    .unwrap_or_default();
                redacted.push(format!("{name}={}", redact_header(value)));
            }
            Some(Flag::Secret { name }) => {
                redacted.push(name.to_string());
                pending = Pending::Secret;
            }
            Some(Flag::Header { name }) => {
                redacted.push(name.to_string());
                pending = Pending::Header;
            }
            None => redacted.push(redact_positional(arg)),
        }
    }

    redacted
}

/// 位置参数里 `KEY=VALUE` 的键名带密钥含义时只保留键名，其余原样。
///
/// `--env=KEY=VALUE` 这类内联环境变量还有第二层赋值，同样要拆开判断。
fn redact_positional(arg: &str) -> String {
    // 裸 URL 没有 `=`，必须在赋值拆分之前处理，否则 userinfo 和路径会原样落盘。
    if is_url_like(arg) {
        return redact_url(arg);
    }

    let Some((name, value)) = arg.split_once('=') else {
        // 没有键名的独立令牌同样不能落盘。
        return if looks_like_secret_value(arg) {
            REDACTED.to_string()
        } else {
            arg.to_string()
        };
    };

    if name.starts_with('-') {
        // `--url=postgres://user:pass@host/db?token=...` 的 scheme 不是 http(s)，
        // 但同样可能携带凭据，先按 URL 脱敏再考虑内层赋值。
        if is_url_like(value) {
            return format!("{name}={}", redact_url(value));
        }
        return match value.split_once('=') {
            Some((inner_name, inner_value))
                if is_secret_name(inner_name) || looks_like_secret_value(inner_value) =>
            {
                format!("{name}={inner_name}={REDACTED}")
            }
            Some((inner_name, inner_value)) if is_url_like(inner_value) => {
                format!("{name}={inner_name}={}", redact_url(inner_value))
            }
            _ => arg.to_string(),
        };
    }

    if is_secret_name(name) || looks_like_secret_value(value) {
        return format!("{name}={REDACTED}");
    }
    if is_url_like(value) {
        return format!("{name}={}", redact_url(value));
    }

    arg.to_string()
}

/// 判断一个 token 是否带有 `scheme://`，不限定 http(s)。
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

/// 常见令牌前缀；键名本身没有密钥含义时，值也能单独判定。
pub(crate) fn looks_like_secret_value(value: &str) -> bool {
    const PREFIXES: [&str; 6] = ["sk-", "pk-", "ghp_", "github_pat_", "xoxb-", "xoxp-"];

    PREFIXES
        .iter()
        .any(|prefix| value.starts_with(prefix) && value.len() >= prefix.len() + 8)
}

/// 进入日志的 stdio 连接信息。
pub(crate) fn stdio_connect_message(server_id: i64, command: &str, args: &[String]) -> String {
    stdio_message(
        &format!("Connecting to MCP server {server_id} (stdio)"),
        command,
        args,
    )
}

/// 进入日志的 stdio 实际执行命令，用于 Windows 下的 `cmd /c` 包装。
pub(crate) fn stdio_actual_command_message(
    server_id: i64,
    command: &str,
    args: &[String],
) -> String {
    let mut redacted_args = redact_args(args);
    // Windows 下 `cmd /c <command> ...` 把真实命令放在第一个参数里，
    // 这条参数走的是位置参数分支，同样只保留可执行文件名。
    if redacted_args.len() > 1 && redacted_args[0].eq_ignore_ascii_case("/c") {
        redacted_args[1] = command_label(&args[1]);
    }

    format!(
        "Actual command for MCP server {server_id}: {} arg_count={} args={:?}",
        command_label(command),
        args.len(),
        redacted_args
    )
}

fn stdio_message(label: &str, command: &str, args: &[String]) -> String {
    format!(
        "{}: {} arg_count={} args={:?}",
        label,
        command_label(command),
        args.len(),
        redact_args(args)
    )
}

/// 进入日志的 HTTP 连接信息。
pub(crate) fn http_connect_message(server_id: i64, url: &str) -> String {
    format!(
        "Connecting to MCP server {} (HTTP): {}",
        server_id,
        redact_url(url)
    )
}

#[derive(Clone, Copy)]
enum Pending {
    None,
    Secret,
    Header,
}

enum Flag<'a> {
    Secret { name: &'a str },
    InlineSecret { name: &'a str },
    Header { name: &'a str },
    InlineHeader { name: &'a str },
}

fn classify_flag(arg: &str) -> Option<Flag<'_>> {
    if !arg.starts_with('-') {
        return None;
    }

    let (name, inline_value) = match arg.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (arg, None),
    };

    if is_header_name(name) {
        return Some(match inline_value {
            Some(_) => Flag::InlineHeader { name },
            None => Flag::Header { name },
        });
    }
    if is_secret_name(name) {
        return Some(match inline_value {
            Some(_) => Flag::InlineSecret { name },
            None => Flag::Secret { name },
        });
    }
    None
}

fn is_header_name(name: &str) -> bool {
    matches!(
        name.trim_start_matches('-').to_ascii_lowercase().as_str(),
        "h" | "header"
    )
}

fn is_secret_name(name: &str) -> bool {
    // 与日志写入侧共用一份词表：camelCase（`accessToken`）也要能认出来。
    crate::core::observability::ingest::is_secret_key(name.trim_start_matches('-'))
}

/// 请求头名字保留下来做诊断，值一律替换：未知头也可能携带会话凭据。
fn redact_header(value: &str) -> String {
    match value.split_once(':') {
        Some((name, _)) => format!("{}: {REDACTED}", name.trim()),
        None => REDACTED.to_string(),
    }
}

/// 常见的独立令牌前缀；命中即整段脱敏，即使没有字段名。
fn is_common_secret_token(token: &str) -> bool {
    let trimmed = token.trim_matches(|character: char| {
        matches!(character, '"' | '\'' | ',' | ';' | ')' | '(' | ']' | '[')
    });

    looks_like_secret_value(trimmed)
}

/// 日志级别前缀不是请求头：`Error: Cannot find module` 的后半句是诊断信息，要留着。
fn is_log_level_prefix(token: &str) -> bool {
    matches!(
        token
            .trim_matches(|character: char| !character.is_ascii_alphabetic() && character != ':')
            .to_ascii_lowercase()
            .as_str(),
        "error:"
            | "err:"
            | "warn:"
            | "warning:"
            | "info:"
            | "debug:"
            | "trace:"
            | "fatal:"
            | "panic:"
    )
}

fn is_credential_header_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "authorization" | "proxy-authorization" | "cookie" | "set-cookie"
    )
}

/// 紧凑写法的请求头（`Authorization:Bearer x`、`Cookie:session=abc`）。
///
/// 冒号两侧没有空格时整段是一个 token，走不到按 token 结尾判断的分支。
fn inline_header_name(token: &str) -> Option<&str> {
    let (name, _) = token.split_once(':')?;
    let name = name.trim_matches(|character: char| {
        !(character.is_ascii_alphanumeric() || character == '-' || character == '_')
    });

    is_credential_header_name(name).then_some(name)
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')
}

fn is_value_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'"' | b'\'' | b',' | b';' | b'}' | b']' | b' ' | b'\t' | b'\r'
    )
}

enum InlineRedaction {
    Unchanged,
    Redacted(String),
    /// 值的引号没有在本 token 内闭合，剩下的整行都要盖住。
    RedactedToEnd(String),
}

/// 同一个 token 里的 `name:value` / `name=value`（例如 JSON 片段）。
///
/// 只替换值本身，周围的引号和字段名保留。
fn redact_inline_secret_values(token: &str) -> InlineRedaction {
    let bytes = token.as_bytes();
    let mut output = String::with_capacity(token.len());
    let mut copied = 0;
    let mut index = 0;

    while index < bytes.len() {
        if !matches!(bytes[index], b':' | b'=') {
            index += 1;
            continue;
        }

        // JSON 里字段名自带引号：`"password":"hunter2"`，跳过收尾引号再取名字。
        let mut name_end = index;
        if name_end > copied && matches!(bytes[name_end - 1], b'"' | b'\'') {
            name_end -= 1;
        }
        let mut name_start = name_end;
        while name_start > copied && is_name_byte(bytes[name_start - 1]) {
            name_start -= 1;
        }
        let name = &token[name_start..name_end];

        let mut value_start = index + 1;
        while value_start < bytes.len() && bytes[value_start] == b' ' {
            value_start += 1;
        }
        let quote = if value_start < bytes.len() && matches!(bytes[value_start], b'"' | b'\'') {
            let quote = bytes[value_start];
            value_start += 1;
            Some(quote)
        } else {
            None
        };

        let mut value_end = value_start;
        while value_end < bytes.len()
            && Some(bytes[value_end]) != quote
            && !is_value_delimiter(bytes[value_end])
        {
            value_end += 1;
        }

        if !name.is_empty()
            && (is_secret_name(name)
                || is_credential_header_name(name)
                || looks_like_secret_value(&token[value_start..value_end]))
        {
            output.push_str(&token[copied..value_start]);
            output.push_str(REDACTED);
            copied = value_end;
            // 值跨 token（`"correct horse"`）时，本 token 里只有前半句。
            if let Some(quote) = quote {
                if bytes.get(value_end) != Some(&quote) {
                    return InlineRedaction::RedactedToEnd(output);
                }
            }
            index = value_end;
            continue;
        }

        index += 1;
    }

    if copied == 0 {
        return InlineRedaction::Unchanged;
    }

    output.push_str(&token[copied..]);
    InlineRedaction::Redacted(output)
}
/// Redact credentials from captured MCP stderr before it reaches disk or a bundle.
pub(crate) fn redact_stderr(raw: &str) -> String {
    raw.split('\n')
        .map(redact_stderr_line)
        .collect::<Vec<_>>()
        .join("\n")
}

/// 单行脱敏。凭据类请求头之后的内容整行丢弃，避免 `Basic`/`Digest` 的值残留。
fn redact_stderr_line(line: &str) -> String {
    let mut output = Vec::new();
    let mut tokens = line.split_whitespace().peekable();

    while let Some(token) = tokens.next() {
        let core = token.trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '(' | '[' | '{' | '<' | ')' | ']' | '}' | '>' | ',' | ';'
            )
        });
        if is_url_like(core) {
            output.push(redact_url(core));
            continue;
        }

        // 紧凑写法的请求头整段是一个 token，且冒号后面可能还有 `=`：
        // `Cookie:session_token=abc; csrf=xyz` 必须整行丢弃，否则尾部会漏。
        if let Some(name) = inline_header_name(core) {
            output.push(format!("{name}: {REDACTED}"));
            break;
        }

        if let Some((name, value)) = core.split_once('=') {
            if is_secret_name(name) || looks_like_secret_value(value) {
                output.push(format!("{name}={REDACTED}"));
                continue;
            }
            if is_url_like(value) {
                output.push(format!("{name}={}", redact_url(value)));
                continue;
            }
        }

        // 任何 Name: 之后的内容整行丢弃：未知头也可能带会话凭据。
        // 日志级别前缀不是请求头，否则 `Error: Cannot find module` 会丢掉原因。
        if token.ends_with(':') && !is_log_level_prefix(token) {
            output.push(format!("{token} {REDACTED}"));
            break;
        }

        // Bearer/Basic/Digest 的凭据在下一个 token，且与 scheme 之间可能没有冒号。
        // 比较去掉引号后的 `core`：`"Basic dXNlcjpwYXNz"` 里的 scheme 带引号。
        if core.eq_ignore_ascii_case("bearer") || core.eq_ignore_ascii_case("basic") {
            output.push(token.to_string());
            if tokens.next().is_some() {
                output.push(REDACTED.to_string());
            }
            continue;
        }
        // Digest 是 `username=..., nonce=..., response=...` 的参数列表，
        // 只替换一个 token 会把剩下的参数留在日志里。
        if core.eq_ignore_ascii_case("digest") {
            output.push(token.to_string());
            if tokens.next().is_some() {
                output.push(REDACTED.to_string());
            }
            break;
        }
        match redact_inline_secret_values(token) {
            InlineRedaction::Unchanged => {}
            InlineRedaction::Redacted(redacted) => {
                output.push(redacted);
                continue;
            }
            InlineRedaction::RedactedToEnd(redacted) => {
                output.push(redacted);
                break;
            }
        }
        if is_common_secret_token(token) {
            output.push(REDACTED.to_string());
            continue;
        }

        output.push(token.to_string());
    }
    output.join(" ")
}
#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn user_does_not_see_url_credentials_or_query_values_in_the_log() {
        let redacted =
            redact_url("https://user:pass@mcp.example.test:8443/v1/sse?api_key=secret-query#token");

        assert_eq!(redacted, "https://mcp.example.test:8443/[redacted-path]");
        assert!(!redacted.contains("secret-query"));
        assert!(!redacted.contains("v1/sse"));
    }

    #[test]
    fn user_does_not_see_any_part_of_a_url_the_parser_rejects() {
        let redacted = redact_url("mcp.example.test/sse?token=secret-query");

        assert_eq!(redacted, "[redacted-url]");
        assert!(!redacted.contains("secret-query"));
    }

    #[test]
    fn user_does_not_see_a_credential_mistaken_for_a_url() {
        let redacted = redact_url("Bearer sk-live-secret-token");

        assert_eq!(redacted, "[redacted-url]");
        assert!(!redacted.contains("sk-live-secret-token"));
    }

    #[test]
    fn user_does_not_see_credentials_in_an_opaque_url() {
        let redacted = redact_url("user:pass@mcp.example.test/sse");

        assert_eq!(redacted, "[redacted-url]");
        assert!(!redacted.contains("pass"));
    }

    #[test]
    fn user_does_not_see_credentials_when_the_url_has_no_scheme() {
        let redacted = redact_url("user:pass@mcp.example.test/sse?token=secret-query");

        assert_eq!(redacted, "[redacted-url]");
        assert!(!redacted.contains("pass"));
        assert!(!redacted.contains("secret-query"));
    }

    #[test]
    fn user_does_not_see_a_credential_carried_in_the_url_path() {
        let redacted = redact_url("https://mcp.example.test/mcp/sk-live-secret");

        assert_eq!(redacted, "https://mcp.example.test/[redacted-path]");
        assert!(!redacted.contains("sk-live-secret"));
    }

    #[test]
    fn user_does_not_see_a_header_after_a_missing_secret_value() {
        let redacted = redact_args(&args(&[
            "--api-key",
            "--header",
            "Authorization: Bearer secret-header",
        ]));

        assert_eq!(
            redacted,
            vec![
                "--api-key",
                "[redacted]",
                "--header",
                "Authorization: [redacted]"
            ]
        );
    }

    #[test]
    fn user_does_not_see_inline_environment_assignments_in_the_log() {
        let redacted = redact_args(&args(&[
            "--env=API_KEY=opaque-secret",
            "-e=DEBUG=1",
            "--env=FOO=opaque-value",
        ]));

        assert_eq!(
            redacted,
            vec![
                "--env=API_KEY=[redacted]",
                "-e=DEBUG=1",
                "--env=FOO=opaque-value"
            ]
        );
    }

    #[test]
    fn user_does_not_see_mcp_stderr_secrets_in_a_diagnostic_bundle() {
        let redacted = redact_stderr(
            "startup failed token=secret-value\n\
             Authorization: Bearer secret-header\n\
             GET https://user:pass@mcp.example.test/sse?api_key=secret-query",
        );

        assert!(!redacted.contains("secret-value"));
        assert!(!redacted.contains("secret-header"));
        assert!(!redacted.contains("secret-query"));
        assert!(redacted.contains("mcp.example.test"));
        assert!(!redacted.contains("/sse"));
    }

    #[test]
    fn user_does_not_see_basic_or_digest_credentials_in_mcp_stderr() {
        let redacted = redact_stderr(
            "Authorization: Basic dXNlcjpwYXNz\nerror 401 Proxy-Authorization: Digest username=\"u\"",
        );

        assert!(!redacted.contains("dXNlcjpwYXNz"));
        assert!(!redacted.contains("username="));
        assert!(redacted.contains("Authorization: [redacted]"));
        assert!(redacted.contains("Proxy-Authorization: [redacted]"));
    }

    #[test]
    fn user_does_not_see_standalone_tokens_in_mcp_stderr() {
        let redacted = redact_stderr(
            "request failed with sk-live-1234567890 and ghp_abcdefghijklmnop, retrying",
        );

        assert!(!redacted.contains("sk-live-1234567890"));
        assert!(!redacted.contains("ghp_abcdefghijklmnop"));
        assert!(redacted.contains("retrying"));
    }

    #[test]
    fn user_does_not_see_basic_credentials_outside_a_header_line() {
        // 没有 `Name:` 前缀时，scheme 和凭据是两个普通 token。
        let redacted = redact_stderr("retry using Basic dXNlcjpwYXNz and Digest YWRtaW46c2VjcmV0");

        assert!(!redacted.contains("dXNlcjpwYXNz"));
        assert!(!redacted.contains("YWRtaW46c2VjcmV0"));
        assert!(redacted.contains("Basic"));
        assert!(redacted.contains("Digest"));
        assert!(redacted.contains("retry using"));
    }

    #[test]
    fn user_does_not_see_a_credential_when_the_scheme_is_quoted() {
        let redacted = redact_stderr(r#"retry using "Basic dXNlcjpwYXNz""#);

        assert!(!redacted.contains("dXNlcjpwYXNz"));
        assert!(redacted.contains("Basic"));
    }

    #[test]
    fn user_does_not_see_a_parameter_when_the_credential_is_a_digest() {
        let redacted =
            redact_stderr("retry using Digest username=\"u\", nonce=\"n\", response=\"signature\"");

        assert!(!redacted.contains("username="));
        assert!(!redacted.contains("nonce="));
        assert!(!redacted.contains("signature"));
        assert!(redacted.contains("Digest"));
    }

    #[test]
    fn user_does_not_see_json_credentials_in_mcp_stderr() {
        let redacted = redact_stderr(r#"{"authorization": "Bearer json-secret-value"}"#);

        assert!(!redacted.contains("json-secret-value"));
        assert!(redacted.contains("[redacted]"));
    }

    #[test]
    fn user_does_not_see_a_secret_written_without_a_space_after_the_colon() {
        let redacted = redact_stderr(
            r#"{"level":"error","password":"hunter2"} Authorization:Bearer abcdefghijklmnop"#,
        );

        assert!(!redacted.contains("hunter2"));
        assert!(!redacted.contains("abcdefghijklmnop"));
        assert!(redacted.contains("\"level\":\"error\""));
    }

    #[test]
    fn user_sees_the_failure_reason_after_a_log_level_prefix() {
        let redacted = redact_stderr("Error: Cannot find module 'left-pad'");

        assert_eq!(redacted, "Error: Cannot find module 'left-pad'");
    }

    #[test]
    fn user_does_not_see_a_header_or_a_multi_word_value_in_compact_json() {
        let redacted = redact_stderr(
            r#"{"level":30,"headers":{"authorization":"Bearer abc123"}} and {"password":"correct horse"}"#,
        );

        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("correct"));
        assert!(!redacted.contains("horse"));
    }

    #[test]
    fn user_does_not_see_a_camel_case_secret_field_in_mcp_stderr() {
        let redacted = redact_stderr(
            r#"{"accessToken":"abc123"} {"clientSecret":"xyz789"} refreshToken=def456"#,
        );

        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("xyz789"));
        assert!(!redacted.contains("def456"));
    }

    #[test]
    fn user_does_not_see_the_tail_of_a_compact_cookie_header() {
        let redacted = redact_stderr("Cookie:session_token=abc; csrf=xyz");

        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("xyz"));
    }

    #[test]
    fn user_does_not_see_credentials_in_a_non_http_stderr_url() {
        let redacted =
            redact_stderr("connect postgres://user:pass@db.example.test:5432/app?sslkey=secret");

        assert_eq!(
            redacted,
            "connect postgres://db.example.test:5432/[redacted-path]"
        );
        assert!(!redacted.contains("pass"));
        assert!(!redacted.contains("secret"));
    }

    #[test]
    fn user_does_not_see_url_credentials_after_a_harmless_key() {
        let redacted =
            redact_stderr("\"dsn=postgres://user:pass@db.example.test/app?token=secret\"");

        assert_eq!(redacted, "dsn=postgres://db.example.test/[redacted-path]");
        assert!(!redacted.contains("pass"));
        assert!(!redacted.contains("secret"));
    }

    #[test]
    fn user_does_not_see_secret_arguments_in_the_log() {
        let message = stdio_connect_message(
            7,
            "/usr/local/bin/npx",
            &args(&[
                "-y",
                "@modelcontextprotocol/server-github",
                "--token=secret-inline",
                "--api-key",
                "secret-separate",
                "-H",
                "Authorization: Bearer secret-header",
                "--header=Content-Type: application/json",
            ]),
        );

        assert!(!message.contains("secret-inline"));
        assert!(!message.contains("secret-separate"));
        assert!(!message.contains("secret-header"));
        assert!(!message.contains("/usr/local/bin"));
        assert!(message.contains("npx"));
        assert!(message.contains("arg_count=8"));
    }

    #[test]
    fn user_keeps_harmless_arguments_readable_in_the_log() {
        let redacted = redact_args(&args(&["--model", "gpt-4.1"]));

        assert_eq!(redacted, vec!["--model", "gpt-4.1"]);
    }

    #[test]
    fn user_does_not_see_unknown_header_values_in_the_log() {
        let redacted = redact_args(&args(&["-H", "X-Session: session-secret"]));

        assert_eq!(redacted, vec!["-H", "X-Session: [redacted]"]);
    }

    #[test]
    fn user_does_not_see_environment_values_in_the_log() {
        let redacted = redact_args(&args(&[
            "run",
            "-e",
            "API_KEY=sk-live-secret",
            "--env",
            "DEBUG=1",
            "FOO=sk-live-unknown-name",
            "API_KEY=sk-live-inline",
        ]));

        assert_eq!(
            redacted,
            vec![
                "run",
                "-e",
                "API_KEY=[redacted]",
                "--env",
                "DEBUG=1",
                "FOO=[redacted]",
                "API_KEY=[redacted]",
            ]
        );
    }

    #[test]
    fn user_does_not_see_environment_values_in_a_windows_command_list() {
        let message = stdio_actual_command_message(
            3,
            "C:\\Windows\\System32\\cmd.exe",
            &args(&["/c", "npx", "-e", "API_KEY=sk-live-secret", "server"]),
        );

        assert!(!message.contains("sk-live-secret"));
        assert!(message.contains("cmd.exe"));
        assert!(message.contains("server"));
    }

    #[test]
    fn user_sees_only_the_last_path_segment_of_a_windows_command() {
        assert_eq!(
            command_label("C:\\Program Files\\nodejs\\npx.cmd"),
            "npx.cmd"
        );
    }

    #[test]
    fn user_does_not_see_credentials_in_a_non_http_argument_url() {
        let redacted = redact_args(&args(&[
            "--url=postgres://user:pass@db.example.test:5432/app?sslmode=require",
            "--env=DATABASE_URL=redis://:secret@cache.example.test/0",
        ]));

        assert_eq!(
            redacted,
            vec![
                "--url=postgres://db.example.test:5432/[redacted-path]",
                "--env=DATABASE_URL=redis://cache.example.test/[redacted-path]",
            ]
        );
    }

    #[test]
    fn user_does_not_see_a_secret_flag_swallowed_as_a_header_value() {
        let redacted = redact_args(&args(&["--header", "--api-key", "opaque-secret"]));

        assert_eq!(
            redacted,
            vec!["--header", "[redacted]", "--api-key", "[redacted]"]
        );
    }

    #[test]
    fn user_does_not_see_credentials_in_a_positional_url() {
        let redacted = redact_args(&args(&[
            "https://user:pass@mcp.example.test/mcp/secret-token",
        ]));

        assert_eq!(redacted, vec!["https://mcp.example.test/[redacted-path]"]);
    }

    #[test]
    fn user_does_not_see_a_windows_command_path_in_the_actual_command() {
        let message = stdio_actual_command_message(
            4,
            "cmd",
            &args(&[
                "/c",
                "C:\\Users\\alice\\private\\npx.cmd",
                "--model",
                "gpt-4.1",
            ]),
        );

        assert!(!message.contains("alice"));
        assert!(!message.contains("private"));
        assert!(message.contains("npx.cmd"));
        assert!(message.contains("gpt-4.1"));
    }
}
