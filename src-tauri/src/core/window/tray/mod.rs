// Copyright (c) 2025. 千诚. Licensed under GPL v3

//! 系统托盘模块。

use log::warn;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};

pub fn create_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let icon = load_tray_icon()?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("TouchAI")
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => {
                let app = tray.app_handle();
                if let Err(e) = show_tray_menu(app, position) {
                    warn!("Failed to show tray menu: {}", e);
                }
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

pub fn close_tray_menu(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray-menu") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 预加载托盘菜单窗口（隐藏状态），加速首次右键响应
pub fn preload_tray_menu(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window("tray-menu").is_some() {
        return Ok(());
    }

    let _window = WebviewWindowBuilder::new(
        app,
        "tray-menu",
        WebviewUrl::App("/tray-menu".parse().unwrap()),
    )
    .inner_size(140.0, 134.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .focused(false)
    .build()?;

    Ok(())
}

fn load_tray_icon() -> Result<Image<'static>, Box<dyn std::error::Error>> {
    let icon_bytes = include_bytes!("../../../../icons/32x32.png");

    let image = image::load_from_memory(icon_bytes)?;
    let rgba = image.to_rgba8();
    let (width, height) = rgba.dimensions();

    let icon = Image::new_owned(rgba.into_raw(), width, height);
    Ok(icon)
}

fn show_tray_menu(
    app: &AppHandle,
    click_position: PhysicalPosition<f64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let menu_width = 140.0;
    let menu_height = 134.0;

    // 确保窗口存在（预加载或首次创建）
    let window = match app.get_webview_window("tray-menu") {
        Some(w) => w,
        None => {
            preload_tray_menu(app)?;
            app.get_webview_window("tray-menu")
                .ok_or("Failed to create tray-menu window")?
        }
    };

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let logical_x = click_position.x / scale_factor;
    let logical_y = click_position.y / scale_factor;

    let (x, y) = if let Ok(Some(monitor)) = window.current_monitor() {
        let screen_size = monitor.size();
        let logical_screen_width = screen_size.width as f64 / scale_factor;
        let logical_screen_height = screen_size.height as f64 / scale_factor;

        let x = (logical_x - menu_width)
            .max(10.0)
            .min(logical_screen_width - menu_width - 10.0);
        let y = (logical_y - menu_height)
            .max(10.0)
            .min(logical_screen_height - menu_height - 10.0);

        (x, y)
    } else {
        let x = (logical_x - menu_width).max(10.0);
        let y = (logical_y - menu_height).max(10.0);
        (x, y)
    };

    window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }))?;
    window.show()?;
    window.set_focus()?;

    Ok(())
}
