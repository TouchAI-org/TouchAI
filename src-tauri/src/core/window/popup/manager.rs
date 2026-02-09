// Copyright (c) 2025. 千诚. Licensed under GPL v3.

//! 弹窗管理逻辑。

use crate::core::window::popup::PopupRegistry;
use log::warn;
use tauri::{AppHandle, Manager};

pub fn build_popup_window(
    app: &AppHandle,
    window_label: &str,
    title: &str,
    url: String,
    width: f64,
    height: f64,
    x: f64,
    y: f64,
) -> Result<tauri::WebviewWindow, String> {
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

    builder.build().map_err(|e| e.to_string())
}

pub async fn preload_popup_windows(app: AppHandle, registry: &PopupRegistry) -> Result<(), String> {
    let configs = registry.get_all();

    if configs.is_empty() {
        return Ok(());
    }

    tauri::async_runtime::spawn(async move {
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
    });

    Ok(())
}

pub async fn show_popup_window(
    app: AppHandle,
    registry: &PopupRegistry,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    popup_type: String,
) -> Result<(), String> {
    if !registry.has(&popup_type) {
        return Err(format!("Popup type '{}' not registered", popup_type));
    }

    let window_label = format!("popup-{}", popup_type);

    if let Some(popup) = app.get_webview_window(&window_label) {
        popup
            .set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))
            .map_err(|e| e.to_string())?;
        popup
            .set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }))
            .map_err(|e| e.to_string())?;

        let _ = popup.set_focusable(false);
    } else {
        let url = format!("/popup?type={}", popup_type);
        let _popup =
            build_popup_window(&app, &window_label, &popup_type, url, width, height, x, y)?;
    }

    Ok(())
}

pub fn hide_popup_window(app: AppHandle) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with("popup-") {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub fn is_popup_visible(app: AppHandle) -> Result<bool, String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with("popup-") && window.is_visible().unwrap_or(false) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn is_popup_focused(app: AppHandle) -> Result<bool, String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with("popup-") {
            let is_visible = window.is_visible().unwrap_or(false);
            let is_focused = window.is_focused().unwrap_or(false);
            if is_visible && is_focused {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

pub fn is_app_focused(app: AppHandle) -> Result<bool, String> {
    if let Some(main_window) = app.get_webview_window("main") {
        if main_window.is_focused().unwrap_or(false) {
            return Ok(true);
        }
    }

    for (label, window) in app.webview_windows() {
        if label.starts_with("popup-") {
            let is_visible = window.is_visible().unwrap_or(false);
            let is_focused = window.is_focused().unwrap_or(false);
            if is_visible && is_focused {
                return Ok(true);
            }
        }
    }

    Ok(false)
}
