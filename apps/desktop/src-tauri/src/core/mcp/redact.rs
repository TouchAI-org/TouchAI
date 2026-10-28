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
                continue;
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
    let Some((name, value)) = arg.split_once('=') else {
        return arg.to_string();
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
    stdio_message(
        &format!("Actual command for MCP server {server_id}"),
        command,
        args,
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
    let normalized = name
        .trim_start_matches('-')
        .to_ascii_lowercase()
        .replace('_', "-");

    normalized
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .any(|part| {
            matches!(
                part,
                "key" | "apikey" | "token" | "secret" | "password" | "passwd" | "auth"
            )
        })
}

/// 请求头名字保留下来做诊断，值一律替换：未知头也可能携带会话凭据。
fn redact_header(value: &str) -> String {
    match value.split_once(':') {
        Some((name, _)) => format!("{}: {REDACTED}", name.trim()),
        None => REDACTED.to_string(),
    }
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
}
