// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 命令入口模块。
pub mod autostart;
pub mod built_in_tools;
pub mod clipboard;
pub mod database;
pub mod mcp;
pub mod paths;
pub mod quick_search;
pub mod shortcut;
pub mod updater;
pub mod window;

/// 构建应用级 Tauri 调用处理器。
///
/// 这里按能力域集中注册命令，目的是让前端只有一个稳定的调用入口，
/// 同时把“窗口控制 / 系统集成 / 搜索 / 工具执行”等能力明确收口在命令层。
pub fn invoke_handler<R: tauri::Runtime>(
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        window::hide_search_window,
        window::show_search_window,
        window::set_tray_status_indicator,
        window::clear_tray_status_indicator,
        window::show_session_status_reminder_notification,
        window::clear_session_status_reminder_notifications,
        window::set_search_surface_hide_on_app_blur,
        window::set_search_window_allow_height_override,
        window::show_popup_window,
        window::hide_popup_window,
        window::register_popup_configs,
        window::preload_popup_windows,
        window::open_settings_window,
        window::resize_window_height,
        window::set_search_window_defaults,
        window::set_search_window_min_size,
        window::reset_search_window_bounds,
        window::get_search_window_state,
        shortcut::register_global_shortcut,
        shortcut::get_shortcut_status,
        clipboard::read_clipboard_payload,
        clipboard::consume_shortcut_auto_paste_payload,
        clipboard::write_clipboard_text,
        autostart::enable_autostart,
        autostart::disable_autostart,
        autostart::is_autostart_enabled,
        window::close_tray_menu,
        database::database_query,
        database::database_batch,
        database::database_tx_begin,
        database::database_tx_query,
        database::database_tx_batch,
        database::database_tx_commit,
        database::database_tx_rollback,
        database::database_export_backup,
        database::database_import_backup,
        paths::get_app_directory_path,
        paths::get_runtime_info,
        built_in_tools::built_in_tools_execute_bash,
        built_in_tools::built_in_tools_cancel_bash,
        built_in_tools::built_in_tools_computer_session,
        built_in_tools::built_in_tools_computer_observe,
        built_in_tools::built_in_tools_computer_act,
        mcp::mcp_connect_server,
        mcp::mcp_disconnect_server,
        mcp::mcp_list_tools,
        mcp::mcp_call_tool,
        mcp::mcp_get_client_status,
        mcp::mcp_get_all_client_statuses,
        mcp::mcp_disconnect_all,
        quick_search::quick_search_search_shortcuts,
        quick_search::quick_search_search_files,
        quick_search::quick_search_get_shortcut_icon,
        quick_search::quick_search_get_shortcut_icons,
        quick_search::quick_search_get_image_thumbnails,
        quick_search::quick_search_prepare_index,
        quick_search::quick_search_get_status,
        updater::updater_check_for_updates,
        updater::updater_download_update,
        updater::updater_install_update,
    ]
}
