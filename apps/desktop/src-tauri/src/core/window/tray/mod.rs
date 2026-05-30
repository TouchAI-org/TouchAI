// Copyright (c) 2026. 千诚. Licensed under GPL v3

//! 系统托盘模块。

use log::warn;
#[cfg(target_os = "linux")]
use tauri::menu::MenuBuilder;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder,
};

const TRAY_MENU_ROUTE: &str = "#/tray-menu";
const TRAY_ID: &str = "touchai-main";
#[cfg(target_os = "linux")]
const TRAY_MENU_SHOW: &str = "show-main-window";
#[cfg(target_os = "linux")]
const TRAY_MENU_SETTINGS: &str = "open-settings";
#[cfg(target_os = "linux")]
const TRAY_MENU_QUIT: &str = "quit";

struct TouchAiTray<R: Runtime> {
    _tray: tauri::tray::TrayIcon<R>,
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let icon = load_tray_icon()?;

    let tray = build_tray_builder(app, icon)?.build(app)?;
    app.manage(TouchAiTray { _tray: tray });

    Ok(())
}

#[cfg(target_os = "linux")]
fn build_tray_builder<R: Runtime>(
    app: &AppHandle<R>,
    icon: Image<'static>,
) -> Result<TrayIconBuilder<R>, Box<dyn std::error::Error>> {
    let menu = MenuBuilder::new(app)
        .text(TRAY_MENU_SHOW, "显示窗口")
        .text(TRAY_MENU_SETTINGS, "设置")
        .separator()
        .text(TRAY_MENU_QUIT, "退出")
        .build()?;

    Ok(TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("TouchAI")
        .temp_dir_path(resolve_linux_tray_icon_dir(app)?)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW => show_main_window(app),
            TRAY_MENU_SETTINGS => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = crate::core::window::build_settings_window(&app).await {
                        warn!("Failed to open settings from tray menu: {}", error);
                    }
                });
            }
            TRAY_MENU_QUIT => app.exit(0),
            _ => {}
        }))
}

#[cfg(not(target_os = "linux"))]
fn build_tray_builder<R: Runtime>(
    _app: &AppHandle<R>,
    icon: Image<'static>,
) -> Result<TrayIconBuilder<R>, Box<dyn std::error::Error>> {
    Ok(TrayIconBuilder::with_id(TRAY_ID)
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
                show_main_window(app);
            }
            _ => {}
        }))
}

#[cfg(target_os = "linux")]
fn resolve_linux_tray_icon_dir<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    let icon_dir = app.path().app_cache_dir()?.join("tray-icons");
    std::fs::create_dir_all(&icon_dir)?;
    Ok(icon_dir)
}

pub fn close_tray_menu<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray-menu") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 预加载托盘菜单窗口（隐藏状态），加速首次右键响应
pub fn preload_tray_menu<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    if app.get_webview_window("tray-menu").is_some() {
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(
        app,
        "tray-menu",
        WebviewUrl::App(TRAY_MENU_ROUTE.parse().unwrap()),
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

    crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)
        .map_err(std::io::Error::other)?;

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

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Err(e) = crate::core::window::show_search_window(app.clone()) {
        warn!("Failed to show main window from tray icon: {}", e);
    }
}

fn show_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
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
