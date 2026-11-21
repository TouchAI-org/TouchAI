// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 透明窗口表面恢复
//!
//! Tao 在创建窗口时通过 `DwmEnableBlurBehindWindow` 加一个空的模糊区域来实现透明。
//! 这个状态不是窗口样式的一部分：休眠/唤醒、显示器开关、分辨率或 DPI 变化之后，
//! DWM 可能不再应用该状态，隐藏的搜索窗口再次显示时透明留白就会变成不透明的黑色。
//!
//! 这里做两件事：
//! - 显示搜索窗口之前无条件重新应用一次透明表面，保证用户看到的第一帧是正确的；
//! - 监听显示/电源/DPI 变化，在系统恢复后立即重建透明表面并通知 WebView2 重新合成，
//!   这样用户按下快捷键时渲染管线已经被提前唤醒。

use tauri::{Runtime, WebviewWindow};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

/// DWM 透明状态可能已经失效的系统事件。
///
/// 数值与 Win32 消息常量一致，这里独立定义以便在非 Windows 平台编译和测试。
const WM_DISPLAYCHANGE: u32 = 0x007E;
const WM_POWERBROADCAST: u32 = 0x0218;
const WM_DPICHANGED: u32 = 0x02E0;
const WM_DWMCOMPOSITIONCHANGED: u32 = 0x031E;
const WM_THEMECHANGED: u32 = 0x031A;

const PBT_APMRESUMECRITICAL: usize = 0x0006;
const PBT_APMRESUMESUSPEND: usize = 0x0007;
const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;

/// 需要同时重建 DWM 透明与 WebView2 背景的事件。
fn should_restore_transparency(message: u32, wparam: usize) -> bool {
    match message {
        WM_POWERBROADCAST => matches!(
            wparam,
            PBT_APMRESUMECRITICAL | PBT_APMRESUMESUSPEND | PBT_APMRESUMEAUTOMATIC
        ),
        WM_DISPLAYCHANGE | WM_DPICHANGED | WM_DWMCOMPOSITIONCHANGED | WM_THEMECHANGED => true,
        _ => false,
    }
}

/// 在搜索窗口显示前重建透明表面。
pub(crate) fn restore_transparent_surface<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let hwnd = window_hwnd(window)?;
        // SAFETY: `hwnd` 来自仍然存活的顶层窗口，调用均只作用于该窗口。
        let dwm = unsafe { restore_transparency_for_hwnd(hwnd) };
        // DWM 失败时仍尝试修复 WebView2 自身的背景色，两条路径互为兜底。
        let webview = window
            .with_webview(restore_webview_surface)
            .map_err(|error| format!("Failed to restore the search webview transparency: {error}"));
        dwm.and(webview)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(target_os = "windows")]
static INSTALLED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<isize>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
pub(crate) fn install(window: &WebviewWindow<tauri::Wry>) -> Result<(), String> {
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let hwnd = window_hwnd(window)?;
    let key = hwnd.0 as isize;
    let installed =
        INSTALLED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    {
        let mut installed = installed
            .lock()
            .map_err(|_| "Surface recovery registry is poisoned".to_string())?;
        if !installed.insert(key) {
            return Ok(());
        }
    }

    let data = Box::new(SurfaceRecoveryData {
        hwnd,
        window: window.clone(),
        pending: false,
    });
    let data_ptr = Box::into_raw(data);

    // SAFETY: 回调在窗口所属的 UI 线程执行；`data_ptr` 在 WM_NCDESTROY 时释放。
    let installed_ok = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(surface_recovery_subclass_proc),
            SURFACE_RECOVERY_SUBCLASS_ID,
            data_ptr as usize,
        )
    };
    if !installed_ok.as_bool() {
        // SAFETY: 安装失败时回调不会持有该指针，立即回收。
        unsafe { drop(Box::from_raw(data_ptr)) };
        if let Ok(mut installed) = installed.lock() {
            installed.remove(&key);
        }
        return Err("Failed to install the window surface recovery subclass".to_string());
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn install(_window: &WebviewWindow<tauri::Wry>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
const SURFACE_RECOVERY_SUBCLASS_ID: usize = 0x544F_5543;
#[cfg(target_os = "windows")]
const SURFACE_RECOVERY_TIMER_ID: usize = 0x544F_5544;
#[cfg(target_os = "windows")]
const SURFACE_RECOVERY_DELAY_MS: u32 = 100;

#[cfg(target_os = "windows")]
struct SurfaceRecoveryData {
    hwnd: windows::Win32::Foundation::HWND,
    window: WebviewWindow<tauri::Wry>,
    pending: bool,
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn surface_recovery_subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    message: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
    _subclass_id: usize,
    ref_data: usize,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass},
        WindowsAndMessaging::{KillTimer, SetTimer, WM_NCDESTROY, WM_TIMER},
    };

    if message == WM_NCDESTROY {
        // SAFETY: 先移除子类化，再释放回调数据。
        unsafe {
            let _ = RemoveWindowSubclass(
                hwnd,
                Some(surface_recovery_subclass_proc),
                SURFACE_RECOVERY_SUBCLASS_ID,
            );
            let _ = KillTimer(Some(hwnd), SURFACE_RECOVERY_TIMER_ID);
            if let Ok(mut installed) = INSTALLED.get_or_init(Default::default).lock() {
                installed.remove(&(hwnd.0 as isize));
            }
            drop(Box::from_raw(ref_data as *mut SurfaceRecoveryData));
        }
        return unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
    }

    let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };

    if message == WM_TIMER && wparam.0 == SURFACE_RECOVERY_TIMER_ID {
        // SAFETY: `ref_data` 在 WM_NCDESTROY 前一直有效；先取出需要的数据，
        // 避免在可能重入的 Win32 调用期间持有 `&mut`。
        let (pending, hwnd, window) = unsafe {
            let data = &*((ref_data) as *const SurfaceRecoveryData);
            (data.pending, data.hwnd, data.window.clone())
        };
        // SAFETY: 同上。先清除标志，重入的事件会重新置位并重设定时器。
        unsafe {
            let data = &mut *((ref_data) as *mut SurfaceRecoveryData);
            data.pending = false;
            let _ = KillTimer(Some(hwnd), SURFACE_RECOVERY_TIMER_ID);
        }
        if pending {
            if let Err(error) = unsafe { restore_transparency_for_hwnd(hwnd) } {
                log::warn!("Failed to restore window transparency after a system change: {error}");
            }
            // WebView2 维护自己的默认背景色，主题或 DWM 合成变化一样会把它重置成
            // 不透明，所以每次恢复都要连 WebView2 一起重建，不能只跟显示器/唤醒事件走。
            let _ = window.with_webview(restore_webview_surface);
        }
        return result;
    }

    if should_restore_transparency(message, wparam.0) {
        // SAFETY: 同上；只做短小的标志写入。
        unsafe {
            let data = &mut *((ref_data) as *mut SurfaceRecoveryData);
            data.pending = true;
            // 连续事件（显示器切换会连发多条消息）合并成一次恢复。
            // 同一 ID 的 SetTimer 会重置到期时间。
            let _ = SetTimer(
                Some(hwnd),
                SURFACE_RECOVERY_TIMER_ID,
                SURFACE_RECOVERY_DELAY_MS,
                None,
            );
        }
    }

    result
}

#[cfg(target_os = "windows")]
fn window_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window
        .window_handle()
        .map_err(|error| format!("Failed to get window handle: {error}"))?;

    match handle.as_ref() {
        RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as _)),
        _ => Err("Not a Win32 window".to_string()),
    }
}

/// 同时修复 DWM 之外的另一种透明丢失：WebView2 的默认背景色被恢复成不透明。
#[cfg(target_os = "windows")]
fn restore_webview_surface(webview: tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
    };
    use windows_core::Interface;

    let controller = webview.controller();
    // SAFETY: controller 属于仍然存活的 WebView2。
    unsafe {
        let _ = controller.SetIsVisible(true);
        let _ = controller.NotifyParentWindowPositionChanged();
        if let Ok(controller2) = controller.cast::<ICoreWebView2Controller2>() {
            let _ = controller2.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 0,
                R: 0,
                G: 0,
                B: 0,
            });
        }
    }
}

#[cfg(target_os = "windows")]
unsafe fn restore_transparency_for_hwnd(
    hwnd: windows::Win32::Foundation::HWND,
) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{FALSE, TRUE},
        Graphics::{
            Dwm::{DwmEnableBlurBehindWindow, DWM_BB_BLURREGION, DWM_BB_ENABLE, DWM_BLURBEHIND},
            Gdi::{
                CreateRectRgn, DeleteObject, InvalidateRect, RedrawWindow, RDW_ALLCHILDREN,
                RDW_INVALIDATE, RDW_UPDATENOW,
            },
        },
        UI::WindowsAndMessaging::{
            SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
        },
    };

    // Tao 用“空模糊区域”表达完全透明，这里复刻同样的状态。
    let region = unsafe { CreateRectRgn(0, 0, -1, -1) };
    if region.is_invalid() {
        return Err("Failed to create the transparent blur region".to_string());
    }

    let blur = DWM_BLURBEHIND {
        dwFlags: DWM_BB_ENABLE | DWM_BB_BLURREGION,
        fEnable: TRUE,
        hRgnBlur: region,
        fTransitionOnMaximized: FALSE,
    };

    let blur_result = unsafe { DwmEnableBlurBehindWindow(hwnd, &blur) };
    let _ = unsafe { DeleteObject(region.into()) };
    blur_result.map_err(|error| format!("Failed to re-enable DWM blur behind: {error}"))?;

    // 让 DWM 重新计算窗口框架，再强制绘制一次以丢弃缓存的黑色帧。
    unsafe {
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        let _ = InvalidateRect(Some(hwnd), None, true);
        let _ = RedrawWindow(
            Some(hwnd),
            None,
            None,
            RDW_INVALIDATE | RDW_ALLCHILDREN | RDW_UPDATENOW,
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // The transparent gutter is the only thing that makes the floating search card look
    // detached from the desktop. Losing DWM's blur-behind turns it into a black rectangle.

    #[test]
    fn user_sees_a_transparent_gutter_again_after_the_display_wakes_up() {
        assert!(should_restore_transparency(WM_DISPLAYCHANGE, 0));
        assert!(should_restore_transparency(WM_DPICHANGED, 0));
        assert!(should_restore_transparency(WM_DWMCOMPOSITIONCHANGED, 0));
        assert!(should_restore_transparency(WM_THEMECHANGED, 0));
        assert!(should_restore_transparency(
            WM_POWERBROADCAST,
            PBT_APMRESUMEAUTOMATIC
        ));
        assert!(should_restore_transparency(
            WM_POWERBROADCAST,
            PBT_APMRESUMESUSPEND
        ));
    }

    #[test]
    fn user_does_not_repair_the_surface_for_unrelated_window_messages() {
        const WM_TIMER: u32 = 0x0113;
        const PBT_APMSUSPEND: usize = 0x0004;

        assert!(!should_restore_transparency(WM_TIMER, 0));
        assert!(!should_restore_transparency(
            WM_POWERBROADCAST,
            PBT_APMSUSPEND
        ));
    }

    #[test]
    fn user_does_not_keep_an_opaque_webview_after_a_theme_change() {
        // 主题与 DWM 合成变化同样会重置 WebView2 的默认背景色，因此恢复动作不能
        // 只跟随唤醒显示器的事件，否则这两类事件之后仍然会露出黑色 gutter。
        assert!(should_restore_transparency(WM_THEMECHANGED, 0));
        assert!(should_restore_transparency(WM_DWMCOMPOSITIONCHANGED, 0));
    }
}
