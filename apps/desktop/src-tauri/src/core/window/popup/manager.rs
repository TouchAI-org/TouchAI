// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 弹窗管理逻辑。

use crate::core::window::popup::PopupRegistry;
use log::warn;
#[cfg(target_os = "windows")]
use raw_window_handle::HasWindowHandle;
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, IsChild, GA_ROOT, GA_ROOTOWNER},
};

/// 判断窗口 label 是否属于搜索主窗口或其 popup surface。
fn is_app_surface_label(label: &str) -> bool {
    label == "main" || label.starts_with("popup-")
}

#[cfg(target_os = "windows")]
/// 获取 Tauri WebviewWindow 对应的 Win32 HWND。
fn get_window_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, String> {
    let window_handle = window
        .window_handle()
        .map_err(|e| format!("Failed to get window handle: {}", e))?;

    match window_handle.as_ref() {
        raw_window_handle::RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as _)),
        _ => Err("Not a Win32 window".to_string()),
    }
}

#[cfg(target_os = "windows")]
/// 判断当前前台窗口是否是指定窗口或其 WebView 子窗口。
fn is_foreground_window_family<R: Runtime>(window: &WebviewWindow<R>) -> Result<bool, String> {
    let hwnd = get_window_hwnd(window)?;
    let foreground_hwnd = unsafe { GetForegroundWindow() };
    if foreground_hwnd.0.is_null() {
        return Ok(false);
    }

    let is_same_window = foreground_hwnd == hwnd;
    let is_child_window = unsafe { IsChild(hwnd, foreground_hwnd).as_bool() };
    let is_root_window = unsafe { GetAncestor(foreground_hwnd, GA_ROOT) == hwnd };
    let is_root_owner_window = unsafe { GetAncestor(foreground_hwnd, GA_ROOTOWNER) == hwnd };
    Ok(foreground_belongs_to_window_family(
        is_same_window,
        is_child_window,
        is_root_window,
        is_root_owner_window,
    ))
}

#[cfg(target_os = "windows")]
/// 判断 Win32 前台窗口是否归属于某个 Tauri surface 窗口族。
fn foreground_belongs_to_window_family(
    is_same_window: bool,
    is_child_window: bool,
    is_root_window: bool,
    is_root_owner_window: bool,
) -> bool {
    is_same_window || is_child_window || is_root_window || is_root_owner_window
}

pub fn build_popup_window<R: Runtime>(
    app: &AppHandle<R>,
    window_label: &str,
    title: &str,
    url: String,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
) -> Result<WebviewWindow<R>, String> {
    let make_builder = || {
        tauri::WebviewWindowBuilder::new(
            app,
            window_label,
            tauri::WebviewUrl::App(url.clone().into()),
        )
        .title(title)
        .inner_size(width, height)
        .position(x, y)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .shadow(true)
        .focused(false)
        .focusable(false)
    };

    let mut builder = make_builder();
    if let Some(main_window) = app.get_webview_window("main") {
        builder = builder
            .parent(&main_window)
            .unwrap_or_else(|_| make_builder());
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)?;
    Ok(window)
}

pub async fn preload_popup_windows<R: Runtime>(
    app: AppHandle<R>,
    registry: &PopupRegistry,
) -> Result<(), String> {
    let configs = registry.get_all();

    if configs.is_empty() {
        return Ok(());
    }

    for config in configs {
        let window_label = format!("popup-{}", config.id);

        if app.get_webview_window(&window_label).is_some() {
            continue;
        }

        let url = format!("/popup?type={}", config.id);
        match build_popup_window(
            &app,
            &window_label,
            &config.id,
            url,
            config.width,
            config.height,
            0.0,
            0.0,
        ) {
            Ok(_) => {}
            Err(e) => {
                warn!(
                    "[PopupRegistry] Failed to create {} popup: {}",
                    config.id, e
                );
            }
        }
    }

    Ok(())
}

pub async fn show_popup_window<R: Runtime>(
    app: AppHandle<R>,
    registry: &PopupRegistry,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    popup_type: String,
    popup_id: String,
    window_label: String,
    popup_session_version: u64,
) -> Result<(), String> {
    if !registry.has(&popup_type) {
        return Err(format!("Popup type '{}' not registered", popup_type));
    }

    if window_label != format!("popup-{}", popup_type) {
        return Err(format!(
            "Popup window label '{}' does not match popup type '{}'",
            window_label, popup_type
        ));
    }

    let session = crate::core::window::search::surface::PopupSurfaceSession {
        popup_id,
        popup_session_version,
        popup_type: popup_type.clone(),
        window_label: window_label.clone(),
    };

    let result = if let Some(popup) = app.get_webview_window(&window_label) {
        let _ = popup.set_focusable(true);
        popup
            .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            .map_err(|e| e.to_string())?;
        popup
            .set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
            .map_err(|e| e.to_string())?;
        popup.show().map_err(|e| e.to_string())
    } else {
        let url = format!("/popup?type={}", popup_type);
        let popup = build_popup_window(&app, &window_label, &popup_type, url, width, height, x, y)?;
        let _ = popup.set_focusable(true);
        popup.show().map_err(|e| e.to_string())
    };

    if let Err(error) = result {
        return Err(error);
    }

    if let Some(runtime) =
        app.try_state::<crate::core::window::search::surface::SearchSurfaceRuntime>()
    {
        runtime.register_popup_session(session);
    }

    Ok(())
}

pub fn hide_popup_window<R: Runtime>(
    app: AppHandle<R>,
    popup_id: String,
    window_label: String,
    popup_session_version: u64,
) -> Result<(), String> {
    crate::core::window::search::surface::hide_popup_surface(
        &app,
        Some(crate::core::window::search::surface::PopupSurfaceSession {
            popup_id,
            popup_session_version,
            popup_type: String::new(),
            window_label,
        }),
    )
}

pub fn is_app_focused<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    for (label, window) in app.webview_windows() {
        if !is_app_surface_label(&label) {
            continue;
        }

        let is_visible = window.is_visible().unwrap_or(false);
        let foreground_family = is_visible && is_foreground_window_family(&window).unwrap_or(false);
        if foreground_family {
            return Ok(true);
        }
    }

    for (label, window) in app.webview_windows() {
        if !is_app_surface_label(&label) {
            continue;
        }

        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);
        if is_visible && is_focused {
            return Ok(true);
        }
    }

    Ok(false)
}
