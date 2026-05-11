//! 窗口命令。

use crate::core::window::popup::{self, PopupConfig, PopupRegistry};
use tauri::{AppHandle, State, WebviewWindow};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeWindowHeightParams {
    pub target_height: f64,
    pub center: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowPopupWindowParams {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub popup_type: String,
    pub popup_id: String,
    pub window_label: String,
    pub popup_session_version: u64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HidePopupWindowParams {
    pub popup_id: String,
    pub window_label: String,
    pub popup_session_version: u64,
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
    params: ShowPopupWindowParams,
) -> Result<(), String> {
    popup::show_popup_window(
        app,
        registry.inner(),
        params.x,
        params.y,
        params.width,
        params.height,
        params.popup_type,
        params.popup_id,
        params.window_label,
        params.popup_session_version,
    )
    .await
}

#[tauri::command]
pub fn hide_popup_window(app: AppHandle, params: HidePopupWindowParams) -> Result<(), String> {
    popup::hide_popup_window(
        app,
        params.popup_id,
        params.window_label,
        params.popup_session_version,
    )
}

#[tauri::command]
pub async fn resize_window_height(
    window: WebviewWindow,
    params: ResizeWindowHeightParams,
) -> Result<(), String> {
    crate::core::window::resize::resize_window_height(window, params.target_height, params.center)
        .await
}

#[tauri::command]
pub fn set_search_surface_hide_on_app_blur(
    app: AppHandle,
    should_hide: bool,
) -> Result<(), String> {
    crate::core::window::search::set_search_surface_hide_on_app_blur(app, should_hide)
}
