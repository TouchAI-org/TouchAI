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
        // 缓冲区必须按解码器给出的最坏情况上界预留：容量不足时
        // `decode_to_string` 会返回 `OutputFull` 并保留未消费的输入，
        // 而被丢弃的字节会破坏跨读取边界的多字节 UTF-8 序列。
        let capacity = decoder
            .max_utf8_buffer_length(bytes.len())
            .unwrap_or_else(|| bytes.len().saturating_mul(3).saturating_add(4));
        let mut decoded = String::with_capacity(capacity.max(4));

        let (result, consumed, _) = decoder.decode_to_string(bytes, &mut decoded, is_last);
        debug_assert!(
            matches!(result, encoding_rs::CoderResult::InputEmpty),
            "UTF-8 解码必须在预留容量内消费全部输入"
        );
        debug_assert_eq!(consumed, bytes.len(), "解码必须消费本次读取的全部字节");
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

    /// 逐字节到达的多字节 UTF-8 序列不能被解码缓冲区容量截断。
    #[tokio::test]
    async fn read_stream_with_progress_decodes_multibyte_reads_across_chunks() {
        struct OneByteAtATime {
            bytes: Vec<u8>,
            offset: usize,
        }

        impl tokio::io::AsyncRead for OneByteAtATime {
            fn poll_read(
                mut self: std::pin::Pin<&mut Self>,
                _cx: &mut std::task::Context<'_>,
                buf: &mut tokio::io::ReadBuf<'_>,
            ) -> std::task::Poll<std::io::Result<()>> {
                if self.offset >= self.bytes.len() {
                    return std::task::Poll::Ready(Ok(()));
                }

                let byte = self.bytes[self.offset];
                self.offset += 1;
                buf.put_slice(&[byte]);
                std::task::Poll::Ready(Ok(()))
            }
        }

        let text = "多字节🙂收尾";
        let reader = OneByteAtATime {
            bytes: text.as_bytes().to_vec(),
            offset: 0,
        };
        let mut chunks = Vec::new();

        let output = read_stream_with_progress(reader, |chunk| {
            chunks.push(chunk.to_string());
            Ok(())
        })
        .await
        .expect("byte-at-a-time decoding should succeed");

        assert_eq!(output, text);
        assert_eq!(chunks.concat(), text);
    }
}
