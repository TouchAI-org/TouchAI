// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 快捷键命令。
use tauri::{AppHandle, Runtime};

#[tauri::command]
pub fn register_global_shortcut<R: Runtime>(
    app: AppHandle<R>,
    shortcut: String,
) -> Result<(), String> {
    crate::core::system::shortcut::register_global_shortcut(app, shortcut)
}

#[tauri::command]
pub fn get_shortcut_status() -> (bool, Option<String>) {
    crate::core::system::shortcut::get_shortcut_status()
}

#[tauri::command]
pub fn set_search_surface_shortcuts(
    entries: Vec<crate::core::system::shortcut::SearchSurfaceShortcutEntry>,
) -> Result<(), String> {
    crate::core::system::shortcut::set_search_surface_shortcuts(entries)
}
