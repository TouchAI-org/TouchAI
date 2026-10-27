// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 可观测性命令入口。
//!
//! 命令包装放在这里，`tauri::command` 生成的名字才能被 `generate_handler!` 找到。

use crate::core::observability::ingest::{ingest_batch, run_id_string, LogEnvelope};

/// 接收前端批量日志。
#[tauri::command]
pub fn obs_ingest(batch: Vec<LogEnvelope>) -> Result<(), String> {
    ingest_batch(batch)
}

/// 返回本次运行的标识。
#[tauri::command]
pub fn obs_run_id() -> String {
    run_id_string()
}
