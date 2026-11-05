// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 主窗口管理逻辑。

pub mod bounds;
pub mod protocol;
pub mod surface;

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

#[cfg(target_os = "windows")]
use raw_window_handle::HasWindowHandle;
#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
#[cfg(target_os = "windows")]
use windows::Win32::{
    Foundation::HWND,
    System::Threading::{AttachThreadInput, GetCurrentThreadId},
    UI::{
        Input::KeyboardAndMouse::{SetActiveWindow, SetFocus},
        WindowsAndMessaging::{
            BringWindowToTop, GetForegroundWindow, GetWindow, GetWindowThreadProcessId,
            SetForegroundWindow, GW_CHILD,
        },
    },
};

/// 隐藏主搜索窗口。
pub fn hide_search_window_on_main_thread<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    surface::hide_surface_on_main_thread(app, surface::SearchSurfaceHideReason::ManualDismiss)
}

/// 显示主搜索窗口并广播搜索窗口组已显示事件。
pub fn show_search_window_on_main_thread<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    surface::show_surface_on_main_thread(app, surface::SearchSurfaceShowSource::Notification)
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
pub fn show_search_window_from_shortcut_on_main_thread<R: Runtime>(
    app_handle: &AppHandle<R>,
) -> Result<(), String> {
    let window = app_handle
        .get_webview_window("main")
        .ok_or_else(|| "Failed to get main window".to_string())?;
    let is_visible = window.is_visible().map_err(|e| e.to_string())?;
    let is_app_focused = window.is_focused().map_err(|error| error.to_string())?;
    let action = app_handle
        .try_state::<surface::SearchWindowRuntime>()
        .map(
            |runtime| match runtime.resolve_shortcut_action(is_visible, is_app_focused) {
                protocol::SearchShortcutAction::Show => {
                    ShortcutToggleAction::ShowWithAutoPasteAuthorization
                }
                protocol::SearchShortcutAction::FocusVisible => {
                    ShortcutToggleAction::FocusExistingVisible
                }
                protocol::SearchShortcutAction::Hide => ShortcutToggleAction::HideOnly,
            },
        )
        .unwrap_or_else(|| resolve_shortcut_toggle_action(is_visible, is_app_focused));

    if let ShortcutToggleAction::ShowWithAutoPasteAuthorization = action {
        if let Some(runtime) =
            app_handle.try_state::<crate::core::system::clipboard::ClipboardRuntime>()
        {
            runtime.authorize_shortcut_auto_paste();
        }
    }

    if shortcut_action_requires_foreground_activation(action) {
        surface::show_surface_on_main_thread(
            app_handle,
            surface::SearchSurfaceShowSource::Shortcut,
        )?;
    } else {
        surface::hide_surface_on_main_thread(
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

/// 测试模式在 renderer 就绪前只登记首次显示请求。
pub fn show_search_window_for_testing_on_main_thread<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<(), String> {
    surface::show_surface_on_main_thread(app, surface::SearchSurfaceShowSource::Notification)
}

/// 显示搜索窗口，并确保它成为后续键盘输入的目标窗口。
pub(super) fn show_and_activate_search_window<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let _ = window.unminimize();
    crate::core::window::rounded_corners::sync_window_corner_style(window)?;
    #[cfg(target_os = "windows")]
    show_search_window_without_animation(window)?;
    #[cfg(not(target_os = "windows"))]
    window.show().map_err(|e| e.to_string())?;
    crate::core::window::rounded_corners::sync_window_corner_style(window)?;
    reactivate_search_window_input(window)
}

/// Hide the prepared host with Win32 directly so Windows does not animate the
/// transparent search surface during a shortcut toggle or app-blur dismiss.
pub(super) fn hide_search_window_without_animation<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
            SWP_NOSIZE, SWP_NOZORDER,
        };

        let hwnd = match get_window_hwnd(window) {
            Ok(hwnd) => hwnd,
            Err(_) => return window.hide().map_err(|error| error.to_string()),
        };
        let result = unsafe {
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOZORDER
                    | SWP_NOOWNERZORDER
                    | SWP_NOACTIVATE
                    | SWP_HIDEWINDOW,
            )
        };
        return match result {
            Ok(()) => Ok(()),
            Err(_) => window.hide().map_err(|error| error.to_string()),
        };
    }

    #[cfg(not(target_os = "windows"))]
    window.hide().map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
/// Show the already-prepared host with SetWindowPos instead of Tauri's
/// ShowWindow wrapper. The latter lets Windows apply the user-level show
/// animation, which makes the transparent search surface appear to slide in.
fn show_search_window_without_animation<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
        SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
    };

    let hwnd = match get_window_hwnd(window) {
        Ok(hwnd) => hwnd,
        Err(_) => return window.show().map_err(|error| error.to_string()),
    };
    let result = unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE
                | SWP_NOSIZE
                | SWP_NOZORDER
                | SWP_NOOWNERZORDER
                | SWP_NOACTIVATE
                | SWP_SHOWWINDOW,
        )
    };
    match result {
        Ok(()) => {
            // SWP_NOACTIVATE is required to suppress the Windows show
            // animation, but it also prevents the hidden surface from
            // becoming the foreground window. Restore foreground activation
            // explicitly before the WebView focus handoff below.
            unsafe {
                let _ = SetForegroundWindow(hwnd);
            }
            Ok(())
        }
        Err(_) => window.show().map_err(|error| error.to_string()),
    }
}

/// 让主搜索窗口重新成为键盘输入目标，并唤醒 WebView2 accelerator 管线。
pub(super) fn reactivate_search_window_input<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    window.set_focus().map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    activate_search_window(window)?;
    focus_search_webview_content(window)
}

#[cfg(target_os = "windows")]
fn activate_search_window<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let hwnd = get_window_hwnd(window)?;

    unsafe {
        let foreground_window = GetForegroundWindow();
        let foreground_thread_id = if foreground_window.0.is_null() {
            0
        } else {
            GetWindowThreadProcessId(foreground_window, None)
        };
        let current_thread_id = GetCurrentThreadId();
        let attached_to_foreground = foreground_thread_id != 0
            && foreground_thread_id != current_thread_id
            && AttachThreadInput(current_thread_id, foreground_thread_id, true).as_bool();

        let foreground_set = SetForegroundWindow(hwnd).as_bool();
        let _ = BringWindowToTop(hwnd);
        let _ = SetActiveWindow(hwnd);

        if attached_to_foreground {
            let _ = AttachThreadInput(current_thread_id, foreground_thread_id, false);
        }

        if !foreground_set {
            log::warn!("Windows denied foreground activation for search window");
        }
    }

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
/// 将 WebView focus 任务投递给 UI dispatcher，但绝不在当前调用栈等待任务完成。
fn dispatch_search_webview_focus<T, Dispatch, Focus>(
    focus: Focus,
    dispatch: Dispatch,
) -> Result<(), String>
where
    Dispatch: FnOnce(Focus) -> Result<(), String>,
    Focus: FnOnce(T) + Send + 'static,
{
    dispatch(focus)
}

#[cfg(target_os = "windows")]
/// 将键盘焦点推进 WebView2 内容层，确保页面可以收到后续 keydown。
pub(super) fn focus_search_webview_content<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    let main_hwnd = get_window_hwnd(window)?;
    let main_hwnd_raw = main_hwnd.0 as isize;
    let window_label = window.label().to_string();
    dispatch_search_webview_focus(
        move |webview: tauri::webview::PlatformWebview| {
            let result: Result<(), String> = (|| unsafe {
                let main_hwnd = HWND(main_hwnd_raw as _);
                let container_hwnd = GetWindow(main_hwnd, GW_CHILD).unwrap_or_default();
                let content_hwnd = if container_hwnd.0.is_null() {
                    HWND::default()
                } else {
                    GetWindow(container_hwnd, GW_CHILD).unwrap_or_default()
                };
                let focus_target = select_search_webview_focus_hwnd(container_hwnd, content_hwnd);
                let _ = SetFocus(Some(focus_target));
                let _ = webview.controller().SetIsVisible(true);
                webview
                    .controller()
                    .MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
                    .map_err(|error| {
                        format!("Failed to focus search WebView2 content: {}", error)
                    })?;
                Ok(())
            })();
            match result {
                Ok(()) => prime_webview_input_pipeline(),
                Err(error) => log::warn!(
                    "Failed to focus search WebView2 content for '{}': {}",
                    window_label,
                    error
                ),
            }
        },
        |focus| {
            window
                .with_webview(focus)
                .map_err(|error| format!("Failed to access search WebView2 content: {error}"))
        },
    )
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

#[cfg(test)]
mod tests {
    use super::{
        resolve_shortcut_toggle_action, shortcut_action_requires_foreground_activation,
        ShortcutToggleAction,
    };

    #[cfg(target_os = "windows")]
    use super::dispatch_search_webview_focus;
    #[cfg(target_os = "windows")]
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    // The global shortcut is the main way into the app. Each press has to do the right one of
    // three things, and getting it wrong either loses the window or steals focus needlessly.

    #[test]
    fn user_gets_the_window_shown_when_it_is_hidden() {
        assert_eq!(
            resolve_shortcut_toggle_action(false, false),
            ShortcutToggleAction::ShowWithAutoPasteAuthorization
        );
    }

    #[test]
    fn user_gets_the_window_shown_even_when_another_app_was_focused() {
        // A hidden window is shown regardless of who had focus; the paste authorisation is
        // what makes the shortcut useful from another app.
        assert_eq!(
            resolve_shortcut_toggle_action(false, true),
            ShortcutToggleAction::ShowWithAutoPasteAuthorization
        );
    }

    #[test]
    fn user_gets_the_window_hidden_when_it_already_has_focus() {
        assert_eq!(
            resolve_shortcut_toggle_action(true, true),
            ShortcutToggleAction::HideOnly
        );
    }

    #[test]
    fn user_gets_the_existing_window_focused_when_it_is_visible_but_unfocused() {
        assert_eq!(
            resolve_shortcut_toggle_action(true, false),
            ShortcutToggleAction::FocusExistingVisible
        );
    }

    #[test]
    fn user_gets_the_window_brought_forward_when_showing_or_refocusing() {
        // Both of these need the window raised; hiding must not.
        assert!(shortcut_action_requires_foreground_activation(
            ShortcutToggleAction::ShowWithAutoPasteAuthorization
        ));
        assert!(shortcut_action_requires_foreground_activation(
            ShortcutToggleAction::FocusExistingVisible
        ));
        assert!(!shortcut_action_requires_foreground_activation(
            ShortcutToggleAction::HideOnly
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn webview_focus_dispatch_returns_before_deferred_task_runs() {
        type DeferredTask = Box<dyn FnOnce() + Send>;

        let deferred = Arc::new(Mutex::new(None::<DeferredTask>));
        let focused = Arc::new(AtomicBool::new(false));

        dispatch_search_webview_focus(
            {
                let focused = Arc::clone(&focused);
                move |_: ()| focused.store(true, Ordering::Release)
            },
            {
                let deferred = Arc::clone(&deferred);
                move |focus| {
                    *deferred.lock().unwrap_or_else(|error| error.into_inner()) =
                        Some(Box::new(move || focus(())));
                    Ok(())
                }
            },
        )
        .expect("focus dispatch");

        assert!(!focused.load(Ordering::Acquire));
        deferred
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take()
            .expect("deferred focus task")();
        assert!(focused.load(Ordering::Acquire));
    }
}
