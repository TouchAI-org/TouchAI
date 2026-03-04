//! 窗口命令。

use crate::core::window::popup::{self, PopupConfig, PopupRegistry};
use tauri::{AppHandle, State};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeWindowHeightParams {
    pub target_height: f64,
    pub min_height: Option<f64>,
    pub max_height: Option<f64>,
    pub center: Option<bool>,
    pub animate: Option<bool>,
    pub duration_ms: Option<u64>,
    pub window_label: Option<String>,
}

#[tauri::command]
pub fn hide_search_window(app: AppHandle) -> Result<(), String> {
    crate::core::window::hide_search_window(app)
}

#[tauri::command]
pub async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    crate::core::window::build_settings_window(&app).await
}

#[tauri::command]
pub fn close_tray_menu(app: AppHandle) -> Result<(), String> {
    crate::core::window::tray::close_tray_menu(app)
}

#[tauri::command]
pub fn register_popup_configs(
    registry: State<PopupRegistry>,
    configs: Vec<PopupConfig>,
) -> Result<(), String> {
    registry.register_batch(configs)?;
    Ok(())
}

#[tauri::command]
pub async fn preload_popup_windows(
    app: AppHandle,
    registry: State<'_, PopupRegistry>,
) -> Result<(), String> {
    popup::preload_popup_windows(app, registry.inner()).await
}

#[tauri::command]
pub async fn show_popup_window(
    app: AppHandle,
    registry: State<'_, PopupRegistry>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    popup_type: String,
) -> Result<(), String> {
    popup::show_popup_window(app, registry.inner(), x, y, width, height, popup_type).await
}

#[tauri::command]
pub fn hide_popup_window(app: AppHandle) -> Result<(), String> {
    popup::hide_popup_window(app)
}

#[tauri::command]
pub fn is_popup_visible(app: AppHandle) -> Result<bool, String> {
    popup::is_popup_visible(app)
}

#[tauri::command]
pub fn is_popup_focused(app: AppHandle) -> Result<bool, String> {
    popup::is_popup_focused(app)
}

#[tauri::command]
pub fn is_app_focused(app: AppHandle) -> Result<bool, String> {
    popup::is_app_focused(app)
}

#[tauri::command]
pub async fn resize_window_height(
    app: AppHandle,
    params: ResizeWindowHeightParams,
) -> Result<(), String> {
    crate::core::window::resize::resize_window_height(
        app,
        params.target_height,
        params.min_height,
        params.max_height,
        params.center,
        params.animate,
        params.duration_ms,
        params.window_label,
    )
    .await
}
