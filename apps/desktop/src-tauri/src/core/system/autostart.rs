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
            if is_missing_autostart_entry(&err.to_string()) {
                return Ok(());
            }

            Err(format!("Failed to disable autostart: {}", err))
        }
    }
}

pub fn is_autostart_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    let autostart_manager = app.autolaunch();
    match autostart_manager.is_enabled() {
        Ok(enabled) => Ok(enabled),
        // A development build has no installed entry to read, so the lookup
        // fails with "not found" instead of reporting a disabled state.
        Err(err) if is_missing_autostart_entry(&err.to_string()) => Ok(false),
        Err(err) => Err(format!("Failed to check autostart status: {}", err)),
    }
}

/// Windows reports a missing autostart entry as a file-not-found error rather
/// than a negative result. That is not a failure to read the state.
fn is_missing_autostart_entry(message: &str) -> bool {
    message.contains("os error 2") || message.contains("系统找不到指定的文件")
}

#[cfg(test)]
mod tests {
    use super::is_missing_autostart_entry;

    #[test]
    fn user_gets_a_missing_autostart_entry_recognised_in_both_locales() {
        assert!(is_missing_autostart_entry(
            "The system cannot find the file specified. (os error 2)"
        ));
        assert!(is_missing_autostart_entry(
            "系统找不到指定的文件。 (os error 2)"
        ));
    }

    #[test]
    fn user_still_sees_other_autostart_failures() {
        assert!(!is_missing_autostart_entry(
            "Access is denied. (os error 5)"
        ));
    }
}
