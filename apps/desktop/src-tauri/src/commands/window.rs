//! 窗口命令。

use crate::core::window::status_reminder::SessionStatusReminderNotificationPayload;
use crate::core::window::tray::TrayStatusIndicator;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

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
    pub host_content_height: Option<f64>,
    pub monitor_host: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPanelSizePayload {
    pub width: f64,
    pub height: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPanelResizeCommitPayload {
    pub from: SearchPanelSizePayload,
    pub to: SearchPanelSizePayload,
    /// Logical client-space extent required by the bounded host, including overlays.
    #[serde(default)]
    pub host_content_height: Option<f64>,
    /// Renderer-owned content/viewport resize. These commits must remain in
    /// Auto mode instead of being classified as a user's manual drag.
    #[serde(default)]
    pub auto: bool,
    /// One-shot session-open measurement may clear a stale native manual override.
    #[serde(default)]
    pub respect_manual_override: Option<bool>,
    /// Explicit host placement. When omitted, content-driven resizes preserve
    /// the current host center so the visible search surface stays in place.
    #[serde(default)]
    pub placement: Option<crate::core::window::search_host::SearchHostPlacement>,
    #[serde(default)]
    pub physical_origin: Option<crate::core::window::search_host::PhysicalHostOrigin>,
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "status")]
pub enum SearchWindowRegionUpdate {
    #[serde(rename = "applied")]
    Applied {
        generation: u64,
        #[serde(rename = "showStatus", skip_serializing_if = "Option::is_none")]
        show_status: Option<crate::core::window::search::surface::SearchSurfaceShowStatus>,
    },
    #[serde(rename = "stale")]
    Stale {
        #[serde(rename = "requestedGeneration")]
        requested_generation: u64,
        #[serde(rename = "activeGeneration")]
        active_generation: u64,
    },
}

fn search_window_region_update(
    requested_generation: u64,
    applied: bool,
    active_generation: u64,
    show_status: Option<crate::core::window::search::surface::SearchSurfaceShowStatus>,
) -> SearchWindowRegionUpdate {
    if applied {
        SearchWindowRegionUpdate::Applied {
            generation: requested_generation,
            show_status,
        }
    } else {
        SearchWindowRegionUpdate::Stale {
            requested_generation,
            active_generation,
        }
    }
}

fn search_window_state_payload(
    snapshot: crate::core::window::search::bounds::SearchWindowStateSnapshot,
) -> SearchWindowStatePayload {
    SearchWindowStatePayload {
        defaults: SearchWindowDefaultsPayload {
            width: snapshot.defaults.width,
            height: snapshot.defaults.height,
        },
        current_width: snapshot.current_width,
        current_height: snapshot.current_height,
        height_mode: snapshot.height_mode,
        host_content_height: snapshot.host_content_height,
        monitor_host: cfg!(target_os = "windows"),
    }
}

#[tauri::command]
pub fn hide_search_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::hide_search_window_on_main_thread(&app)
}

#[tauri::command]
pub fn show_search_window<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
) -> Result<(), String> {
    crate::core::window::show_search_window_on_main_thread(
        &app,
        crate::core::window::search::surface::SearchSurfaceShowSource::from_requesting_window(
            window.label(),
        ),
    )
}

#[tauri::command]
pub fn mark_search_window_ready<R: Runtime>(
    window: WebviewWindow<R>,
    renderer_epoch: u64,
) -> Result<Option<crate::core::window::search::surface::SearchSurfacePreparationPayload>, String> {
    if window.label() != "main" {
        return Err(
            "Search window readiness can only be reported by the main renderer".to_string(),
        );
    }
    crate::core::window::search::surface::mark_renderer_ready_on_main_thread(
        window.app_handle(),
        renderer_epoch,
    )
}

#[tauri::command]
pub fn get_search_window_renderer_epoch<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<u64, String> {
    if window.label() != "main" {
        return Err(
            "Search window renderer epoch can only be read by the main renderer".to_string(),
        );
    }
    crate::core::window::search::surface::renderer_epoch(window.app_handle())
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
pub fn set_tray_status_indicator<R: Runtime>(
    app: AppHandle<R>,
    status: TrayStatusIndicator,
) -> Result<(), String> {
    crate::core::window::tray::set_tray_status_indicator(app, status)
}

#[tauri::command]
pub fn clear_tray_status_indicator<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::window::tray::clear_tray_status_indicator(app)
}

#[tauri::command]
pub fn show_session_status_reminder_notification<R: Runtime>(
    app: AppHandle<R>,
    payload: SessionStatusReminderNotificationPayload,
) -> Result<(), String> {
    crate::core::window::status_reminder::show_session_status_reminder_notification(&app, &payload)
}

#[tauri::command]
pub fn clear_session_status_reminder_notifications<R: Runtime>(
    app: AppHandle<R>,
) -> Result<(), String> {
    crate::core::window::status_reminder::clear_session_status_reminder_notifications(&app)
}

#[tauri::command]
pub fn set_search_window_regions<R: Runtime>(
    window: WebviewWindow<R>,
    generation: u64,
    regions: Vec<crate::core::window::search_region::SearchWindowRegion>,
    preparation: Option<crate::core::window::search::surface::SearchSurfacePreparationToken>,
) -> Result<SearchWindowRegionUpdate, String> {
    set_search_window_regions_on_main_thread(&window, generation, regions, preparation)
}

fn set_search_window_regions_on_main_thread<R: Runtime>(
    window: &WebviewWindow<R>,
    generation: u64,
    regions: Vec<crate::core::window::search_region::SearchWindowRegion>,
    preparation: Option<crate::core::window::search::surface::SearchSurfacePreparationToken>,
) -> Result<SearchWindowRegionUpdate, String> {
    if window.label() != "main" {
        return Err("Search window regions can only be reported by the main renderer".to_string());
    }
    let region_runtime = window
        .app_handle()
        .try_state::<crate::core::window::search_region::SearchRegionRuntime>()
        .ok_or_else(|| "Search region runtime is not initialized".to_string())?;
    let applied = region_runtime.apply_and_update(generation, regions, |regions| {
        if region_runtime.native_enabled() {
            crate::core::window::search_region::apply_search_window_regions(&window, regions)
        } else {
            Ok(())
        }
    })?;
    if !applied {
        return Ok(search_window_region_update(
            generation,
            false,
            region_runtime.generation(),
            None,
        ));
    }

    let commit = region_runtime.with_current_generation(generation, || {
        preparation
            .map(|token| {
                crate::core::window::search::surface::commit_prepared_region_on_main_thread(
                    window, token, generation,
                )
            })
            .unwrap_or(Ok(None))
    })?;
    let Some(show_status) = commit else {
        return Ok(search_window_region_update(
            generation,
            false,
            region_runtime.generation(),
            None,
        ));
    };
    Ok(search_window_region_update(
        generation,
        true,
        generation,
        show_status,
    ))
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
    Ok(search_window_state_payload(
        runtime.window_state().snapshot(),
    ))
}

/// Commit one completed logical-panel resize and keep the bounded native host
/// envelope in sync with the renderer-owned panel geometry.
#[tauri::command]
pub fn commit_search_panel_resize<R: Runtime>(
    window: WebviewWindow<R>,
    resize: SearchPanelResizeCommitPayload,
) -> Result<SearchWindowStatePayload, String> {
    if window.label() != "main" {
        return Err("Search panel resize can only be reported by the main renderer".to_string());
    }
    if [
        resize.from.width,
        resize.from.height,
        resize.to.width,
        resize.to.height,
        resize.host_content_height.unwrap_or(1.0),
    ]
    .into_iter()
    .any(|value| !value.is_finite() || value <= 0.0)
    {
        return Err("Search panel resize dimensions must be positive finite values".to_string());
    }

    let runtime = window
        .app_handle()
        .try_state::<crate::core::window::search::surface::SearchWindowRuntime>()
        .ok_or_else(|| "Search window runtime is not initialized".to_string())?;
    let previous = runtime.window_state().snapshot();
    let (x, y) = previous
        .last_known_frame
        .map(|frame| (frame.x, frame.y))
        .unwrap_or((0.0, 0.0));
    if resize.auto {
        runtime.window_state().commit_auto_resize(
            resize.to.width,
            resize.to.height,
            resize
                .respect_manual_override
                .unwrap_or_else(|| runtime.should_allow_height_override()),
        );
    } else {
        runtime.window_state().commit_user_resize(
            crate::core::window::search::bounds::SearchWindowFrame {
                x,
                y,
                width: resize.from.width,
                height: resize.from.height,
            },
            crate::core::window::search::bounds::SearchWindowFrame {
                x,
                y,
                width: resize.to.width,
                height: resize.to.height,
            },
            runtime.should_allow_height_override(),
        );
    }
    let snapshot = runtime
        .window_state()
        .set_host_content_height(resize.host_content_height);
    #[cfg(target_os = "windows")]
    {
        let native_resize_enabled = window
            .app_handle()
            .try_state::<crate::core::window::search_host::SearchHostRefreshRuntime>()
            .map(|runtime| runtime.native_enabled())
            .unwrap_or(true);
        if native_resize_enabled {
            if let Err(error) = runtime.resize_host_preserving_surface(|| {
                crate::core::window::search_host::resize_main_search_host_for_panel_with_origin(
                    &window,
                    snapshot.current_width,
                    snapshot.current_height,
                    resize.host_content_height,
                    resize.placement.unwrap_or(
                        crate::core::window::search_host::SearchHostPlacement::PreserveCenter,
                    ),
                    resize.physical_origin,
                )
            }) {
                runtime
                    .window_state()
                    .rollback_failed_resize(previous, snapshot);
                return Err(error);
            }
        }
    }
    Ok(search_window_state_payload(
        runtime.window_state().snapshot(),
    ))
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

#[cfg(test)]
mod tests {
    use super::{
        search_window_region_update, SearchPanelResizeCommitPayload, SearchWindowRegionUpdate,
    };

    #[test]
    fn user_can_resize_with_a_negative_physical_origin_or_without_an_origin() {
        let mut request = serde_json::json!({
            "from": { "width": 750, "height": 290 },
            "to": { "width": 800, "height": 350 },
            "placement": "preserve-origin",
        });
        let legacy: SearchPanelResizeCommitPayload =
            serde_json::from_value(request.clone()).unwrap();
        assert!(legacy.physical_origin.is_none());
        assert_eq!(
            legacy.placement,
            Some(crate::core::window::search_host::SearchHostPlacement::PreserveOrigin)
        );

        request["physicalOrigin"] = serde_json::json!({ "x": -1800, "y": -80 });
        let positioned: SearchPanelResizeCommitPayload = serde_json::from_value(request).unwrap();
        let origin = positioned.physical_origin.unwrap();
        assert_eq!((origin.x, origin.y), (-1800, -80));
    }

    #[test]
    fn user_cannot_send_fractional_or_out_of_range_physical_origins() {
        for origin in [
            serde_json::json!({ "x": 1.5, "y": 0 }),
            serde_json::json!({ "x": 0, "y": -2.5 }),
            serde_json::json!({ "x": 2147483648_i64, "y": 0 }),
            serde_json::json!({ "x": 0, "y": -2147483649_i64 }),
        ] {
            let request = serde_json::json!({
                "from": { "width": 750, "height": 290 },
                "to": { "width": 800, "height": 350 },
                "physicalOrigin": origin,
            });
            assert!(serde_json::from_value::<SearchPanelResizeCommitPayload>(request).is_err());
        }
    }

    #[test]
    fn search_window_region_update_serializes_applied_and_stale_acknowledgements() {
        assert_eq!(
            serde_json::to_value(search_window_region_update(7, true, 7, None)).unwrap(),
            serde_json::json!({ "status": "applied", "generation": 7 })
        );
        assert_eq!(
            serde_json::to_value(search_window_region_update(1, false, 100, None)).unwrap(),
            serde_json::json!({
                "status": "stale",
                "requestedGeneration": 1,
                "activeGeneration": 100
            })
        );
        assert_eq!(
            search_window_region_update(1, false, 100, None),
            SearchWindowRegionUpdate::Stale {
                requested_generation: 1,
                active_generation: 100,
            }
        );
    }
}
