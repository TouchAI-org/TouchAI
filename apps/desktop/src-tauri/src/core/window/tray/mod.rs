// Copyright (c) 2026. 千诚. Licensed under GPL v3

//! 系统托盘模块。

use log::warn;
use std::sync::Mutex;
#[cfg(target_os = "linux")]
use tauri::menu::MenuBuilder;
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, PhysicalPosition, Runtime, WebviewUrl, WebviewWindowBuilder,
};

const TRAY_MENU_ROUTE: &str = "#/tray-menu";
const TRAY_ID: &str = "touchai-main";
const TRAY_TOOLTIP: &str = "TouchAI";
#[cfg(target_os = "linux")]
const TRAY_MENU_SHOW: &str = "show-main-window";
#[cfg(target_os = "linux")]
const TRAY_MENU_SETTINGS: &str = "open-settings";
#[cfg(target_os = "linux")]
const TRAY_MENU_QUIT: &str = "quit";

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrayStatusIndicator {
    Completed,
    Failed,
    WaitingApproval,
}

pub struct TrayStatusRuntime {
    status: Mutex<Option<TrayStatusIndicator>>,
}

impl TrayStatusRuntime {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(None),
        }
    }

    pub fn set_status(&self, status: Option<TrayStatusIndicator>) {
        *self.status.lock().expect("tray status runtime poisoned") = status;
    }

    pub fn status(&self) -> Option<TrayStatusIndicator> {
        *self.status.lock().expect("tray status runtime poisoned")
    }
}

impl Default for TrayStatusRuntime {
    fn default() -> Self {
        Self::new()
    }
}

struct TouchAiTray<R: Runtime> {
    _tray: tauri::tray::TrayIcon<R>,
}

pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let status = app
        .try_state::<TrayStatusRuntime>()
        .and_then(|runtime| runtime.status());
    let icon = load_tray_icon(status)?;

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
        .tooltip(TRAY_TOOLTIP)
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
        .tooltip(TRAY_TOOLTIP)
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Right,
                button_state: MouseButtonState::Up,
                position,
                ..
            } => {
                let app = tray.app_handle();
                if let Err(error) = show_tray_menu(app, position) {
                    warn!("Failed to show tray menu: {}", error);
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

pub fn set_tray_status_indicator<R: Runtime>(
    app: AppHandle<R>,
    status: TrayStatusIndicator,
) -> Result<(), String> {
    let runtime = app
        .try_state::<TrayStatusRuntime>()
        .ok_or_else(|| "Tray status runtime is not initialized".to_string())?;
    if runtime.status() == Some(status) {
        return Ok(());
    }
    runtime.set_status(Some(status));
    apply_tray_status(&app, Some(status))
}

pub fn clear_tray_status_indicator<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let runtime = app
        .try_state::<TrayStatusRuntime>()
        .ok_or_else(|| "Tray status runtime is not initialized".to_string())?;
    if runtime.status().is_none() {
        return Ok(());
    }
    runtime.set_status(None);
    apply_tray_status(&app, None)
}

pub fn close_tray_menu<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("tray-menu") {
        window.hide().map_err(|error| error.to_string())?;
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

fn tray_icon_bytes(status: Option<TrayStatusIndicator>) -> &'static [u8] {
    match status {
        Some(TrayStatusIndicator::Completed) => {
            include_bytes!("../../../../icons/32x32-tray-completed.png")
        }
        Some(TrayStatusIndicator::Failed) => {
            include_bytes!("../../../../icons/32x32-tray-failed.png")
        }
        Some(TrayStatusIndicator::WaitingApproval) => {
            include_bytes!("../../../../icons/32x32-tray-waiting_approval.png")
        }
        None => include_bytes!("../../../../icons/32x32.png"),
    }
}

fn load_tray_icon(
    status: Option<TrayStatusIndicator>,
) -> Result<Image<'static>, Box<dyn std::error::Error>> {
    let rgba = image::load_from_memory(tray_icon_bytes(status))?.to_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(Image::new_owned(rgba.into_raw(), width, height))
}

fn apply_tray_status<R: Runtime>(
    app: &AppHandle<R>,
    status: Option<TrayStatusIndicator>,
) -> Result<(), String> {
    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(tray) = app_handle.tray_by_id(TRAY_ID) else {
            return;
        };

        let icon = match load_tray_icon(status) {
            Ok(icon) => icon,
            Err(error) => {
                warn!("Failed to load tray icon with status indicator: {}", error);
                return;
            }
        };

        if let Err(error) = tray.set_icon(Some(icon)) {
            warn!("Failed to update tray icon status indicator: {}", error);
        }
    })
    .map_err(|error| error.to_string())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        warn!("Main window not found while showing from tray");
        return;
    };

    if let Err(error) = window.unminimize() {
        warn!("Failed to unminimize main window from tray: {}", error);
    }

    if let Err(error) = window.show() {
        warn!("Failed to show main window from tray: {}", error);
    }

    if let Err(error) = window.set_focus() {
        warn!("Failed to focus main window from tray: {}", error);
    }
}

fn show_tray_menu<R: Runtime>(
    app: &AppHandle<R>,
    click_position: PhysicalPosition<f64>,
) -> Result<(), Box<dyn std::error::Error>> {
    let menu_width = 140.0;
    let menu_height = 134.0;

    let window = match app.get_webview_window("tray-menu") {
        Some(window) => window,
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

#[cfg(test)]
mod tests {
    use super::{load_tray_icon, tray_icon_bytes, TrayStatusIndicator};

    #[test]
    fn tray_icon_bytes_switch_with_status() {
        let default_bytes = tray_icon_bytes(None);
        let completed_bytes = tray_icon_bytes(Some(TrayStatusIndicator::Completed));
        let failed_bytes = tray_icon_bytes(Some(TrayStatusIndicator::Failed));
        let waiting_bytes = tray_icon_bytes(Some(TrayStatusIndicator::WaitingApproval));

        assert_ne!(default_bytes, completed_bytes);
        assert_ne!(completed_bytes, failed_bytes);
        assert_ne!(failed_bytes, waiting_bytes);
    }

    #[test]
    fn load_tray_icon_decodes_all_status_icons() {
        for status in [
            None,
            Some(TrayStatusIndicator::Completed),
            Some(TrayStatusIndicator::Failed),
            Some(TrayStatusIndicator::WaitingApproval),
        ] {
            let icon = load_tray_icon(status).expect("status tray icon should decode");
            assert_eq!(icon.width(), 32);
            assert_eq!(icon.height(), 32);
        }
    }

    #[test]
    fn tray_icon_pngs_are_valid_images() {
        for status in [
            None,
            Some(TrayStatusIndicator::Completed),
            Some(TrayStatusIndicator::Failed),
            Some(TrayStatusIndicator::WaitingApproval),
        ] {
            let image = image::load_from_memory(tray_icon_bytes(status))
                .expect("status tray png should load");
            assert_eq!(image.width(), 32);
            assert_eq!(image.height(), 32);
        }
    }
}
