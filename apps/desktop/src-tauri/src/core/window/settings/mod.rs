// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 设置窗口管理逻辑。

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

pub const SETTINGS_WINDOW_WIDTH: f64 = 1120.0;
pub const SETTINGS_WINDOW_HEIGHT: f64 = 700.0;
pub const SETTINGS_WINDOW_MIN_WIDTH: f64 = 920.0;
pub const SETTINGS_WINDOW_MIN_HEIGHT: f64 = 560.0;
const SETTINGS_WINDOW_ROUTE: &str = "#/settings";

pub async fn build_settings_window<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if let Some(settings_window) = app.get_webview_window("settings") {
        settings_window.unminimize().map_err(|e| e.to_string())?;
        crate::core::window::rounded_corners::sync_window_rounded_region(&settings_window)?;
        settings_window.show().map_err(|e| e.to_string())?;
        crate::core::window::rounded_corners::sync_window_rounded_region(&settings_window)?;
        settings_window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App(SETTINGS_WINDOW_ROUTE.parse().unwrap()),
    )
    .title("TouchAI - 设置")
    .inner_size(SETTINGS_WINDOW_WIDTH, SETTINGS_WINDOW_HEIGHT)
    .min_inner_size(SETTINGS_WINDOW_MIN_WIDTH, SETTINGS_WINDOW_MIN_HEIGHT)
    .resizable(true)
    .decorations(false)
    .center()
    .build()
    .map_err(|e| e.to_string())?;

    crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)?;
    crate::core::window::rounded_corners::apply_window_corner_style(&window)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        SETTINGS_WINDOW_HEIGHT, SETTINGS_WINDOW_MIN_HEIGHT, SETTINGS_WINDOW_MIN_WIDTH,
        SETTINGS_WINDOW_ROUTE, SETTINGS_WINDOW_WIDTH,
    };

    #[test]
    fn settings_window_opens_with_room_for_the_system_settings_layout() {
        assert!((1100.0..=1140.0).contains(&SETTINGS_WINDOW_WIDTH));
        assert!((680.0..=720.0).contains(&SETTINGS_WINDOW_HEIGHT));
    }

    #[test]
    fn settings_window_min_size_allows_resizing_without_cramping_the_content() {
        assert!((900.0..=940.0).contains(&SETTINGS_WINDOW_MIN_WIDTH));
        assert!(SETTINGS_WINDOW_MIN_WIDTH < SETTINGS_WINDOW_WIDTH);
        assert!((544.0..=576.0).contains(&SETTINGS_WINDOW_MIN_HEIGHT));
        assert!(SETTINGS_WINDOW_MIN_HEIGHT < SETTINGS_WINDOW_HEIGHT);
    }

    #[test]
    fn settings_window_uses_hash_route_for_dev_and_packaged_builds() {
        assert_eq!(SETTINGS_WINDOW_ROUTE, "#/settings");
    }
}
