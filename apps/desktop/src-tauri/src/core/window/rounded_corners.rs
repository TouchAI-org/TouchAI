// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Native rounded corner styling for desktop windows.

use tauri::{Runtime, WebviewWindow};

/// Apply the platform window corner style.
pub fn apply_window_corner_style<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    apply_window_corner_style_impl(window)
}

/// Re-apply the platform corner style after a viewport or visibility change.
pub fn sync_window_corner_style<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    sync_window_corner_style_impl(window)
}

#[cfg(target_os = "windows")]
mod win {
    use raw_window_handle::HasWindowHandle;
    use tauri::{Runtime, WebviewWindow};
    use windows::Win32::{
        Foundation::HWND,
        Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
        },
    };

    const DWMWCP_ROUND: u32 = 2;
    const DWM_BORDER_COLOR_GRAY_300: u32 = 0x00DBD5D1;

    fn should_manage_window(window: &WebviewWindow<impl Runtime>) -> bool {
        matches!(window.label(), "main" | "settings")
    }

    /// Get the Win32 HWND for a Tauri webview window.
    fn window_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, String> {
        let window_handle = window
            .window_handle()
            .map_err(|e| format!("Failed to get window handle: {}", e))?;

        match window_handle.as_ref() {
            raw_window_handle::RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as _)),
            _ => Err("Not a Win32 window".to_string()),
        }
    }

    fn set_dwm_corner_preference(hwnd: HWND) -> Result<(), String> {
        unsafe {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &DWMWCP_ROUND as *const _ as *const _,
                std::mem::size_of::<u32>() as u32,
            )
            .map_err(|error| format!("Failed to set DWM rounded corners: {}", error))?;

            DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &DWM_BORDER_COLOR_GRAY_300 as *const _ as *const _,
                std::mem::size_of::<u32>() as u32,
            )
            .map_err(|error| format!("Failed to set DWM border color: {}", error))?;
        }

        Ok(())
    }

    pub fn apply_window_corner_style<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
        if !should_manage_window(window) {
            return Ok(());
        }

        let hwnd = window_hwnd(window)?;
        set_dwm_corner_preference(hwnd)
    }

    pub fn sync_window_corner_style<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
        apply_window_corner_style(window)
    }
}

#[cfg(target_os = "windows")]
fn apply_window_corner_style_impl<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    win::apply_window_corner_style(window)
}

#[cfg(not(target_os = "windows"))]
fn apply_window_corner_style_impl<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_window_corner_style_impl<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    win::sync_window_corner_style(window)
}

#[cfg(not(target_os = "windows"))]
fn sync_window_corner_style_impl<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}
