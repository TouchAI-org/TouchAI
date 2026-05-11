// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Webview 运行时默认配置。

#[cfg(target_os = "windows")]
use tauri::Emitter;
#[cfg(target_os = "windows")]
use tauri::Manager;
#[cfg(target_os = "windows")]
use webview2_com::AcceleratorKeyPressedEventHandler;
#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2AcceleratorKeyPressedEventArgs, ICoreWebView2AcceleratorKeyPressedEventArgs2,
    ICoreWebView2Controller, ICoreWebView2Settings3, COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN,
    COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, VK_CONTROL};
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
fn register_search_surface_accelerator_bridge(
    window: &tauri::WebviewWindow,
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
/**
 * 为桌面窗口应用统一的 webview 运行时默认配置。
 */
pub(crate) fn apply_webview_runtime_defaults(window: &tauri::WebviewWindow) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let window_clone = window.clone();
    window
        .with_webview(move |webview| {
            let controller = webview.controller();
            let result =
                disable_browser_accelerator_keys_with_controller(&controller).and_then(|_| {
                    register_search_surface_accelerator_bridge(&window_clone, &controller)
                });
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
pub(crate) fn apply_webview_runtime_defaults(_window: &tauri::WebviewWindow) -> Result<(), String> {
    Ok(())
}
