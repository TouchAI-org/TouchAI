// Copyright (c) 2026. 鍗冭瘹. Licensed under GPL v3.

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
        Foundation::{HWND, RECT},
        Graphics::Dwm::{
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE,
        },
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn, HRGN},
        UI::WindowsAndMessaging::GetClientRect,
    };

    const DWMWCP_ROUND: u32 = 2;
    const DWM_BORDER_COLOR_GRAY_300: u32 = 0x00DBD5D1;
    const FALLBACK_CORNER_RADIUS_PX: i32 = 12;

    fn should_manage_window(window: &WebviewWindow<impl Runtime>) -> bool {
        matches!(window.label(), "main" | "settings")
    }

    pub(super) fn fallback_region_dimensions(
        width: i32,
        height: i32,
    ) -> Option<(i32, i32, i32, i32)> {
        if width <= 0 || height <= 0 {
            return None;
        }

        let corner_diameter = FALLBACK_CORNER_RADIUS_PX * 2;
        Some((width + 1, height + 1, corner_diameter, corner_diameter))
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

    fn set_window_region_rounded_corners(hwnd: HWND) -> Result<(), String> {
        unsafe {
            let mut rect = RECT::default();
            GetClientRect(hwnd, &mut rect)
                .map_err(|error| format!("Failed to read window client rect: {}", error))?;

            let width = rect.right - rect.left;
            let height = rect.bottom - rect.top;
            let Some((right, bottom, ellipse_width, ellipse_height)) =
                fallback_region_dimensions(width, height)
            else {
                return Ok(());
            };

            let region = CreateRoundRectRgn(0, 0, right, bottom, ellipse_width, ellipse_height);
            if region.is_invalid() {
                return Err(format!(
                    "Failed to create rounded window region: {}",
                    windows::core::Error::from_win32()
                ));
            }

            if SetWindowRgn(hwnd, region, true) == 0 {
                let _ = DeleteObject(region);
                return Err(format!(
                    "Failed to apply rounded window region: {}",
                    windows::core::Error::from_win32()
                ));
            }
        }

        Ok(())
    }

    fn clear_window_region(hwnd: HWND) -> Result<(), String> {
        let no_region = HRGN(std::ptr::null_mut());

        unsafe {
            if SetWindowRgn(hwnd, no_region, true) == 0 {
                return Err(format!(
                    "Failed to clear rounded window region: {}",
                    windows::core::Error::from_win32()
                ));
            }
        }

        Ok(())
    }

    pub fn apply_window_corner_style<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
        if !should_manage_window(window) {
            return Ok(());
        }

        let hwnd = window_hwnd(window)?;
        match set_dwm_corner_preference(hwnd) {
            Ok(()) => clear_window_region(hwnd),
            Err(_) => set_window_region_rounded_corners(hwnd),
        }
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

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::win::fallback_region_dimensions;

    #[test]
    fn fallback_region_covers_window_with_rounded_corner_diameter() {
        assert_eq!(fallback_region_dimensions(750, 60), Some((751, 61, 24, 24)));
    }

    #[test]
    fn fallback_region_ignores_empty_window_sizes() {
        assert_eq!(fallback_region_dimensions(0, 60), None);
        assert_eq!(fallback_region_dimensions(750, 0), None);
    }
}
