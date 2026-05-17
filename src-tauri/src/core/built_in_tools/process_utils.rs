// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具共享的进程管理辅助函数。

use tokio::io::AsyncReadExt;
use tokio::process::Child;

/// 读取完整的 stdout/stderr 流。
///
/// 先做宽松 UTF-8 解码再 trim，对工具日志来说"尽可能保留可读内容"比"遇到坏字节直接失败"更重要。
pub async fn read_stream<R>(mut reader: R) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    reader
        .read_to_end(&mut buffer)
        .await
        .map_err(|error| format!("Failed to read process stream: {error}"))?;

    Ok(String::from_utf8_lossy(&buffer).trim().to_string())
}

/// 统一组合 stdout/stderr，方便上层日志和工具结果直接使用。
pub fn combine_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("STDOUT:\n{}\n\nSTDERR:\n{}", stdout, stderr),
        (false, true) => stdout.to_string(),
        (true, false) => format!("STDERR:\n{}", stderr),
        (true, true) => String::new(),
    }
}

/// 解析超时毫秒数，限制在合理范围内。
pub fn resolve_timeout_ms(timeout_ms: Option<u64>, default_ms: u64, max_ms: u64) -> u64 {
    timeout_ms.unwrap_or(default_ms).clamp(1, max_ms)
}

/// 终止子进程并等待回收。
///
/// Windows 上优先使用 `taskkill /T /F` 杀整棵进程树，
/// 避免只终止父进程后其派生的子进程成为孤儿。
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
