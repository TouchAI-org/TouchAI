// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用更新命令。

use crate::core::updater::{
    self, AppUpdateChannel, AppUpdateCheckResult, AppUpdateInfo, AppUpdaterState,
};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::core::{built_in_tools::BuiltInProcessExecutionRegistry, mcp::McpClientManager};

#[tauri::command]
pub async fn updater_check_for_updates(
    state: State<'_, AppUpdaterState>,
    channel: AppUpdateChannel,
) -> Result<AppUpdateCheckResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || updater::check_for_updates(&state, channel))
        .await
        .map_err(|error| format!("check for updates task join failed: {}", error))?
}

#[tauri::command]
pub async fn updater_download_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppUpdaterState>,
) -> Result<AppUpdateInfo, String> {
    updater::download_update(app, state.inner()).await
}

#[tauri::command]
pub async fn updater_install_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AppUpdaterState>,
) -> Result<bool, String> {
    if let Some(client_manager) = app.try_state::<McpClientManager>() {
        client_manager.disconnect_all().await?;
    }

    if let Some(registry) = app.try_state::<BuiltInProcessExecutionRegistry>() {
        let cancelled = registry.cancel_all();
        if cancelled > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }

    updater::install_update(app, state.inner()).await
}
