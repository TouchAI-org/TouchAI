// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 设置窗口管理逻辑。

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub async fn build_settings_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(settings_window) = app.get_webview_window("settings") {
        settings_window.unminimize().map_err(|e| e.to_string())?;
        settings_window.show().map_err(|e| e.to_string())?;
        settings_window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("/settings".parse().unwrap()),
    )
    .title("TouchAI - 设置")
    .inner_size(1000.0, 700.0)
    .min_inner_size(1000.0, 700.0)
    .resizable(true)
    .decorations(false)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)?;

    Ok(())
}
