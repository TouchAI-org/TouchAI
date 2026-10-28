// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 可观测性命令入口。
//!
//! 命令包装放在这里，`tauri::command` 生成的名字才能被 `generate_handler!` 找到。

use crate::core::observability::ingest::{ingest_batch, run_id_string, LogEnvelope};
use crate::core::observability::{
    bundle::{self, BundlePreview},
    level::{self, DiagnosticModeStatus},
    shutdown,
};

/// 接收前端批量日志。写盘是阻塞操作，放到阻塞线程池，避免卡住主线程事件循环。
#[tauri::command]
pub async fn obs_ingest(batch: Vec<LogEnvelope>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || ingest_batch(batch))
        .await
        .map_err(|error| format!("log ingest task failed: {error}"))?
}

/// 返回本次运行的标识。
#[tauri::command]
pub fn obs_run_id() -> String {
    run_id_string()
}

#[tauri::command]
pub fn obs_set_diagnostic_mode(enabled: bool) -> DiagnosticModeStatus {
    level::set_diagnostic_mode(enabled)
}

#[tauri::command]
pub fn obs_diagnostic_mode_status() -> DiagnosticModeStatus {
    level::status()
}

/// 前端在退出前刷完队列后回报，让等待中的退出流程继续。
#[tauri::command]
pub fn obs_flush_done() {
    shutdown::mark_flushed();
}

#[tauri::command]
pub async fn obs_preview_bundle() -> Result<BundlePreview, String> {
    bundle::preview().await
}

#[tauri::command]
pub async fn obs_export_bundle(destination: String) -> Result<BundlePreview, String> {
    // 打包要读取并压缩最多几十 MB 的日志和崩溃记录，放到阻塞线程池执行。
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(bundle::export(&destination))
    })
    .await
    .map_err(|error| format!("log bundle task failed: {error}"))?
}

#[tauri::command]
pub async fn obs_dismiss_crashes() -> Result<usize, String> {
    // 删除最多 50 个崩溃记录同样不该占用主线程。
    tauri::async_runtime::spawn_blocking(bundle::dismiss_crashes)
        .await
        .map_err(|error| format!("crash dismiss task failed: {error}"))?
}
