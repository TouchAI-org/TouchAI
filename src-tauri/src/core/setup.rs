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

    // 异步初始化字体资源
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = crate::core::system::assets::initialize_font(app_handle.clone()).await {
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

    if let Some(window) = app.get_webview_window("main") {
        if let Err(err) = crate::core::window::search::set_search_window_style(&window) {
            warn!("Failed to set rounded corners: {}", err);
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
