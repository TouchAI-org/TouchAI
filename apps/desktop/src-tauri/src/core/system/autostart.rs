// Copyright (c) 2026. 千诚. Licensed under GPL v3

//! 开机自启动模块
//!
//! 负责管理应用的开机自启动功能

use std::fmt::Display;

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
    map_autostart_status(autostart_manager.is_enabled())
}

fn map_autostart_status<E: Display>(status: Result<bool, E>) -> Result<bool, String> {
    match status {
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
    // Match the whole code so a lookup failure such as `(os error 21)` is not
    // reported as a missing entry.
    message.contains("(os error 2)") || message.contains("系统找不到指定的文件")
}

#[cfg(test)]
mod tests {
    use super::map_autostart_status;

    #[test]
    fn user_gets_known_autostart_statuses_preserved() {
        assert_eq!(map_autostart_status(Ok::<_, &str>(true)), Ok(true));
        assert_eq!(map_autostart_status(Ok::<_, &str>(false)), Ok(false));
    }

    #[test]
    fn user_gets_a_missing_autostart_entry_as_disabled() {
        assert_eq!(
            map_autostart_status(Err::<bool, _>(
                "The system cannot find the file specified. (os error 2)"
            )),
            Ok(false)
        );
        assert_eq!(
            map_autostart_status(Err::<bool, _>("系统找不到指定的文件。 (os error 2)")),
            Ok(false)
        );
    }

    #[test]
    fn user_still_sees_other_autostart_failures() {
        assert_eq!(
            map_autostart_status(Err::<bool, _>("Access is denied. (os error 5)")),
            Err("Failed to check autostart status: Access is denied. (os error 5)".to_string())
        );
        assert_eq!(
            map_autostart_status(Err::<bool, _>("The directory is not empty. (os error 21)")),
            Err(
                "Failed to check autostart status: The directory is not empty. (os error 21)"
                    .to_string()
            )
        );
    }
}
