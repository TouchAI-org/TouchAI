// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

//! Application startup orchestration.

use log::{error, info, warn};
use std::fs;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use crate::core::system::paths::{
    app_directory_path, is_user_data_directory, legacy_app_directory_path, APP_DIRECTORY_LAYOUT,
};

fn copy_directory_recursive(
    source: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    fs::create_dir_all(target)
        .map_err(|error| format!("Failed to create directory '{}': {error}", target.display()))?;

    for entry in fs::read_dir(source)
        .map_err(|error| format!("Failed to read directory '{}': {error}", source.display()))?
    {
        let entry = entry.map_err(|error| {
            format!(
                "Failed to read directory entry '{}': {error}",
                source.display()
            )
        })?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());

        if source_path.is_dir() {
            copy_directory_recursive(&source_path, &target_path)?;
        } else {
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Failed to create directory '{}' while copying '{}': {error}",
                        parent.display(),
                        source_path.display()
                    )
                })?;
            }

            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "Failed to copy '{}' to '{}': {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn move_directory(source: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_directory_recursive(source, target)?;
            fs::remove_dir_all(source).map_err(|remove_error| {
                format!(
                    "Failed to remove legacy directory '{}' after copying to '{}': {} (rename error: {})",
                    source.display(),
                    target.display(),
                    remove_error,
                    rename_error
                )
            })
        }
    }
}

fn migrate_legacy_user_directories() -> Result<(), String> {
    for (directory, _, relative_path) in APP_DIRECTORY_LAYOUT {
        if !is_user_data_directory(*directory) {
            continue;
        }

        let legacy_path = legacy_app_directory_path(*directory)?;
        let current_path = app_directory_path(*directory)?;

        if legacy_path == current_path || !legacy_path.exists() || current_path.exists() {
            continue;
        }

        if let Some(parent) = current_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Failed to create parent directory '{}' for '{}': {error}",
                    parent.display(),
                    current_path.display()
                )
            })?;
        }

        move_directory(&legacy_path, &current_path)?;
        info!(
            "Migrated legacy '{}' directory from '{}' to '{}'.",
            relative_path,
            legacy_path.display(),
            current_path.display()
        );
    }

    Ok(())
}

fn initialize_base_directories() -> Result<(), String> {
    for (directory, _, relative_path) in APP_DIRECTORY_LAYOUT {
        let path = app_directory_path(*directory)?;
        fs::create_dir_all(&path).map_err(|error| {
            format!(
                "Failed to create '{}' directory at '{}': {}",
                relative_path,
                path.display(),
                error
            )
        })?;
    }

    Ok(())
}

fn show_initialization_failed_dialog(app: &tauri::App) {
    let app_handle = app.handle().clone();
    let _ = std::thread::spawn(move || {
        app_handle
            .dialog()
            .message("TouchAI initialization failed. Check filesystem permissions and try again.")
            .title("TouchAI")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    })
    .join();
}

pub fn setup_app(app: &mut tauri::App) -> Result<(), String> {
    if let Err(error) = migrate_legacy_user_directories() {
        error!("Failed to migrate legacy user directories: {}", error);
        show_initialization_failed_dialog(app);
        return Err(error);
    }

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

    let app_handle = app.handle().clone();
    if crate::core::system::runtime::is_e2e_test_mode() {
        info!("Skipping font initialization in E2E test mode.");
    } else {
        tauri::async_runtime::spawn(async move {
            if let Err(error) =
                crate::core::system::assets::initialize_font(app_handle.clone()).await
            {
                error!("Failed to initialize font: {}", error);
                let _ = app_handle
                    .dialog()
                    .message(
                        "Font initialization failed. Some parts of the interface may not render correctly.",
                    )
                    .title("TouchAI")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            } else {
                info!("Font initialized successfully.");
            }
        });
    }

    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) =
            crate::core::window::webview_defaults::apply_webview_runtime_defaults(&window)
        {
            warn!("Failed to apply webview runtime defaults: {}", error);
        }

        if let Err(error) = crate::core::window::search::set_search_window_style(&window) {
            warn!("Failed to set rounded corners: {}", error);
        }

        if crate::core::system::runtime::is_e2e_test_mode() {
            if let Err(error) = crate::core::window::show_search_window_for_testing(&window) {
                warn!("Failed to show main window in E2E test mode: {}", error);
            }
        }
    }

    if let Err(error) = crate::core::window::tray::create_tray(app.handle()) {
        warn!("Failed to create tray: {}", error);
    }

    if let Err(error) = crate::core::window::tray::preload_tray_menu(app.handle()) {
        warn!("Failed to preload tray menu: {}", error);
    }

    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    {
        // Only packaged builds should register the Windows notification identity,
        // so local dev runs do not reuse or overwrite the installed app shortcut/AUMID.
        let app_id = app.config().identifier.clone();
        if let Err(error) =
            crate::core::window::status_reminder::ensure_windows_start_menu_shortcut(&app_id)
        {
            warn!("Failed to ensure Start Menu shortcut: {}", error);
        }
    }

    Ok(())
}
