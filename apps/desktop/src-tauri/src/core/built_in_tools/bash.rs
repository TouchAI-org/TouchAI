// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Windows PowerShell 执行器。
//!
//! 执行前会尝试释放嵌入的 rg / rtk 二进制到 assets/bin，
//! 并将该目录追加到 PATH，使模型可通过 bash 直接调用 rg / rtk。

#[cfg(target_os = "windows")]
use std::process::{ExitStatus, Stdio};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
#[cfg(target_os = "windows")]
use tokio::process::Command;
#[cfg(target_os = "windows")]
use tokio::time;

#[cfg(target_os = "windows")]
use super::process_utils::{
    combine_output, read_stream_with_progress, resolve_timeout_ms, terminate_child,
};
use super::registry::BashExecutionRegistry;
use super::types::{
    BuiltInBashExecutionRequest, BuiltInBashExecutionResponse, BuiltInBashStreamChannel,
    BuiltInBashStreamChunk,
};
#[cfg(target_os = "windows")]
use crate::core::system::bundled::get_bundled_rtk_directory;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
/// 前台命令的默认超时（2 分钟），与 TS 侧 `DEFAULT_BASH_TOOL_CONFIG.timeoutMs` 一致。
#[cfg(target_os = "windows")]
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
#[cfg(target_os = "windows")]
const MAX_TIMEOUT_MS: u64 = 120_000;
#[cfg(target_os = "windows")]
const UTF8_POWERSHELL_PRELUDE: &str =
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);";

/// 执行 PowerShell 非交互命令并返回结构化结果。
///
/// 执行前会尝试释放嵌入的 rg / rtk 二进制并将其目录追加到 PATH，
/// 使模型可以直接在 bash 中调用 `rg` / `rtk`。
pub async fn execute_bash(
    request: BuiltInBashExecutionRequest,
    registry: &BashExecutionRegistry,
    stream: Option<Channel<BuiltInBashStreamChunk>>,
) -> Result<BuiltInBashExecutionResponse, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (request, registry, stream);
        return Err("Built-in Bash tool is only available on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    execute_bash_windows(request, registry, stream).await
}

/// 构建 PATH 前缀脚本：如果 bundled rtk 可用，将其目录追加到 PATH 最前面。
#[cfg(target_os = "windows")]
fn build_path_prelude() -> String {
    let mut dirs = Vec::new();
    if let Some(rtk_dir) = get_bundled_rtk_directory() {
        dirs.push(rtk_dir.to_string_lossy().replace('\'', "''"));
    }
    if dirs.is_empty() {
        String::new()
    } else {
        let joined = dirs.join(";");
        format!("$env:PATH = '{joined};' + $env:PATH;")
    }
}

/// 尝试通过 rtk rewrite 重写命令。
///
/// 调用 `rtk rewrite <cmd>`，有输出且与原命令不同则返回重写结果，
/// 否则返回 None（调用方应原样执行原命令）。
///
/// rtk rewrite 退出码：0 = 可重写，1 = 不支持，3 = 可重写但需用户确认。
/// 本函数不区分 0 和 3，统一返回重写后的命令。
#[cfg(target_os = "windows")]
async fn try_rtk_rewrite(command: &str) -> Option<String> {
    let rtk_dir = get_bundled_rtk_directory()?;
    let rtk_exe = rtk_dir.join("rtk.exe");

    let output = Command::new(&rtk_exe)
        .arg("rewrite")
        .arg(command)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;

    let rewritten = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !rewritten.is_empty() && rewritten != command {
        return Some(rewritten);
    }

    None
}

#[cfg(target_os = "windows")]
async fn execute_bash_windows(
    request: BuiltInBashExecutionRequest,
    registry: &BashExecutionRegistry,
    stream: Option<Channel<BuiltInBashStreamChunk>>,
) -> Result<BuiltInBashExecutionResponse, String> {
    let trimmed_command = request.command.trim();
    if trimmed_command.is_empty() {
        return Err("Command cannot be empty".to_string());
    }

    // 当输出压缩启用且模型未请求原始输出时，通过 rtk rewrite 判断命令是否可重写，
    // 支持的命令自动替换为 rtk 等价形式，不支持的原样执行。
    let (effective_command, compressed) =
        if request.compact_output && !request.raw_output && get_bundled_rtk_directory().is_some() {
            match try_rtk_rewrite(trimmed_command).await {
                Some(rewritten) => (rewritten, true),
                None => (trimmed_command.to_string(), false),
            }
        } else {
            (trimmed_command.to_string(), false)
        };

    let timeout_ms = resolve_timeout_ms(request.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let command_script = build_powershell_command_script(&effective_command);
    let execution_id = request.execution_id.clone();
    let (mut cancel_receiver, registration) = registry.register(execution_id.clone());

    // 只启动一次受控的 PowerShell 子进程，并显式关闭配置文件加载与交互能力，
    // 避免用户本地命令环境配置把工具执行语义变成"因机器而异"。
    let mut command = Command::new("powershell.exe");
    command
        .arg("-NoLogo")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-Command")
        .arg(command_script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);

    if let Some(working_directory) = request.working_directory.as_deref() {
        command.current_dir(working_directory);
    }

    let started_at = Instant::now();
    let mut child = command.spawn().map_err(|error| {
        registry.complete(&execution_id, registration);
        format!("Failed to spawn PowerShell process: {}", error)
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            registry.complete(&execution_id, registration);
            let _ = child.kill().await;
            return Err("Failed to capture process stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            registry.complete(&execution_id, registration);
            let _ = child.kill().await;
            return Err("Failed to capture process stderr".to_string());
        }
    };

    // 先把 stdout/stderr 读取任务接管出去，再等待子进程结束。
    // 这样可以避免大输出量时，子进程因为管道缓冲区写满而卡死在 wait 前。
    let stdout_task = {
        let execution_id = execution_id.clone();
        let stream = stream.clone();
        tokio::spawn(async move {
            read_stream_with_progress(stdout, |chunk| {
                emit_bash_stream_chunk(
                    stream.as_ref(),
                    &execution_id,
                    BuiltInBashStreamChannel::Stdout,
                    chunk,
                )
            })
            .await
        })
    };
    let stderr_task = {
        let execution_id = execution_id.clone();
        let stream = stream.clone();
        tokio::spawn(async move {
            read_stream_with_progress(stderr, |chunk| {
                emit_bash_stream_chunk(
                    stream.as_ref(),
                    &execution_id,
                    BuiltInBashStreamChannel::Stderr,
                    chunk,
                )
            })
            .await
        })
    };
    // `None` 表示用户显式关闭超时（配置为 0）：只保留取消分支，
    // 命令要么自己结束，要么由用户取消。
    let timeout = async {
        match timeout_ms {
            Some(ms) => time::sleep(Duration::from_millis(ms)).await,
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(timeout);
    let cancel_signal = async {
        let _ = (&mut cancel_receiver).await;
    };
    tokio::pin!(cancel_signal);

    // 进程退出和超时共用一个分支选择：
    // - 正常结束：保留真实退出码；
    // - 超时/取消：主动终止并回收进程，确保宿主不会留下孤儿进程。
    let completion: Result<BashExecutionCompletion, String> = tokio::select! {
        status = child.wait() => {
            Ok(BashExecutionCompletion::Completed(
                status.map_err(|error| format!("Failed to wait for PowerShell process: {}", error))?
            ))
        }
        _ = &mut timeout => {
            Ok(BashExecutionCompletion::TimedOut(
                terminate_child(&mut child, "PowerShell timed out")
                    .await
                    .map_err(|error| format!("Failed to terminate timed out PowerShell process: {}", error))?
            ))
        }
        _ = &mut cancel_signal => {
            Ok(BashExecutionCompletion::Cancelled(
                terminate_child(&mut child, "PowerShell cancelled")
                    .await
                    .map_err(|error| format!("Failed to terminate cancelled PowerShell process: {}", error))?
            ))
        }
    };
    registry.complete(&execution_id, registration);
    let completion = completion?;

    // 无论进程是正常结束还是被超时终止，都等待读流任务收尾，
    // 保证返回给上层的是完整输出快照，而不是半截日志。
    let stdout = stdout_task
        .await
        .map_err(|error| format!("Failed to join stdout task: {}", error))??;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("Failed to join stderr task: {}", error))??;

    let (exit_status, timed_out, cancelled) = match completion {
        BashExecutionCompletion::Completed(status) => (status, false, false),
        BashExecutionCompletion::TimedOut(status) => (status, true, false),
        BashExecutionCompletion::Cancelled(status) => (status, false, true),
    };
    let exit_code = exit_status.code();
    let duration_ms = started_at.elapsed().as_millis() as u64;
    let success = !timed_out && !cancelled && exit_code == Some(0);
    let combined_output = combine_output(&stdout, &stderr);

    Ok(BuiltInBashExecutionResponse {
        command: trimmed_command.to_string(),
        shell: "powershell".to_string(),
        working_directory: request.working_directory,
        exit_code,
        success,
        timed_out,
        cancelled,
        duration_ms,
        stdout,
        stderr,
        combined_output,
        compressed,
    })
}

#[cfg(target_os = "windows")]
enum BashExecutionCompletion {
    Completed(ExitStatus),
    TimedOut(ExitStatus),
    Cancelled(ExitStatus),
}

/// 组装 PowerShell 脚本：UTF-8 预设 + rg/rtk PATH 前缀 + 用户命令。
#[cfg(target_os = "windows")]
fn build_powershell_command_script(command: &str) -> String {
    let path_prelude = build_path_prelude();
    if path_prelude.is_empty() {
        // 保持用户命令从新行开始，避免破坏 here-string 等必须行首起始的语法。
        format!("{}\n{}", UTF8_POWERSHELL_PRELUDE, command)
    } else {
        format!("{}\n{}\n{}", UTF8_POWERSHELL_PRELUDE, path_prelude, command)
    }
}

#[cfg(target_os = "windows")]
fn emit_bash_stream_chunk(
    output_channel: Option<&Channel<BuiltInBashStreamChunk>>,
    execution_id: &str,
    stream: BuiltInBashStreamChannel,
    chunk: &str,
) -> Result<(), String> {
    if let Some(channel) = output_channel {
        // 转发失败（例如 webview 已重载）不能中断读流：否则剩余输出会被丢弃，
        // 最终结果也会变成 "Failed to send bash stream chunk"。
        if let Err(error) = channel.send(BuiltInBashStreamChunk {
            execution_id: execution_id.to_string(),
            stream,
            chunk: chunk.to_string(),
        }) {
            log::warn!("Failed to send bash stream chunk: {error}");
        }
    }

    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tauri::ipc::{Channel, InvokeResponseBody};

    fn capture_stream_chunks(
        captured_chunks: Arc<Mutex<Vec<BuiltInBashStreamChunk>>>,
    ) -> Channel<BuiltInBashStreamChunk> {
        Channel::new(move |body: InvokeResponseBody| {
            let chunk = body.deserialize::<BuiltInBashStreamChunk>()?;
            captured_chunks
                .lock()
                .expect("captured_chunks mutex poisoned")
                .push(chunk);
            Ok(())
        })
    }

    #[tokio::test]
    async fn streams_stdout_and_stderr_chunks_through_ipc_channel() {
        let registry = BashExecutionRegistry::new();
        let captured_chunks = Arc::new(Mutex::new(Vec::new()));
        let request = BuiltInBashExecutionRequest {
            execution_id: "exec-stream-rust".to_string(),
            command: "Write-Output 'alpha'; [Console]::Error.WriteLine('beta')".to_string(),
            working_directory: None,
            timeout_ms: Some(5_000),
            compact_output: false,
            raw_output: false,
        };

        let response = execute_bash(
            request,
            &registry,
            Some(capture_stream_chunks(Arc::clone(&captured_chunks))),
        )
        .await
        .expect("bash execution should succeed");

        let chunks = captured_chunks
            .lock()
            .expect("captured_chunks mutex poisoned")
            .clone();
        let stdout_chunks: Vec<_> = chunks
            .iter()
            .filter(|chunk| matches!(chunk.stream, BuiltInBashStreamChannel::Stdout))
            .map(|chunk| chunk.chunk.clone())
            .collect();
        let stderr_chunks: Vec<_> = chunks
            .iter()
            .filter(|chunk| matches!(chunk.stream, BuiltInBashStreamChannel::Stderr))
            .map(|chunk| chunk.chunk.clone())
            .collect();

        assert!(response.success);
        assert_eq!(response.combined_output, "STDOUT:\nalpha\n\nSTDERR:\nbeta");
        assert!(chunks
            .iter()
            .all(|chunk| chunk.execution_id == "exec-stream-rust"));
        assert_eq!(stdout_chunks.concat().trim(), "alpha");
        assert_eq!(stderr_chunks.concat().trim(), "beta");
    }

    #[tokio::test]
    async fn executes_successfully_without_a_stream_channel() {
        let registry = BashExecutionRegistry::new();
        let request = BuiltInBashExecutionRequest {
            execution_id: "exec-no-stream".to_string(),
            command: "Write-Output 'alpha'".to_string(),
            working_directory: None,
            timeout_ms: Some(5_000),
            compact_output: false,
            raw_output: false,
        };

        let response = execute_bash(request, &registry, None)
            .await
            .expect("bash execution without a stream channel should succeed");

        assert!(response.success);
        assert_eq!(response.stdout, "alpha");
        assert_eq!(response.stderr, "");
        assert_eq!(response.combined_output, "alpha");
    }

    #[tokio::test]
    async fn keeps_collecting_output_when_the_stream_channel_fails() {
        let registry = BashExecutionRegistry::new();
        let request = BuiltInBashExecutionRequest {
            execution_id: "exec-failing-stream".to_string(),
            command: "Write-Output 'still-complete'".to_string(),
            working_directory: None,
            timeout_ms: Some(5_000),
            compact_output: false,
            raw_output: false,
        };
        let failing_channel =
            Channel::new(|_body: InvokeResponseBody| Err(tauri::Error::FailedToReceiveMessage));

        let response = execute_bash(request, &registry, Some(failing_channel))
            .await
            .expect("a failing stream channel must not fail the execution");

        assert!(response.success);
        assert_eq!(response.stdout, "still-complete");
        assert_eq!(response.stderr, "");
        assert_eq!(response.combined_output, "still-complete");
    }
}
