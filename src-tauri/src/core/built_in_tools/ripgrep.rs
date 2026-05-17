// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置 Ripgrep 执行器。

use std::{
    path::PathBuf,
    process::Stdio,
    sync::OnceLock,
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::process::Command;
use tokio::time;

use crate::core::system::paths::{app_directory_path, AppDirectory};

use super::embedded_ripgrep::{
    BUNDLED_RIPGREP_BYTES, BUNDLED_RIPGREP_FILENAME, BUNDLED_RIPGREP_SHA256,
};
use super::process_utils::{combine_output, read_stream, resolve_timeout_ms, terminate_child};
use super::registry::BuiltInProcessExecutionRegistry;
use super::types::{
    BuiltInRipgrepExecutionRequest, BuiltInRipgrepExecutionResponse, RipgrepBinarySource,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
const DEFAULT_TIMEOUT_MS: u64 = 15_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

/// 缓存已验证的二进制路径和来源，避免每次执行都重算 SHA-256。
static VERIFIED_BINARY: OnceLock<Option<(PathBuf, RipgrepBinarySource)>> = OnceLock::new();

/// 计算字节切片的 SHA-256 并返回小写十六进制字符串。
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

/// 一次性验证并解析 rg 二进制位置。
///
/// 优先使用编译时嵌入的 bundled 二进制：释放到 assets/bin 并校验 SHA-256。
/// 如果嵌入字节为空（当前平台不在清单中），回退到系统 PATH 里的 rg。
/// 返回 None 表示嵌入路径存在但无法写入磁盘（目录创建或文件写入失败）。
fn verify_and_resolve_binary() -> Option<(PathBuf, RipgrepBinarySource)> {
    if BUNDLED_RIPGREP_BYTES.is_empty() || BUNDLED_RIPGREP_FILENAME.is_empty() {
        let fallback = PathBuf::from(if cfg!(target_os = "windows") {
            "rg.exe"
        } else {
            "rg"
        });
        return Some((fallback, RipgrepBinarySource::System));
    }

    let bin_dir = match app_directory_path(AppDirectory::AssetsBin) {
        Ok(dir) => dir,
        Err(_) => return None,
    };
    if let Err(_) = std::fs::create_dir_all(&bin_dir) {
        return None;
    }
    let binary_path = bin_dir.join(BUNDLED_RIPGREP_FILENAME);

    let needs_write = if binary_path.exists() {
        match std::fs::read(&binary_path) {
            Ok(existing) => sha256_hex(&existing) != BUNDLED_RIPGREP_SHA256,
            Err(_) => true,
        }
    } else {
        true
    };

    if needs_write {
        if let Err(_) = std::fs::write(&binary_path, BUNDLED_RIPGREP_BYTES) {
            return None;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = std::fs::metadata(&binary_path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o755);
                let _ = std::fs::set_permissions(&binary_path, perms);
            }
        }
    }

    Some((binary_path, RipgrepBinarySource::Bundled))
}

/// 获取已验证的二进制路径（带 OnceLock 缓存，仅首次调用时执行验证）。
fn resolve_binary() -> Option<(PathBuf, RipgrepBinarySource)> {
    VERIFIED_BINARY
        .get_or_init(verify_and_resolve_binary)
        .clone()
}

/// 执行 ripgrep 搜索并返回结构化结果。
///
/// 支持超时和外部取消。rg 退出码 0（有匹配）和 1（无匹配）都视为成功，
/// 其他退出码视为错误。
pub async fn execute_ripgrep(
    _app: AppHandle,
    request: BuiltInRipgrepExecutionRequest,
    registry: &BuiltInProcessExecutionRegistry,
) -> Result<BuiltInRipgrepExecutionResponse, String> {
    if request.argv.is_empty() {
        return Err("Ripgrep argv cannot be empty".to_string());
    }

    let timeout_ms = resolve_timeout_ms(request.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    let (binary_path, binary_source) =
        resolve_binary().ok_or_else(|| "Failed to resolve ripgrep binary".to_string())?;
    let execution_id = request.execution_id.clone();
    let mut cancel_receiver = registry.register(execution_id.clone());

    let mut command = Command::new(&binary_path);
    command
        .args(&request.argv)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    if let Some(working_directory) = request.working_directory.as_deref() {
        command.current_dir(working_directory);
    }

    let started_at = Instant::now();
    let mut child = command.spawn().map_err(|error| {
        registry.complete(&execution_id);
        format!("Failed to spawn ripgrep process: {error}")
    })?;

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            registry.complete(&execution_id);
            let _ = child.kill().await;
            return Err("Failed to capture ripgrep stdout".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            registry.complete(&execution_id);
            let _ = child.kill().await;
            return Err("Failed to capture ripgrep stderr".to_string());
        }
    };

    let stdout_task = tokio::spawn(read_stream(stdout));
    let stderr_task = tokio::spawn(read_stream(stderr));
    let timeout = time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(timeout);
    let cancel_signal = async {
        let _ = (&mut cancel_receiver).await;
    };
    tokio::pin!(cancel_signal);

    let (timed_out, cancelled, status) = tokio::select! {
        status = child.wait() => (false, false, status.map_err(|error| format!("Failed to wait for ripgrep process: {error}"))?),
        _ = &mut timeout => (true, false, terminate_child(&mut child, "ripgrep timed out").await?),
        _ = &mut cancel_signal => (false, true, terminate_child(&mut child, "ripgrep cancelled").await?),
    };
    registry.complete(&execution_id);

    let stdout = stdout_task
        .await
        .map_err(|error| format!("Failed to join ripgrep stdout task: {error}"))??;
    let stderr = stderr_task
        .await
        .map_err(|error| format!("Failed to join ripgrep stderr task: {error}"))??;

    let combined_output = combine_output(&stdout, &stderr);

    Ok(BuiltInRipgrepExecutionResponse {
        command: format!("{} {}", binary_path.display(), request.argv.join(" ")),
        binary_path: binary_path.to_string_lossy().to_string(),
        binary_source,
        working_directory: request.working_directory,
        exit_code: status.code(),
        success: !timed_out && !cancelled && status.code() == Some(0),
        timed_out,
        cancelled,
        duration_ms: started_at.elapsed().as_millis() as u64,
        stdout,
        stderr,
        combined_output,
    })
}
