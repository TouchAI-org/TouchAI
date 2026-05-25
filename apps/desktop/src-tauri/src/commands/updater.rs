// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用更新命令。

use crate::core::updater::{
    self, AppUpdateChannel, AppUpdateCheckResult, AppUpdateInfo, AppUpdaterState,
};
use tauri::{AppHandle, Runtime, State};

#[tauri::command]
pub fn updater_check_for_updates(
    state: State<'_, AppUpdaterState>,
    channel: AppUpdateChannel,
) -> Result<AppUpdateCheckResult, String> {
    updater::check_for_updates(state.inner(), channel)
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
    updater::install_update(app, state.inner()).await
}
