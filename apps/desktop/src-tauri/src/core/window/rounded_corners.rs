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
            DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
            DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
        },
        Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn, HGDIOBJ, HRGN},
        UI::WindowsAndMessaging::GetClientRect,
    };

    const FALLBACK_CORNER_RADIUS_PX: i32 = 12;

    fn should_manage_window(window: &WebviewWindow<impl Runtime>) -> bool {
        window.label() == "settings"
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
            // CSS owns the inset card's corners and shadow. Native rounding adds a
            // second shadow around the entire HWND, including its transparent gutter.
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                &DWMWCP_DONOTROUND as *const _ as *const _,
                std::mem::size_of_val(&DWMWCP_DONOTROUND) as u32,
            )
            .map_err(|error| format!("Failed to disable native window rounding: {}", error))?;

            DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &DWMWA_COLOR_NONE as *const _ as *const _,
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
                    windows::core::Error::from_thread()
                ));
            }

            if SetWindowRgn(hwnd, Some(region), true) == 0 {
                let error = windows::core::Error::from_thread();
                let _ = DeleteObject(HGDIOBJ(region.0));
                return Err(format!("Failed to apply rounded window region: {}", error));
            }
        }

        Ok(())
    }

    fn clear_window_region(hwnd: HWND) -> Result<(), String> {
        let no_region = HRGN(std::ptr::null_mut());

        unsafe {
            if SetWindowRgn(hwnd, Some(no_region), true) == 0 {
                return Err(format!(
                    "Failed to clear rounded window region: {}",
                    windows::core::Error::from_thread()
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

    #[cfg(test)]
    mod tests {
        use super::set_dwm_corner_preference;
        use windows::{
            core::w,
            Win32::{
                Foundation::{E_INVALIDARG, HWND},
                Graphics::Dwm::{
                    DwmGetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DEFAULT,
                    DWMWCP_DONOTROUND,
                },
                UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WS_POPUP},
            },
        };

        struct TestWindow(HWND);

        impl Drop for TestWindow {
            fn drop(&mut self) {
                unsafe {
                    let _ = DestroyWindow(self.0);
                }
            }
        }

        #[test]
        fn user_opens_settings_without_native_rounded_chrome_around_the_transparent_gutter() {
            let window = TestWindow(unsafe {
                CreateWindowExW(
                    Default::default(),
                    w!("STATIC"),
                    w!("TouchAI settings chrome test"),
                    WS_POPUP,
                    0,
                    0,
                    800,
                    600,
                    None,
                    None,
                    None,
                    None,
                )
                .expect("Create a borderless test window")
            });
            let mut preference = DWMWCP_DEFAULT;
            let read_preference = |value: &mut _| unsafe {
                DwmGetWindowAttribute(
                    window.0,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    value as *mut _ as *mut _,
                    std::mem::size_of_val(value) as u32,
                )
            };
            if let Err(error) = read_preference(&mut preference) {
                assert_eq!(error.code(), E_INVALIDARG);
                // Windows 10 has no native rounded-window chrome to suppress.
                return;
            }

            set_dwm_corner_preference(window.0).expect("Apply settings window chrome");
            read_preference(&mut preference).expect("Read the resulting native window chrome");
            assert_eq!(preference, DWMWCP_DONOTROUND);
        }
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
