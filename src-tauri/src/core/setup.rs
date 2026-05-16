// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用 setup 阶段逻辑。

use log::{error, info, warn};
use std::fs;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::core::system::paths::{app_directory_path, APP_DIRECTORY_LAYOUT};

/// 创建所有基础目录结构。
fn initialize_base_directories() -> Result<(), String> {
    for (directory, _, relative_path) in APP_DIRECTORY_LAYOUT {
        let path = app_directory_path(*directory)?;
        fs::create_dir_all(&path).map_err(|err| {
            format!(
                "Failed to create '{}' directory at '{}': {}",
                relative_path,
                path.display(),
                err
            )
        })?;
    }
    Ok(())
}

/// 弹出初始化失败系统提示框。
fn show_initialization_failed_dialog(app: &tauri::App) {
    let app_handle = app.handle().clone();
    let _ = std::thread::spawn(move || {
        app_handle
            .dialog()
            .message("TouchAI初始化失败，请检查文件权限")
            .title("TouchAI")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    })
    .join();
}

/// 执行应用 setup 阶段初始化（目录、窗口、托盘）。
pub fn setup_app(app: &mut tauri::App) -> Result<(), String> {
    if let Err(error) = initialize_base_directories() {
        error!("Failed to initialize base directories: {}", error);
        show_initialization_failed_dialog(app);
        return Err(error);
    }
    info!("Application base directories initialized.");

    let database_runtime =
        tauri::async_runtime::block_on(crate::core::database::DatabaseRuntime::initialize(app))
            .map_err(|error| {
                error!("Failed to initialize database runtime: {}", error);
                show_initialization_failed_dialog(app);
                error
            })?;
    app.manage(database_runtime);
    info!("Database runtime initialized.");

    let clipboard_runtime = crate::core::system::clipboard::ClipboardRuntime::initialize()
        .map_err(|error| {
            error!("Failed to initialize clipboard runtime: {}", error);
            show_initialization_failed_dialog(app);
            error
        })?;
    app.manage(clipboard_runtime);
    info!("Clipboard runtime initialized.");

    // 异步初始化字体资源
    let app_handle = app.handle().clone();
    if crate::core::system::runtime::is_e2e_test_mode() {
        info!("Skipping font initialization in E2E test mode.");
    } else {
        tauri::async_runtime::spawn(async move {
            if let Err(err) = crate::core::system::assets::initialize_font(app_handle.clone()).await
            {
                error!("Failed to initialize font: {}", err);
                // 弹出字体下载失败提示
                let _ = app_handle
                    .dialog()
                    .message("字体下载失败，部分界面可能显示异常")
                    .title("TouchAI")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            } else {
                info!("Font initialized successfully");
            }
        });
    }

    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) =
            crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)
        {
            warn!("Failed to apply webview runtime defaults: {}", err);
        }
        if let Err(err) = crate::core::window::search::set_search_window_style(&window) {
            warn!("Failed to set rounded corners: {}", err);
        }
        if crate::core::system::runtime::is_e2e_test_mode() {
            if let Err(err) = crate::core::window::show_search_window_for_testing(&window) {
                warn!("Failed to show main window in E2E test mode: {}", err);
            }
        }
    }

    if let Err(err) = crate::core::window::tray::create_tray(app.handle()) {
        warn!("Failed to create tray: {}", err);
    }

    if let Err(err) = crate::core::window::tray::preload_tray_menu(app.handle()) {
        warn!("Failed to preload tray menu: {}", err);
    }

    Ok(())
}
