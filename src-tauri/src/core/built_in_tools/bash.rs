// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Windows PowerShell 执行器。
//!
//! 执行前会尝试释放嵌入的 rg / rtk 二进制到 assets/bin，
//! 并将该目录追加到 PATH，使模型可通过 bash 直接调用 rg / rtk。

#[cfg(target_os = "windows")]
use std::process::{ExitStatus, Stdio};
#[cfg(target_os = "windows")]
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use tokio::process::Command;
#[cfg(target_os = "windows")]
use tokio::time;

use super::process_utils::{combine_output, read_stream, resolve_timeout_ms, terminate_child};
use super::registry::BashExecutionRegistry;
use super::types::{BuiltInBashExecutionRequest, BuiltInBashExecutionResponse};
use crate::core::system::bundled::{get_bundled_rg_directory, get_bundled_rtk_directory};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
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
) -> Result<BuiltInBashExecutionResponse, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (request, registry);
        return Err("Built-in Bash tool is only available on Windows".to_string());
    }

    #[cfg(target_os = "windows")]
    execute_bash_windows(request, registry).await
}

/// 构建 PATH 前缀脚本：如果 bundled rg / rtk 可用，将其目录追加到 PATH 最前面。
#[cfg(target_os = "windows")]
fn build_path_prelude() -> String {
    let mut dirs = Vec::new();
    if let Some(rg_dir) = get_bundled_rg_directory() {
        dirs.push(rg_dir.to_string_lossy().replace('\'', "''"));
    }
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
    let mut cancel_receiver = registry.register(execution_id.clone());

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
        registry.complete(&execution_id);
        format!("Failed to spawn PowerShell process: {}", error)
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            registry.complete(&execution_id);
            let _ = child.kill().await;
            return Err("Failed to capture process stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            registry.complete(&execution_id);
            let _ = child.kill().await;
            return Err("Failed to capture process stderr".to_string());
        }
    };

    // 先把 stdout/stderr 读取任务接管出去，再等待子进程结束。
    // 这样可以避免大输出量时，子进程因为管道缓冲区写满而卡死在 wait 前。
    let stdout_task = tokio::spawn(read_stream(stdout));
    let stderr_task = tokio::spawn(read_stream(stderr));
    let timeout = time::sleep(Duration::from_millis(timeout_ms));
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
    registry.complete(&execution_id);
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
