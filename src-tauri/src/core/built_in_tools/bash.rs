// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Windows PowerShell 执行器。

use std::process::Stdio;
use std::time::{Duration, Instant};

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time;

use super::types::{BuiltInBashExecutionRequest, BuiltInBashExecutionResponse};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

/// 执行 PowerShell 非交互命令并返回结构化结果。
///
/// # 参数
/// - `request`: 命令文本、工作目录和超时配置。
///
/// # 返回值
/// - 成功时返回完整 stdout/stderr、退出码和耗时。
/// - 启动失败、工作目录非法或非 Windows 平台时返回错误。
pub async fn execute_bash(
    request: BuiltInBashExecutionRequest,
) -> Result<BuiltInBashExecutionResponse, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = request;
        return Err("Built-in Bash tool is only available on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    execute_bash_windows(request).await
}

#[cfg(target_os = "windows")]
async fn execute_bash_windows(
    request: BuiltInBashExecutionRequest,
) -> Result<BuiltInBashExecutionResponse, String> {
    let trimmed_command = request.command.trim();
    if trimmed_command.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);

    // 只启动一次受控的 PowerShell 子进程，并显式关闭配置文件加载与交互能力，
    // 避免用户本地命令环境配置把工具执行语义变成“因机器而异”。
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(trimmed_command)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    if let Some(working_directory) = request.working_directory.as_deref() {
        command.current_dir(working_directory);
    }

    let started_at = Instant::now();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn PowerShell process: {}", error))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture process stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture process stderr".to_string())?;

    // 先把 stdout/stderr 读取任务接管出去，再等待子进程结束。
    // 这样可以避免大输出量时，子进程因为管道缓冲区写满而卡死在 wait 前。
    let stdout_task = tokio::spawn(read_stream(stdout));
    let stderr_task = tokio::spawn(read_stream(stderr));
    let timeout = time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(timeout);

    // 进程退出和超时共用一个分支选择：
    // - 正常结束：保留真实退出码；
    // - 超时：主动终止并回收进程，确保宿主不会留下孤儿进程。
    let timed_out = tokio::select! {
        status = child.wait() => {
            status.map_err(|error| format!("Failed to wait for PowerShell process: {}", error))?;
            false
        }
        _ = &mut timeout => {
            // 超时后主动终止子进程，避免图形界面宿主里留下孤儿进程。
            child
                .kill()
                .await
                .map_err(|error| format!("Failed to terminate timed out PowerShell process: {}", error))?;
            child
                .wait()
                .await
                .map_err(|error| format!("Failed to reap timed out PowerShell process: {}", error))?;
            true
        }
    };

    // 无论进程是正常结束还是被超时终止，都等待读流任务收尾，
    // 保证返回给上层的是完整输出快照，而不是半截日志。
    let stdout = stdout_task
        .await
        .map_err(|error| format!("Failed to join stdout task: {}", error))??;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("Failed to join stderr task: {}", error))??;

    let output = child
        .try_wait()
        .map_err(|error| format!("Failed to inspect PowerShell exit status: {}", error))?;
    let exit_code = output.and_then(|status| status.code());
    let duration_ms = started_at.elapsed().as_millis() as u64;
    let success = !timed_out && exit_code == Some(0);
    let combined_output = combine_output(&stdout, &stderr);

    Ok(BuiltInBashExecutionResponse {
        command: trimmed_command.to_string(),
        shell: "powershell".to_string(),
        working_directory: request.working_directory,
        exit_code,
        success,
        timed_out,
        duration_ms,
        stdout,
        stderr,
        combined_output,
    })
}

/// 读取完整 stdout/stderr。
///
/// 这里统一做宽松的 UTF-8 解码，因为命令输出编码不可完全信任；
/// 对工具日志来说，“尽可能保留可读内容”比“遇到坏字节直接失败”更重要。
async fn read_stream<R>(mut reader: R) -> Result<String, String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buffer = Vec::new();
    reader
        .read_to_end(&mut buffer)
        .await
        .map_err(|error| format!("Failed to read process stream: {}", error))?;

    Ok(String::from_utf8_lossy(&buffer).trim().to_string())
}

/// 统一组合 stdout/stderr，方便上层日志和工具结果直接使用。
fn combine_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (false, false) => format!("STDOUT:\n{}\n\nSTDERR:\n{}", stdout, stderr),
        (false, true) => stdout.to_string(),
        (true, false) => format!("STDERR:\n{}", stderr),
        (true, true) => String::new(),
    }
}
