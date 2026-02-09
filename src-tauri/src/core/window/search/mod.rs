// Copyright (c) 2025. 千诚. Licensed under GPL v3.

//! 主窗口管理逻辑。

use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use raw_window_handle::HasWindowHandle;
#[cfg(target_os = "windows")]
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
};

pub fn hide_search_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Failed to get main window")?;

    window.hide().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn toggle_search_window_visibility(app_handle: &AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        if window.is_visible().map_err(|e| e.to_string())? {
            window.hide().map_err(|e| e.to_string())?;
        } else {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[cfg(target_os = "windows")]
const DWMWCP_ROUND: u32 = 2;
#[cfg(target_os = "windows")]
const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;

#[cfg(target_os = "windows")]
pub fn set_search_window_style(window: &tauri::WebviewWindow) -> Result<(), String> {
    let window_handle = window
        .window_handle()
        .map_err(|e| format!("Failed to get window handle: {}", e))?;

    let hwnd = match window_handle.as_ref() {
        raw_window_handle::RawWindowHandle::Win32(handle) => {
            windows::Win32::Foundation::HWND(handle.hwnd.get() as _)
        }
        _ => return Err("Not a Win32 window".to_string()),
    };

    unsafe {
        // 圆角
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &DWMWCP_ROUND as *const _ as *const _,
            std::mem::size_of::<u32>() as u32,
        )
        .map_err(|e| format!("Failed to set rounded corners: {}", e))?;

        // 边框
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            &DWMWA_COLOR_NONE as *const _ as *const _,
            std::mem::size_of::<u32>() as u32,
        )
        .map_err(|e| format!("Failed to remove border: {}", e))?;
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_search_window_style(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}
