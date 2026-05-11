// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

mod commands;
mod core;

use core::built_in_tools::BashExecutionRegistry;
use core::database::DatabaseRuntime;
use core::mcp::McpClientManager;
use core::setup;
use core::window::popup::PopupRegistry;
use log::{error, warn};
use tauri::{Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(core::system::logging::build_plugin())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_single_instance::init(
            |app, _args: Vec<String>, _cwd: String| {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                } else {
                    warn!("Main window not found while handling second-instance activation");
                }
            },
        ))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs_pro::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(core::system::shortcut::create_shortcut_handler())
                .build(),
        )
        .manage(PopupRegistry::new())
        .manage(core::window::search::surface::SearchSurfaceRuntime::new())
        .manage(BashExecutionRegistry::new())
        .manage(McpClientManager::new())
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Focused(false)) {
                let app_handle = window.app_handle().clone();
                let window_label = window.label().to_string();
                core::window::search::surface::handle_window_blur(&app_handle, &window_label);
            }

            if matches!(event, WindowEvent::Destroyed) {
                let app_handle = window.app_handle().clone();
                let window_label = window.label().to_string();
                core::window::search::surface::handle_window_destroyed(&app_handle, &window_label);

                if let Some(runtime) = window.app_handle().try_state::<DatabaseRuntime>() {
                    let runtime = runtime.inner().clone();
                    tauri::async_runtime::spawn(async move {
                        runtime.abort_transactions_for_window(&window_label).await;
                    });
                }
            }
        })
        .invoke_handler(commands::invoke_handler());

    let app_result = builder
        .setup(|app| {
            if let Err(err) = setup::setup_app(app) {
                return Err(Box::new(std::io::Error::other(err)));
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(err) = app_result {
        error!("Error while running tauri application: {}", err);
        panic!("error while running tauri application: {}", err);
    }
}
