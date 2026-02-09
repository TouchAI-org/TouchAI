// Copyright (c) 2025. Qian Cheng. Licensed under GPL v3

mod commands;
mod core;

use core::system::database::ensure_data_directory;
use core::window::popup::PopupRegistry;
use log::{error, info, warn};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_result = tauri::Builder::default()
        .plugin(core::system::logging::build_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_x::init())
        .plugin(tauri_plugin_fs_pro::init())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(core::system::shortcut::create_shortcut_handler())
                .build(),
        )
        .manage(PopupRegistry::new())
        .invoke_handler(commands::invoke_handler())
        .setup(|app| {
            match ensure_data_directory() {
                Ok(data_dir) => {
                    info!("Data directory ready: {}", data_dir.display());
                }
                Err(err) => {
                    error!("Failed to create data directory: {}", err);
                    return Err(Box::new(std::io::Error::other(err.to_string())));
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                if let Err(err) = core::window::search::set_search_window_style(&window) {
                    warn!("Failed to set rounded corners: {}", err);
                }
            }

            if let Err(err) = core::window::tray::create_tray(app.handle()) {
                warn!("Failed to create tray: {}", err);
            }

            if let Err(err) = core::window::tray::preload_tray_menu(app.handle()) {
                warn!("Failed to preload tray menu: {}", err);
            }

            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(err) = app_result {
        error!("Error while running tauri application: {}", err);
        panic!("error while running tauri application: {}", err);
    }
}
