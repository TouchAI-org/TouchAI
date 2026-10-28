// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! MCP 配置的日志脱敏。
//!
//! MCP 的命令参数、请求头和 URL 都可能带 API key。进入日志前只保留
//! 可以安全落盘的部分：可执行文件名、参数个数、脱敏后的参数和 URL 路径。

use reqwest::Url;

const REDACTED: &str = "[redacted]";
const REDACTED_URL: &str = "[redacted-url]";

/// 只保留 scheme、host、port 和 path，去掉 userinfo、query 和 fragment。
///
/// 没有 host 的形态（例如 `user:pass@host/path` 会被解析成 scheme=`user`）
/// 无法安全拆分，整体替换成固定标记。
pub(crate) fn redact_url(raw: &str) -> String {
    match Url::parse(raw) {
        Ok(url) if url.host_str().is_some_and(|host| !host.is_empty()) => {
            let mut redacted = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
            if let Some(port) = url.port() {
                redacted.push_str(&format!(":{port}"));
            }
            redacted.push_str(url.path());
            redacted
        }
        Ok(_) => REDACTED_URL.to_string(),
        Err(_) => redact_url_without_parser(raw),
    }
}

fn redact_url_without_parser(raw: &str) -> String {
    let without_fragment = raw.split('#').next().unwrap_or_default();
    let without_query = without_fragment.split('?').next().unwrap_or_default();

    // 解析失败时 `@` 前后无法区分 userinfo 和路径，直接放弃整段。
    if without_query.contains('@') {
        return REDACTED_URL.to_string();
    }

    match without_query.split_once("://") {
        Some((scheme, rest)) => {
            let path_start = rest.find('/').unwrap_or(rest.len());
            let authority = &rest[..path_start];
            let host = authority.rsplit('@').next().unwrap_or(authority);
            format!("{scheme}://{host}{}", &rest[path_start..])
        }
        None => without_query.to_string(),
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
                redacted.push(REDACTED.to_string());
                pending = Pending::None;
                continue;
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
fn redact_positional(arg: &str) -> String {
    match arg.split_once('=') {
        Some((name, value))
            if !name.starts_with('-')
                && (is_secret_name(name) || looks_like_secret_value(value)) =>
        {
            format!("{name}={REDACTED}")
        }
        _ => arg.to_string(),
    }
}

/// 常见令牌前缀；键名本身没有密钥含义时，值也能单独判定。
fn looks_like_secret_value(value: &str) -> bool {
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

        assert_eq!(redacted, "https://mcp.example.test:8443/v1/sse");
        assert!(!redacted.contains("secret-query"));
    }

    #[test]
    fn user_does_not_see_query_values_when_the_url_cannot_be_parsed() {
        let redacted = redact_url("mcp.example.test/sse?token=secret-query");

        assert_eq!(redacted, "mcp.example.test/sse");
        assert!(!redacted.contains("secret-query"));
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
}
