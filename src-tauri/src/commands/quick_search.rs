// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 快速搜索命令。

use std::collections::HashMap;

use crate::core::search::{self, QuickSearchFileItem, QuickSearchStatus, QuickShortcutItem};

/// 搜索快捷项（前端主查询入口）。
#[tauri::command]
pub async fn quick_search_search_shortcuts(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<QuickShortcutItem>, String> {
    search::quick_search_search_shortcuts(query, limit).await
}

/// 搜索普通文件（内置 `file_search` 工具入口）。
#[tauri::command]
pub async fn quick_search_search_files(
    query: String,
    limit: Option<usize>,
    include_shortcuts: Option<bool>,
) -> Result<Vec<QuickSearchFileItem>, String> {
    search::quick_search_search_files(query, limit, include_shortcuts).await
}

/// 获取单个快捷项图标。
#[tauri::command]
pub async fn quick_search_get_shortcut_icon(
    path: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    search::quick_search_get_shortcut_icon(path, size).await
}

/// 批量获取快捷项图标。
#[tauri::command]
pub async fn quick_search_get_shortcut_icons(
    paths: Vec<String>,
    size: Option<u32>,
) -> Result<HashMap<String, String>, String> {
    search::quick_search_get_shortcut_icons(paths, size).await
}

/// 批量获取图片缩略图（带白名单校验）。
#[tauri::command]
pub async fn quick_search_get_image_thumbnails(
    paths: Vec<String>,
    size: Option<u32>,
) -> Result<HashMap<String, String>, String> {
    search::quick_search_get_image_thumbnails(paths, size).await
}

/// 准备/刷新索引。
#[tauri::command]
pub fn quick_search_prepare_index(force: Option<bool>) -> Result<(), String> {
    // 默认按增量策略刷新；仅在显式 force 时触发强制刷新。
    search::quick_search_prepare_index(force)
}

/// 获取当前快速搜索运行状态。
#[tauri::command]
pub fn quick_search_get_status() -> QuickSearchStatus {
    search::quick_search_get_status()
}
