// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Webview 运行时默认配置。

#[cfg(target_os = "windows")]
use raw_window_handle::HasWindowHandle;
#[cfg(target_os = "windows")]
use tauri::Emitter;
#[cfg(target_os = "windows")]
use tauri::Manager;
use tauri::{Runtime, WebviewWindow};
#[cfg(target_os = "windows")]
use webview2_com::AcceleratorKeyPressedEventHandler;
#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2AcceleratorKeyPressedEventArgs2,
    ICoreWebView2Controller, ICoreWebView2Settings3, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, TRUE, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL, VK_SHIFT, VK_SPACE};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, SC_KEYMENU, WM_SYSCHAR, WM_SYSCOMMAND,
};
#[cfg(target_os = "windows")]
use windows_core::Interface;

#[cfg(target_os = "windows")]
/**
 * 浏览器默认快捷键配置能力。
 */
trait BrowserAcceleratorKeySettings {
    /**
     * 设置 browser accelerator keys 是否启用。
     */
    fn set_are_browser_accelerator_keys_enabled(&self, enabled: bool) -> Result<(), String>;
}

/**
 * 统一关闭 browser accelerator keys。
 */
#[cfg(target_os = "windows")]
fn disable_browser_accelerator_keys_with_settings<T: BrowserAcceleratorKeySettings>(
    settings: &T,
) -> Result<(), String> {
    settings.set_are_browser_accelerator_keys_enabled(false)
}

#[cfg(target_os = "windows")]
impl BrowserAcceleratorKeySettings for ICoreWebView2Settings3 {
    /**
     * 调用 WebView2 设置关闭浏览器默认快捷键。
     */
    fn set_are_browser_accelerator_keys_enabled(&self, enabled: bool) -> Result<(), String> {
        unsafe {
            self.SetAreBrowserAcceleratorKeysEnabled(enabled)
                .map_err(|error| {
                    format!(
                        "Failed to set WebView2 browser accelerator keys enabled to {}: {}",
                        enabled, error
                    )
                })
        }
    }
}

/**
 * 从 controller 向下拿到 settings3，并关闭 browser accelerator keys。
 */
#[cfg(target_os = "windows")]
fn disable_browser_accelerator_keys_with_controller(
    controller: &ICoreWebView2Controller,
) -> Result<(), String> {
    unsafe {
        let core_webview = controller
            .CoreWebView2()
            .map_err(|error| format!("Failed to get CoreWebView2 instance: {}", error))?;
        let settings = core_webview
            .Settings()
            .map_err(|error| format!("Failed to get CoreWebView2 settings: {}", error))?;
        let settings3: ICoreWebView2Settings3 = settings
            .cast()
            .map_err(|error| format!("Failed to cast CoreWebView2 settings to v3: {}", error))?;

        disable_browser_accelerator_keys_with_settings(&settings3)
    }
}

#[cfg(target_os = "windows")]
/// 子类化标识，用于在窗口上唯一标记系统菜单拦截子类过程。
const SYSTEM_MENU_SUBCLASS_ID: usize = 0x5359_534D;

#[cfg(target_os = "windows")]
/// 从 Tauri 窗口取出顶层 Win32 HWND。
fn top_level_hwnd<R: Runtime>(window: &WebviewWindow<R>) -> Result<HWND, String> {
    let window_handle = window
        .window_handle()
        .map_err(|error| format!("Failed to get window handle: {}", error))?;

    match window_handle.as_ref() {
        raw_window_handle::RawWindowHandle::Win32(handle) => Ok(HWND(handle.hwnd.get() as _)),
        _ => Err("Not a Win32 window".to_string()),
    }
}

#[cfg(target_os = "windows")]
/// 子类过程：拦截 Alt+Space 真正触发系统菜单的消息（WM_SYSCHAR / WM_SYSCOMMAND），
/// 阻止系统菜单弹出。注意不拦截 WM_SYSKEYDOWN，使其仍能传到 WebView2 并派发 DOM keydown，
/// 供前端捕获 Alt+Space 作为快捷键。
unsafe extern "system" fn system_menu_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    if msg == WM_SYSCHAR && wparam.0 == VK_SPACE.0 as usize {
        // 吞掉 Alt+Space 的 WM_SYSCHAR，这是真正触发系统菜单的消息。
        return LRESULT(0);
    }

    if msg == WM_SYSCOMMAND && (wparam.0 & 0xFFF0) == SC_KEYMENU as usize {
        return LRESULT(0);
    }

    DefSubclassProc(hwnd, msg, wparam, lparam)
}

#[cfg(target_os = "windows")]
/// EnumChildWindows 回调：为每个子窗口安装系统菜单拦截子类。
unsafe extern "system" fn install_subclass_on_child(hwnd: HWND, _lparam: LPARAM) -> BOOL {
    let _ = SetWindowSubclass(
        hwnd,
        Some(system_menu_subclass_proc),
        SYSTEM_MENU_SUBCLASS_ID,
        0,
    );
    TRUE
}

#[cfg(target_os = "windows")]
/// 在顶层窗口上安装系统菜单拦截子类，屏蔽 Alt+Space 系统菜单热键。
///
/// 子窗口（WebView2 内容区）的子类需在 webview 就绪后由
/// [`install_system_menu_interceptor_on_children`] 单独安装。
fn install_system_menu_interceptor<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let hwnd = top_level_hwnd(window)?;
    let installed = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(system_menu_subclass_proc),
            SYSTEM_MENU_SUBCLASS_ID,
            0,
        )
    };
    if !installed.as_bool() {
        return Err("Failed to install system menu subclass".to_string());
    }

    Ok(())
}

#[cfg(target_os = "windows")]
/// 为窗口的所有子孙窗口安装系统菜单拦截子类。
///
/// WebView2 内容渲染在子 HWND 中，焦点在内容区时 WM_SYSKEYDOWN/WM_SYSCHAR 由子窗口处理，
/// 因此需在 webview 就绪、子窗口已创建后调用此函数，才能在源头拦截。
fn install_system_menu_interceptor_on_children(hwnd: HWND) {
    unsafe {
        let _ = EnumChildWindows(hwnd, Some(install_subclass_on_child), LPARAM(0));
    }
}

#[cfg(target_os = "windows")]
/// 判断是否命中了 Alt+Space。
///
/// WebView2 把 Alt+Space 作为 system accelerator，默认不会派发 DOM keydown；
/// 必须在 `AcceleratorKeyPressed` 中调用 `SetIsBrowserAcceleratorKeyEnabled(false)`
/// 才能让事件继续传播到 web 内容。注意不要调 `SetHandled(true)`，否则传播会被
/// 终止，DOM 同样收不到。菜单抑制由宿主子类化吃掉 WM_SYSCHAR / SC_KEYMENU 完成。
fn is_system_menu_accelerator_command(key_event_kind: i32, virtual_key: u32) -> bool {
    let is_system_key_down = key_event_kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN.0;
    is_system_key_down && virtual_key == u32::from(VK_SPACE.0)
}

#[cfg(target_os = "windows")]
/// 注册 WebView2 accelerator 处理器，将 Alt+Space 转成 Tauri 事件供前端捕获。
///
/// WebView2 把 Alt+Space 当作 system accelerator，默认不会派发 DOM keydown；
/// 实测 `SetIsBrowserAcceleratorKeyEnabled(false)` 对系统键不生效，因此采用事件桥模式：
/// 在 accelerator 阶段直接 emit Tauri 事件，前端捕获模式下监听该事件录入快捷键。
/// 系统菜单的抑制由 [`system_menu_subclass_proc`] 在宿主层完成。
fn register_system_menu_accelerator_handler<R: Runtime>(
    window: &WebviewWindow<R>,
    controller: &ICoreWebView2Controller,
) -> Result<(), String> {
    let app_handle = window.app_handle().clone();
    let mut token = 0i64;
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
        move |_controller: Option<ICoreWebView2Controller>,
              args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
            let Some(args) = args else {
                return Ok(());
            };

            unsafe {
                let mut key_event_kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                args.KeyEventKind(&mut key_event_kind)?;

                let mut virtual_key = 0u32;
                args.VirtualKey(&mut virtual_key)?;

                if !is_system_menu_accelerator_command(key_event_kind.0, virtual_key) {
                    return Ok(());
                }

                let is_ctrl_down = (GetKeyState(i32::from(VK_CONTROL.0)) as u16 & 0x8000) != 0;
                let is_shift_down = (GetKeyState(i32::from(VK_SHIFT.0)) as u16 & 0x8000) != 0;
                log::info!(
                    "[sysmenu-accel] Alt+Space detected, emitting shortcut-capture-system-key (ctrl={} shift={})",
                    is_ctrl_down,
                    is_shift_down
                );
                let _ = app_handle.emit(
                    "shortcut-capture-system-key",
                    serde_json::json!({
                        "key": "Space",
                        "alt": true,
                        "ctrl": is_ctrl_down,
                        "shift": is_shift_down,
                    }),
                );
            }

            Ok(())
        },
    ));

    unsafe {
        controller
            .add_AcceleratorKeyPressed(&handler, &mut token)
            .map_err(|error| format!("Failed to add system menu accelerator handler: {}", error))?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
/// 判断是否命中了需要从宿主层兜底转发的搜索 surface 快捷键。
fn is_search_surface_accelerator_command(
    key_event_kind: i32,
    virtual_key: u32,
    is_control_down: bool,
) -> bool {
    let is_key_down = key_event_kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN.0
        || key_event_kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN.0;
    is_key_down && is_control_down && virtual_key == u32::from(b'M')
}

#[cfg(target_os = "windows")]
/// 在主搜索窗口注册 WebView2 accelerator 兜底，避免 DOM 未接管焦点时首个 Ctrl+M 丢失。
fn register_search_surface_accelerator_bridge<R: Runtime>(
    window: &WebviewWindow<R>,
    controller: &ICoreWebView2Controller,
) -> Result<(), String> {
    if window.label() != "main" {
        return Ok(());
    }

    let app_handle = window.app_handle().clone();
    let mut token = 0i64;
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
        move |_controller: Option<ICoreWebView2Controller>,
              args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
            let Some(args) = args else {
                return Ok(());
            };

            unsafe {
                let mut key_event_kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                args.KeyEventKind(&mut key_event_kind)?;

                let mut virtual_key = 0u32;
                args.VirtualKey(&mut virtual_key)?;

                let mut physical_key_status = Default::default();
                args.PhysicalKeyStatus(&mut physical_key_status)?;

                let is_control_down = (GetKeyState(i32::from(VK_CONTROL.0)) as u16 & 0x8000) != 0;
                if !is_search_surface_accelerator_command(
                    key_event_kind.0,
                    virtual_key,
                    is_control_down,
                ) {
                    return Ok(());
                }

                if let Ok(args2) =
                    Interface::cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>(&args)
                {
                    let _ = args2.SetIsBrowserAcceleratorKeyEnabled(false);
                }
                let _ = args.SetHandled(true);
                let _ = app_handle.emit(
                    "search-surface-command",
                    serde_json::json!({
                        "command": "toggle-model-dropdown",
                        "source": "webview2-accelerator"
                    }),
                );
            }

            Ok(())
        },
    ));

    unsafe {
        controller
            .add_AcceleratorKeyPressed(&handler, &mut token)
            .map_err(|error| format!("Failed to add WebView2 accelerator handler: {}", error))?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
/// 判断是否命中了需要打开 DevTools 的快捷键。
fn is_devtools_accelerator_command(
    key_event_kind: i32,
    virtual_key: u32,
    is_control_down: bool,
    is_shift_down: bool,
) -> bool {
    let is_key_down = key_event_kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN.0
        || key_event_kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN.0;
    if !is_key_down {
        return false;
    }
    // F12
    if virtual_key == 0x7B {
        return true;
    }
    // Ctrl+Shift+I
    if is_control_down && is_shift_down && virtual_key == 0x49 {
        return true;
    }
    false
}

#[cfg(target_os = "windows")]
/// 在 debug 构建中注册 F12 / Ctrl+Shift+I 快捷键以打开 DevTools。
fn register_devtools_accelerator_handler(
    controller: &ICoreWebView2Controller,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Ok(());
    }

    let mut token = 0i64;
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(
        move |controller: Option<ICoreWebView2Controller>,
              args: Option<ICoreWebView2AcceleratorKeyPressedEventArgs>| {
            let (Some(controller), Some(args)) = (controller, args) else {
                return Ok(());
            };

            unsafe {
                let mut key_event_kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
                args.KeyEventKind(&mut key_event_kind)?;

                let mut virtual_key = 0u32;
                args.VirtualKey(&mut virtual_key)?;

                let is_control_down = (GetKeyState(i32::from(VK_CONTROL.0)) as u16 & 0x8000) != 0;
                let is_shift_down = (GetKeyState(i32::from(VK_SHIFT.0)) as u16 & 0x8000) != 0;

                if !is_devtools_accelerator_command(
                    key_event_kind.0,
                    virtual_key,
                    is_control_down,
                    is_shift_down,
                ) {
                    return Ok(());
                }

                if let Ok(args2) =
                    Interface::cast::<ICoreWebView2AcceleratorKeyPressedEventArgs2>(&args)
                {
                    let _ = args2.SetIsBrowserAcceleratorKeyEnabled(false);
                }
                let _ = args.SetHandled(true);

                if let Ok(core_webview) = controller.CoreWebView2() {
                    let _ = core_webview.OpenDevToolsWindow();
                }
            }

            Ok(())
        },
    ));

    unsafe {
        controller
            .add_AcceleratorKeyPressed(&handler, &mut token)
            .map_err(|error| format!("Failed to add devtools accelerator handler: {}", error))?;
    }

    Ok(())
}

#[cfg(target_os = "windows")]
/**
 * 为桌面窗口应用统一的 webview 运行时默认配置。
 */
pub(crate) fn apply_webview_runtime_defaults<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    if let Err(error) = install_system_menu_interceptor(window) {
        log::warn!(
            "Failed to install system menu interceptor for window '{}': {}",
            window.label(),
            error
        );
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let window_clone = window.clone();
    window
        .with_webview(move |webview| {
            let controller = webview.controller();
            let result = disable_browser_accelerator_keys_with_controller(&controller)
                .and_then(|_| register_system_menu_accelerator_handler(&window_clone, &controller))
                .and_then(|_| {
                    register_search_surface_accelerator_bridge(&window_clone, &controller)
                })
                .and_then(|_| register_devtools_accelerator_handler(&controller));
            if let Ok(hwnd) = top_level_hwnd(&window_clone) {
                install_system_menu_interceptor_on_children(hwnd);
            }
            let _ = tx.send(result);
        })
        .map_err(|error| format!("Failed to access platform webview: {}", error))?;

    rx.recv().map_err(|error| {
        format!(
            "Failed to receive webview default configuration result: {}",
            error
        )
    })?
}

#[cfg(not(target_os = "windows"))]
/**
 * 非 Windows 平台无需额外的 WebView2 默认配置。
 */
pub(crate) fn apply_webview_runtime_defaults<R: Runtime>(
    _window: &WebviewWindow<R>,
) -> Result<(), String> {
    Ok(())
}
