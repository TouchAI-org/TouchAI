// Copyright (c) 2026. 千诚. Licensed under GPL v3

//! 开机自启动模块
//!
//! 负责管理应用的开机自启动功能

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

pub fn enable_autostart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let autostart_manager = app.autolaunch();
    autostart_manager
        .enable()
        .map_err(|e| format!("Failed to enable autostart: {}", e))
}

pub fn disable_autostart<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let autostart_manager = app.autolaunch();
    match autostart_manager.disable() {
        Ok(()) => Ok(()),
        Err(err) => {
            let err_text = err.to_string();
            if err_text.contains("os error 2") || err_text.contains("系统找不到指定的文件")
            {
                return Ok(());
            }

            Err(format!("Failed to disable autostart: {}", err))
        }
    }
}

pub fn is_autostart_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let autostart_manager = app.autolaunch();
    autostart_manager
        .is_enabled()
        .map_err(|e| format!("Failed to check autostart status: {}", e))
}
