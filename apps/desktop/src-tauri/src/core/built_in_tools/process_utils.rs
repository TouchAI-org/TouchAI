// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具共享的进程管理辅助函数。

use encoding_rs::UTF_8;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Child;

/// Incrementally reads a process stream, reporting decoded UTF-8 chunks as they arrive.
pub async fn read_stream_with_progress<R, F>(
    mut reader: R,
    mut on_chunk: F,
) -> Result<String, String>
where
    R: AsyncRead + Unpin,
    F: FnMut(&str) -> Result<(), String>,
{
    let mut decoder = UTF_8.new_decoder_without_bom_handling();
    let mut buffer = [0u8; 4096];
    let mut output = String::new();

    loop {
        let read = reader
            .read(&mut buffer)
            .await
            .map_err(|error| format!("Failed to read process stream: {error}"))?;
        let is_last = read == 0;
        let bytes = if is_last { &[][..] } else { &buffer[..read] };
        let mut decoded = String::with_capacity(read.saturating_mul(2).max(1));

        let _ = decoder.decode_to_string(bytes, &mut decoded, is_last);
        if !decoded.is_empty() {
            output.push_str(&decoded);
            on_chunk(&decoded)?;
        }

        if is_last {
            break;
        }
    }

    Ok(output.trim().to_string())
}

/// Combines stdout/stderr into the single tool result format used by the upper layers.
pub fn combine_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("STDOUT:\n{}\n\nSTDERR:\n{}", stdout, stderr),
        (false, true) => stdout.to_string(),
        (true, false) => format!("STDERR:\n{}", stderr),
        (true, true) => String::new(),
    }
}

/// 解析超时毫秒数，限制在合理范围内。
///
/// - `Some(0)`：调用方明确要求关闭超时，返回 `None`；
/// - `None`：调用方未指定，退回 `default_ms`；
/// - 其余正数收敛到 `[1, max_ms]`，避免超出执行器能力造成静默截断。
pub fn resolve_timeout_ms(timeout_ms: Option<u64>, default_ms: u64, max_ms: u64) -> Option<u64> {
    match timeout_ms {
        Some(0) => None,
        Some(value) => Some(value.clamp(1, max_ms)),
        None => Some(default_ms.clamp(1, max_ms)),
    }
}

/// Terminates a child process and waits for it to exit.
pub async fn terminate_child(
    child: &mut Child,
    label: &str,
) -> Result<std::process::ExitStatus, String> {
    if let Some(status) = child
        .try_wait()
        .map_err(|error| format!("Failed to inspect {label} process: {error}"))?
    {
        return Ok(status);
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Stdio;
        use tokio::process::Command;

        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let child_pid = child.id();
        if let Some(pid) = child_pid {
            let taskkill_result = Command::new("taskkill")
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/T")
                .arg("/F")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status()
                .await;

            match taskkill_result {
                Ok(status) if status.success() => {}
                Ok(_) => {
                    if child
                        .try_wait()
                        .map_err(|error| {
                            format!("Failed to inspect {label} process after taskkill: {error}")
                        })?
                        .is_none()
                    {
                        child.kill().await.map_err(|error| {
                            format!(
                                "Failed to kill {label} process after taskkill fallback: {error}"
                            )
                        })?;
                    }
                }
                Err(error) => {
                    child.kill().await.map_err(|kill_error| {
                        format!(
                            "Failed to invoke taskkill for {label} process ({error}); direct kill also failed: {kill_error}"
                        )
                    })?;
                }
            }
        } else {
            child
                .kill()
                .await
                .map_err(|error| format!("Failed to kill {label} process: {error}"))?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        child
            .kill()
            .await
            .map_err(|error| format!("Failed to terminate {label} process: {error}"))?;
    }

    child
        .wait()
        .await
        .map_err(|error| format!("Failed to reap {label} process: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn combine_output_both_non_empty() {
        let result = combine_output("hello", "world");
        assert_eq!(result, "STDOUT:\nhello\n\nSTDERR:\nworld");
    }

    #[test]
    fn combine_output_stdout_only() {
        let result = combine_output("hello", "");
        assert_eq!(result, "hello");
    }

    #[test]
    fn combine_output_stderr_only() {
        let result = combine_output("", "error");
        assert_eq!(result, "STDERR:\nerror");
    }

    #[test]
    fn combine_output_both_empty() {
        let result = combine_output("", "");
        assert_eq!(result, "");
    }

    #[test]
    fn resolve_timeout_ms_uses_provided_value() {
        assert_eq!(resolve_timeout_ms(Some(5000), 120000, 120000), Some(5000));
    }

    #[test]
    fn resolve_timeout_ms_falls_back_to_default() {
        assert_eq!(resolve_timeout_ms(None, 120000, 120000), Some(120000));
    }

    #[test]
    fn resolve_timeout_ms_clamps_to_max() {
        assert_eq!(
            resolve_timeout_ms(Some(200000), 120000, 120000),
            Some(120000)
        );
    }

    #[test]
    fn resolve_timeout_ms_treats_zero_as_disabled() {
        assert_eq!(resolve_timeout_ms(Some(0), 120000, 120000), None);
    }
}
