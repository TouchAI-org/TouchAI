// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 自启动命令。
use tauri::{AppHandle, Runtime};

#[tauri::command]
pub fn enable_autostart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::system::autostart::enable_autostart(app)
}

#[tauri::command]
pub fn disable_autostart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    crate::core::system::autostart::disable_autostart(app)
}

#[tauri::command]
pub fn is_autostart_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    crate::core::system::autostart::is_autostart_enabled(app)
}
