// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 命令入口模块。
pub mod autostart;
pub mod mcp;
pub mod paths;
pub mod quick_search;
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
        window::resize_window_height,
        shortcut::register_global_shortcut,
        shortcut::get_shortcut_status,
        autostart::enable_autostart,
        autostart::disable_autostart,
        autostart::is_autostart_enabled,
        window::close_tray_menu,
        paths::get_app_directory_path,
        mcp::mcp_connect_server,
        mcp::mcp_disconnect_server,
        mcp::mcp_list_tools,
        mcp::mcp_call_tool,
        mcp::mcp_get_client_status,
        mcp::mcp_get_all_client_statuses,
        mcp::mcp_disconnect_all,
        quick_search::quick_search_search_shortcuts,
        quick_search::quick_search_get_shortcut_icon,
        quick_search::quick_search_get_shortcut_icons,
        quick_search::quick_search_get_image_thumbnails,
        quick_search::quick_search_prepare_index,
        quick_search::quick_search_get_status,
    ]
}
