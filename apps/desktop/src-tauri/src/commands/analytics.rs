// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 产品分析命令。
//!
//! 命令层只负责把前端请求转交给原生分析运行时；授权、身份、队列和发送
//! 全部由 `core/analytics` 负责，前端不接触自由 SQL 或网络细节。

use tauri::State;

use crate::core::analytics::{
    AnalyticsRuntime, AnalyticsState, AnalyticsSubmitResult, AnalyticsTrackRequest,
};

/// 读取当前统计状态与队列概览。
#[tauri::command]
pub async fn analytics_get_state(
    runtime: State<'_, AnalyticsRuntime>,
) -> Result<AnalyticsState, String> {
    runtime.state().await
}

/// 记录用户的显式开关选择；过期的 consent epoch 不会覆盖较新的选择。
#[tauri::command]
pub async fn analytics_set_enabled(
    runtime: State<'_, AnalyticsRuntime>,
    enabled: bool,
    expected_consent_epoch: i64,
) -> Result<AnalyticsState, String> {
    runtime.set_enabled(enabled, expected_consent_epoch).await
}

/// 清空待发队列但不改变开关状态。
#[tauri::command]
pub async fn analytics_clear_pending(
    runtime: State<'_, AnalyticsRuntime>,
    expected_consent_epoch: i64,
) -> Result<AnalyticsState, String> {
    runtime.clear_pending(expected_consent_epoch).await
}

/// 提交一个已登记事件；身份、版本与平台由原生运行时补齐。
#[tauri::command]
pub async fn analytics_track(
    runtime: State<'_, AnalyticsRuntime>,
    request: AnalyticsTrackRequest,
) -> Result<AnalyticsSubmitResult, String> {
    Ok(runtime.track(request).await)
}

/// 立即尝试发送一批待发事件，用于设置页的“立即发送”。
#[tauri::command]
pub async fn analytics_flush(runtime: State<'_, AnalyticsRuntime>) -> Result<(), String> {
    runtime.flush().await
}
