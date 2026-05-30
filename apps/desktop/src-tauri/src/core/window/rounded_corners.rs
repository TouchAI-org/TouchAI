// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Native rounded clipping for desktop windows.

use tauri::{Runtime, WebviewWindow};

/// Logical corner radius shared by the native clip and the outer CSS shell.
const WINDOW_CORNER_RADIUS_LOGICAL: f64 = 8.0;

/// Apply the platform window corner style.
pub fn apply_window_corner_style<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    apply_window_corner_style_impl(window)
}

/// Recompute the native clipping region after a viewport change.
pub fn sync_window_rounded_region<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    sync_window_rounded_region_impl(window)
}

#[cfg(target_os = "windows")]
mod win {
    use raw_window_handle::HasWindowHandle;
    use tauri::{Runtime, WebviewWindow};
    use windows::Win32::{
        Foundation::{BOOL, HWND},
        Graphics::{
            Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE},
            Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn, HRGN},
        },
    };

    use super::WINDOW_CORNER_RADIUS_LOGICAL;

    const DWMWCP_ROUND: u32 = 2;
    const DWMWA_COLOR_NONE: u32 = 0xFFFFFFFE;

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
                &DWMWA_COLOR_NONE as *const _ as *const _,
                std::mem::size_of::<u32>() as u32,
            )
            .map_err(|error| format!("Failed to remove DWM border color: {}", error))?;
        }

        Ok(())
    }

    fn reset_window_region(hwnd: HWND) -> Result<(), String> {
        let result = unsafe { SetWindowRgn(hwnd, HRGN::default(), BOOL(1)) };
        if result == 0 {
            return Err("Failed to reset native rounded window region".to_string());
        }

        Ok(())
    }

    fn apply_rounded_region<R: Runtime>(
        window: &WebviewWindow<R>,
        hwnd: HWND,
    ) -> Result<(), String> {
        let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
        let physical_size = window.outer_size().map_err(|error| error.to_string())?;
        let width = i32::try_from(physical_size.width)
            .map_err(|_| "Window width exceeds Win32 region range".to_string())?;
        let height = i32::try_from(physical_size.height)
            .map_err(|_| "Window height exceeds Win32 region range".to_string())?;
        let corner_diameter = ((WINDOW_CORNER_RADIUS_LOGICAL * scale_factor).round() as i32)
            .saturating_mul(2)
            .max(1);

        let region = unsafe {
            CreateRoundRectRgn(
                0,
                0,
                width + 1,
                height + 1,
                corner_diameter,
                corner_diameter,
            )
        };
        if region.0.is_null() {
            return Err("Failed to create native rounded window region".to_string());
        }

        let result = unsafe { SetWindowRgn(hwnd, region, BOOL(1)) };
        if result == 0 {
            unsafe {
                let _ = DeleteObject(region);
            }
            return Err("Failed to apply native rounded window region".to_string());
        }

        Ok(())
    }

    pub fn apply_window_corner_style<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
        if !should_manage_window(window) {
            return Ok(());
        }

        let hwnd = window_hwnd(window)?;
        set_dwm_corner_preference(hwnd)?;
        sync_window_rounded_region(window)
    }

    pub fn sync_window_rounded_region<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
        if !should_manage_window(window) {
            return Ok(());
        }

        let hwnd = window_hwnd(window)?;
        if window.is_maximized().map_err(|error| error.to_string())? {
            reset_window_region(hwnd)?;
            return Ok(());
        }

        apply_rounded_region(window, hwnd)
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
fn sync_window_rounded_region_impl<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    win::sync_window_rounded_region(window)
}

#[cfg(not(target_os = "windows"))]
fn sync_window_rounded_region_impl<R: Runtime>(_window: &WebviewWindow<R>) -> Result<(), String> {
    Ok(())
}
