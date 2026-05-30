// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 主窗口管理逻辑。

pub mod bounds;
pub mod surface;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

#[cfg(target_os = "windows")]
use raw_window_handle::HasWindowHandle;
#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    UI::{
        Input::KeyboardAndMouse::SetFocus,
        WindowsAndMessaging::{GetWindow, GW_CHILD},
    },
};

/// 隐藏主搜索窗口。
pub fn hide_search_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    surface::hide_surface(&app, surface::SearchSurfaceHideReason::ManualDismiss)
}

/// 显示主搜索窗口并广播搜索窗口组已显示事件。
pub fn show_search_window<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    surface::show_surface(&app, surface::SearchSurfaceShowSource::Notification)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShortcutToggleAction {
    ShowWithAutoPasteAuthorization,
    FocusExistingVisible,
    HideOnly,
}

/// 根据窗口可见性和应用焦点决定快捷键切换动作。
pub fn resolve_shortcut_toggle_action(
    is_visible: bool,
    is_app_focused: bool,
) -> ShortcutToggleAction {
    match (is_visible, is_app_focused) {
        (false, _) => ShortcutToggleAction::ShowWithAutoPasteAuthorization,
        (true, true) => ShortcutToggleAction::HideOnly,
        (true, false) => ShortcutToggleAction::FocusExistingVisible,
    }
}

/// 判断快捷键动作是否需要把主窗口提升为系统前台窗口。
fn shortcut_action_requires_foreground_activation(action: ShortcutToggleAction) -> bool {
    matches!(
        action,
        ShortcutToggleAction::ShowWithAutoPasteAuthorization
            | ShortcutToggleAction::FocusExistingVisible
    )
}

/// 处理全局快捷键触发的搜索窗口显隐切换。
pub fn show_search_window_from_shortcut<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let is_visible = window.is_visible().map_err(|e| e.to_string())?;
    let is_app_focused = crate::core::window::popup::is_app_focused(app_handle.clone())?;
    let action = resolve_shortcut_toggle_action(is_visible, is_app_focused);

    if let ShortcutToggleAction::ShowWithAutoPasteAuthorization = action {
        if let Some(runtime) =
            app_handle.try_state::<crate::core::system::clipboard::ClipboardRuntime>()
        {
            runtime.authorize_shortcut_auto_paste();
        }
    }

    if shortcut_action_requires_foreground_activation(action) {
        surface::show_surface(app_handle, surface::SearchSurfaceShowSource::Shortcut)?;
    } else {
        surface::hide_surface(
            app_handle,
            surface::SearchSurfaceHideReason::PolicyToggleHide,
        )?;
    }
    Ok(())
}

/// 设置应用失焦时是否由原生层自动隐藏搜索窗口组。
pub fn set_search_surface_hide_on_app_blur<R: Runtime>(
    app_handle: AppHandle<R>,
    should_hide: bool,
) -> Result<(), String> {
    surface::set_hide_on_app_blur(&app_handle, should_hide)
}

/// 仅用于测试模式：显示主搜索窗口并立即激活其输入焦点。
pub fn show_search_window_for_testing<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    show_and_activate_search_window(window)
}

/// 显示搜索窗口，并确保它成为后续键盘输入的目标窗口。
pub(super) fn show_and_activate_search_window<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let _ = window.unminimize();
    crate::core::window::rounded_corners::sync_window_rounded_region(window)?;
    window.show().map_err(|e| e.to_string())?;
    crate::core::window::rounded_corners::sync_window_rounded_region(window)?;
    reactivate_search_window_input(window)
}

/// 让主搜索窗口重新成为键盘输入目标，并唤醒 WebView2 accelerator 管线。
pub(super) fn reactivate_search_window_input<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    window.set_focus().map_err(|e| e.to_string())?;
    focus_search_webview_content(window)?;
    prime_webview_input_pipeline();
    Ok(())
}

/// Workaround: WebView2 (Chromium) 在宿主窗口 hide→show 后，其内部输入管线
/// 处于休眠状态——普通字符键可以到达 DOM，但 Ctrl+字母等组合键（accelerator）
/// 既不触发 AcceleratorKeyPressed 事件，也不分发到 DOM keydown。
///
/// 根因是 Chromium 渲染进程在窗口不可见期间暂停了加速键处理，恢复可见后
/// 需要收到至少一个真实的键盘输入事件才会重新激活该管线。
/// SetIsVisible(true)、MoveFocus、NotifyParentWindowPositionChanged、WM_ACTIVATE
/// 等 API 均无法可靠唤醒此状态。
///
/// 此处通过 SendInput 注入一对无害的 Shift 按下/释放事件，模拟"用户首次交互"
/// 来强制唤醒 Chromium 输入处理。Shift 单独按下不会产生字符输入或触发快捷键。
///
/// 相关 issue:
/// - https://github.com/tauri-apps/tauri/issues/5464
/// - https://github.com/tauri-apps/wry/issues/616
/// - https://github.com/tauri-apps/tauri/issues/3654
#[cfg(target_os = "windows")]
fn prime_webview_input_pipeline() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_SHIFT,
    };

    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_SHIFT,
                    wScan: 0,
                    dwFlags: Default::default(),
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_SHIFT,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];

    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(target_os = "windows"))]
fn prime_webview_input_pipeline() {}

#[cfg(target_os = "windows")]
/// 将键盘焦点推进 WebView2 内容层，确保页面可以收到后续 keydown。
pub(super) fn focus_search_webview_content<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let main_hwnd = get_window_hwnd(window)?;
    let main_hwnd_raw = main_hwnd.0 as isize;
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .with_webview(move |webview| {
            let result = (|| unsafe {
                let main_hwnd = HWND(main_hwnd_raw as _);
                let container_hwnd = GetWindow(main_hwnd, GW_CHILD).unwrap_or_default();
                let content_hwnd = if container_hwnd.0.is_null() {
                    HWND::default()
                } else {
                    GetWindow(container_hwnd, GW_CHILD).unwrap_or_default()
                };
                let focus_target = select_search_webview_focus_hwnd(container_hwnd, content_hwnd);
                let _ = SetFocus(focus_target);
                let _ = webview.controller().SetIsVisible(true);
                webview
                    .controller()
                    .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                    .map_err(|error| {
                        format!("Failed to focus search WebView2 content: {}", error)
                    })?;
                Ok(())
            })();
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Failed to access search WebView2 content: {}", error))?;

    rx.recv().map_err(|error| {
        format!(
            "Failed to receive search WebView2 content focus result: {}",
            error
        )
    })?
}

#[cfg(target_os = "windows")]
/// 选择搜索 WebView 的实际键盘焦点目标。
fn select_search_webview_focus_hwnd(parent_hwnd: HWND, child_hwnd: HWND) -> HWND {
    if !parent_hwnd.0.is_null() {
        parent_hwnd
    } else if !child_hwnd.0.is_null() {
        child_hwnd
    } else {
        HWND::default()
    }
}

#[cfg(not(target_os = "windows"))]
/// 非 Windows 平台无需额外推进 WebView 内容焦点。
pub(super) fn focus_search_webview_content<R: Runtime>(
    _window: &WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
/// 获取 Tauri WebviewWindow 对应的 Win32 HWND。
fn get_window_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, String> {
    let window_handle = window
        .window_handle()
        .map_err(|e| format!("Failed to get window handle: {}", e))?;

    match window_handle.as_ref() {
        raw_window_handle::RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as _)),
        _ => Err("Not a Win32 window".to_string()),
    }
}
