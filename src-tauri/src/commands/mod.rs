// Copyright (c) 2025. 千诚. Licensed under GPL v3.

//! 命令入口模块。
pub mod autostart;
pub mod shortcut;
pub mod window;

pub fn invoke_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        window::hide_search_window,
        window::show_popup_window,
        window::hide_popup_window,
        window::is_popup_visible,
        window::is_popup_focused,
        window::is_app_focused,
        window::register_popup_configs,
        window::preload_popup_windows,
        window::open_settings_window,
        shortcut::register_global_shortcut,
        autostart::enable_autostart,
        autostart::disable_autostart,
        autostart::is_autostart_enabled,
        window::close_tray_menu,
    ]
}
