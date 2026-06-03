// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

mod commands;
mod core;
#[doc(hidden)]
pub mod testing;

use core::built_in_tools::BuiltInProcessExecutionRegistry;
use core::database::DatabaseRuntime;
use core::mcp::McpClientManager;
use core::setup;
use core::window::popup::PopupRegistry;
use log::{error, warn};
use tauri::{Manager, WindowEvent};
#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;

fn resolve_single_instance_activation_window_label(
    has_settings_window: bool,
    has_main_window: bool,
) -> Option<&'static str> {
    if has_settings_window {
        return Some("settings");
    }

    if has_main_window {
        return Some("main");
    }

    None
}

fn focus_single_instance_activation_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), String> {
    let label = resolve_single_instance_activation_window_label(
        app.get_webview_window("settings").is_some(),
        app.get_webview_window("main").is_some(),
    )
    .ok_or_else(|| {
        "No activation window found while handling second-instance activation".to_string()
    })?;

    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("Activation window '{label}' disappeared before focus"))?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn should_activate_settings_for_args(args: &[String]) -> bool {
    args.iter()
        .any(|arg| arg.starts_with("touchai://hub/auth/callback"))
}

fn handle_single_instance_activation<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    args: &[String],
) -> Result<(), String> {
    if should_activate_settings_for_args(args) {
        return tauri::async_runtime::block_on(crate::core::window::build_settings_window(app));
    }

    focus_single_instance_activation_window(app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    velopack::VelopackApp::build().run();

    let builder = tauri::Builder::default().plugin(core::system::logging::build_plugin());

    let builder = if core::system::runtime::should_enable_single_instance() {
        builder.plugin(tauri_plugin_single_instance::init(
            |app, args: Vec<String>, _cwd: String| {
                if let Err(error) = handle_single_instance_activation(app, &args) {
                    warn!("{error}");
                }
            },
        ))
    } else {
        builder
    };

    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ));

    let builder = builder
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
        .manage(core::system::desktop_context::DesktopContextRuntime::new())
        .manage(core::window::status_reminder::SessionStatusReminderNotificationRuntime::new())
        .manage(core::window::tray::TrayStatusRuntime::new())
        .manage(BuiltInProcessExecutionRegistry::new())
        .manage(McpClientManager::new())
        .manage(core::updater::AppUpdaterState::default())
        .on_window_event(|window, event| {
            if matches!(window.label(), "main" | "settings")
                && matches!(
                    event,
                    WindowEvent::Resized(_)
                        | WindowEvent::Moved(_)
                        | WindowEvent::ScaleFactorChanged { .. }
                )
            {
                if let Some(webview_window) = window.app_handle().get_webview_window(window.label())
                {
                    if let Err(error) =
                        core::window::rounded_corners::sync_window_corner_style(&webview_window)
                    {
                        warn!(
                            "Failed to sync rounded window corner style for '{}': {}",
                            window.label(),
                            error
                        );
                    }
                }
            }

            // 主窗口尺寸/位置变化时，记录到状态机用于区分程序化 resize 和用户操作。
            if window.label() == "main" {
                match event {
                    WindowEvent::Resized(_) | WindowEvent::Moved(_) => {
                        let app_handle = window.app_handle().clone();
                        let window = window.clone();
                        if let Err(error) =
                            core::window::resize::record_search_window_runtime_resize(
                                &app_handle,
                                &window,
                            )
                        {
                            warn!(
                                "Failed to record search window runtime resize for '{}': {}",
                                window.label(),
                                error
                            );
                        }
                    }
                    _ => {}
                }
            }

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
        .invoke_handler(commands::invoke_handler::<tauri::Wry>());

    let app_result = builder
        .setup(|app| {
            if let Err(err) = setup::setup_app(app) {
                return Err(Box::new(std::io::Error::other(err)));
            }
            #[cfg(any(windows, target_os = "linux"))]
            {
                app.deep_link().register_all()?;
            }
            Ok(())
        })
        .run(tauri::generate_context!());

    if let Err(err) = app_result {
        error!("Error while running tauri application: {}", err);
        panic!("error while running tauri application: {}", err);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        resolve_single_instance_activation_window_label, should_activate_settings_for_args,
    };

    #[test]
    fn single_instance_activation_prefers_settings_window() {
        assert_eq!(
            resolve_single_instance_activation_window_label(true, true),
            Some("settings")
        );
        assert_eq!(
            resolve_single_instance_activation_window_label(true, false),
            Some("settings")
        );
    }

    #[test]
    fn single_instance_activation_falls_back_to_main_window() {
        assert_eq!(
            resolve_single_instance_activation_window_label(false, true),
            Some("main")
        );
    }

    #[test]
    fn single_instance_activation_errors_when_no_window_exists() {
        assert_eq!(
            resolve_single_instance_activation_window_label(false, false),
            None
        );
    }

    #[test]
    fn managed_auth_callback_activation_prefers_settings_window() {
        assert!(should_activate_settings_for_args(&[
            "touchai://hub/auth/callback?code=test".to_string(),
        ]));
        assert!(!should_activate_settings_for_args(&[
            "--minimized".to_string()
        ]));
    }
}
