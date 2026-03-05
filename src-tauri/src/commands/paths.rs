// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用目录相关命令。

use crate::core::system::paths;

/// 获取指定应用目录的绝对路径。
///
/// `directory` 支持：
/// - `DATA`
/// - `LOGS`
/// - `CACHE`
/// - `CACHE_ICONS`
/// - `ASSETS`
/// - `ASSETS_FONT`
#[tauri::command]
pub fn get_app_directory_path(directory: String) -> Result<String, String> {
    let directory = paths::parse_app_directory_key(&directory)?;
    paths::app_directory_path(directory).map(|path| path.to_string_lossy().to_string())
}
