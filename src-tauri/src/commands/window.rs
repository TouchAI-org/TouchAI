//! 窗口命令。

use crate::core::window::popup::{self, PopupConfig, PopupRegistry};
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeWindowHeightParams {
    pub target_height: f64,
    pub center: Option<bool>,
    /// 是否启用高度动画（None 时 main 窗口默认启用）。
    pub animate: Option<bool>,
    /// 是否遵循原生侧的 ManualOverride 模式（None 时默认 true）。
    pub respect_manual_override: Option<bool>,
}

/// 搜索窗口默认尺寸，双向序列化用于 IPC 命令的请求和响应。
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWindowDefaultsPayload {
    pub width: f64,
    pub height: f64,
}

/// 设置搜索窗口最小尺寸约束的请求载荷。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWindowMinimumSizePayload {
    pub min_width: f64,
    pub min_height: f64,
    pub max_height: Option<f64>,
}

/// 搜索窗口当前状态快照，返回给前端用于同步高度模式。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchWindowStatePayload {
    pub defaults: SearchWindowDefaultsPayload,
    pub current_width: f64,
    pub current_height: f64,
    pub height_mode: crate::core::window::search::bounds::HeightMode,
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

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatusReminderNotificationPayload {
    pub title: String,
    pub body: String,
}

#[tauri::command]
pub fn hide_search_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::hide_search_window(app)
}

#[tauri::command]
pub fn show_search_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::show_search_window(app)
}

#[tauri::command]
pub async fn open_settings_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::build_settings_window(&app).await
}

#[tauri::command]
pub fn close_tray_menu<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::tray::close_tray_menu(app)
}

#[tauri::command]
pub fn set_tray_badge_count<R: Runtime>(app: AppHandle<R>, count: u32) -> Result<(), String> {
    crate::core::window::tray::set_tray_badge_count(app, count)
}

#[tauri::command]
pub fn clear_tray_badge<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::tray::clear_tray_badge(app)
}

#[tauri::command]
pub fn show_session_status_reminder_notification<R: Runtime>(
    app: AppHandle<R>,
    payload: SessionStatusReminderNotificationPayload,
) -> Result<(), String> {
    crate::core::window::status_reminder::show_session_status_reminder_notification(
        &app,
        &payload.title,
        &payload.body,
    )
}

#[tauri::command]
pub fn clear_session_status_reminder_notifications<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    crate::core::window::status_reminder::clear_session_status_reminder_notifications(&app)
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
pub async fn preload_popup_windows<R: Runtime>(
    app: AppHandle<R>,
    registry: State<'_, PopupRegistry>,
) -> Result<(), String> {
    popup::preload_popup_windows(app, registry.inner()).await
}

#[tauri::command]
pub async fn show_popup_window<R: Runtime>(
    app: AppHandle<R>,
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
pub fn hide_popup_window<R: Runtime>(
    app: AppHandle<R>,
    params: HidePopupWindowParams,
) -> Result<(), String> {
    popup::hide_popup_window(
        app,
        params.popup_id,
        params.window_label,
        params.popup_session_version,
    )
}

#[tauri::command]
pub async fn resize_window_height<R: Runtime>(
    window: WebviewWindow<R>,
    params: ResizeWindowHeightParams,
) -> Result<(), String> {
    crate::core::window::resize::resize_window_height(
        window,
        params.target_height,
        params.center,
        params.animate,
        params.respect_manual_override,
    )
    .await
}

/// 更新搜索窗口默认尺寸，返回经最小值约束后的实际值。
#[tauri::command]
pub fn set_search_window_defaults<R: Runtime>(
    app: AppHandle<R>,
    defaults: SearchWindowDefaultsPayload,
) -> Result<SearchWindowDefaultsPayload, String> {
    let next = crate::core::window::search::surface::update_window_defaults(
        &app,
        crate::core::window::search::bounds::SearchWindowDefaults {
            width: defaults.width,
            height: defaults.height,
        },
    )?;

    Ok(SearchWindowDefaultsPayload {
        width: next.width,
        height: next.height,
    })
}

/// 动态设置搜索窗口的最小/最大高度约束。
#[tauri::command]
pub fn set_search_window_min_size<R: Runtime>(
    app: AppHandle<R>,
    size: SearchWindowMinimumSizePayload,
) -> Result<(), String> {
    crate::core::window::resize::set_search_window_min_size(
        &app,
        size.min_width,
        size.min_height,
        size.max_height,
    )
}

/// 将搜索窗口尺寸重置为当前默认值并居中。
#[tauri::command]
pub fn reset_search_window_bounds<R: Runtime>(window: WebviewWindow<R>) -> Result<(), String> {
    crate::core::window::resize::reset_search_window_to_defaults(&window)
}

/// 获取搜索窗口当前状态快照（默认尺寸、当前宽高、高度模式）。
#[tauri::command]
pub fn get_search_window_state<R: Runtime>(
    app: AppHandle<R>,
) -> Result<SearchWindowStatePayload, String> {
    let runtime = app
        .try_state::<crate::core::window::search::surface::SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let snapshot = runtime.window_state().snapshot();
    Ok(SearchWindowStatePayload {
        defaults: SearchWindowDefaultsPayload {
            width: snapshot.defaults.width,
            height: snapshot.defaults.height,
        },
        current_width: snapshot.current_width,
        current_height: snapshot.current_height,
        height_mode: snapshot.height_mode,
    })
}

#[tauri::command]
pub fn set_search_surface_hide_on_app_blur<R: Runtime>(
    app: AppHandle<R>,
    should_hide: bool,
) -> Result<(), String> {
    crate::core::window::search::set_search_surface_hide_on_app_blur(app, should_hide)
}

/// 设置是否允许用户通过手动拖拽覆盖搜索窗口高度。
#[tauri::command]
pub fn set_search_window_allow_height_override<R: Runtime>(
    app: AppHandle<R>,
    allow: bool,
) -> Result<(), String> {
    crate::core::window::search::surface::set_allow_height_override(&app, allow)
}
