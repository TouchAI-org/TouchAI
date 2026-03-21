// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 快速搜索核心能力。
//!
//! 对上层提供统一接口；在 Windows 使用 Everything + 本地缓存，
//! 其他平台返回空结果以保持调用契约稳定。

use std::collections::HashMap;

#[cfg(target_os = "windows")]
use tauri::async_runtime;

mod types;
pub use types::{QuickSearchFileItem, QuickSearchStatus, QuickShortcutItem};

#[cfg(target_os = "windows")]
mod assets;
#[cfg(target_os = "windows")]
mod manager;
#[cfg(target_os = "windows")]
mod provider_everything;

const DEFAULT_LIMIT: usize = 60;
const MAX_LIMIT: usize = 200;
const DEFAULT_ICON_SIZE: u32 = 48;
const MAX_ICON_SIZE: u32 = 256;

/// 搜索快捷项列表（Windows）。
///
/// 对外保持异步接口，但内部切到阻塞线程池执行。
/// 这样前端始终通过同一套异步命令调用，而 Everything IPC / 本地索引扫描
/// 这类阻塞工作不会占住 Tauri 的异步运行时。
#[cfg(target_os = "windows")]
pub async fn quick_search_search_shortcuts(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<QuickShortcutItem>, String> {
    // 限制查询条数，避免前端一次性请求过多结果。
    let normalized_limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    // 搜索过程含阻塞调用，放到阻塞线程池避免卡住异步运行时。
    let shortcuts =
        async_runtime::spawn_blocking(move || manager::search_shortcuts(&query, normalized_limit))
            .await
            .map_err(|err| format!("quick_search_search_shortcuts task join failed: {}", err))?;

    // 记住返回路径，缩略图请求按白名单校验。
    assets::remember_search_paths(&shortcuts);
    Ok(shortcuts)
}

/// 搜索普通文件列表（Windows）。
///
/// `file_search` 走的是直接 Everything 查询，不依赖本地快捷方式索引，
/// 这样内置工具拿到的是“当前文件系统视角”的结果，而不是索引快照的近似值。
#[cfg(target_os = "windows")]
pub async fn quick_search_search_files(
    query: String,
    limit: Option<usize>,
    include_shortcuts: Option<bool>,
) -> Result<Vec<QuickSearchFileItem>, String> {
    let normalized_limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let include_shortcuts = include_shortcuts.unwrap_or(false);
    async_runtime::spawn_blocking(move || {
        manager::search_files(&query, normalized_limit, include_shortcuts)
    })
    .await
    .map_err(|err| format!("quick_search_search_files task join failed: {}", err))?
}

/// 搜索快捷项列表（非 Windows 平台降级实现）。
#[cfg(not(target_os = "windows"))]
pub async fn quick_search_search_shortcuts(
    query: String,
    _limit: Option<usize>,
) -> Result<Vec<QuickShortcutItem>, String> {
    let _ = query;
    Ok(Vec::new())
}

/// 搜索普通文件列表（非 Windows 平台降级实现）。
#[cfg(not(target_os = "windows"))]
pub async fn quick_search_search_files(
    query: String,
    _limit: Option<usize>,
    _include_shortcuts: Option<bool>,
) -> Result<Vec<QuickSearchFileItem>, String> {
    let _ = query;
    Err("Quick search file search is only available on Windows".to_string())
}

/// 获取单个快捷项图标（Windows）。
#[cfg(target_os = "windows")]
pub async fn quick_search_get_shortcut_icon(
    path: String,
    size: Option<u32>,
) -> Result<Option<String>, String> {
    let normalized_size = size.unwrap_or(DEFAULT_ICON_SIZE).clamp(16, MAX_ICON_SIZE);
    async_runtime::spawn_blocking(move || assets::shortcut_icon_data_url(&path, normalized_size))
        .await
        .map_err(|err| format!("quick_search_get_shortcut_icon task join failed: {}", err))?
}

/// 获取单个快捷项图标（非 Windows 平台降级实现）。
#[cfg(not(target_os = "windows"))]
pub async fn quick_search_get_shortcut_icon(
    path: String,
    _size: Option<u32>,
) -> Result<Option<String>, String> {
    let _ = path;
    Ok(None)
}

/// 批量获取快捷项图标（Windows）。
#[cfg(target_os = "windows")]
pub async fn quick_search_get_shortcut_icons(
    paths: Vec<String>,
    size: Option<u32>,
) -> Result<HashMap<String, String>, String> {
    let normalized_size = size.unwrap_or(DEFAULT_ICON_SIZE).clamp(16, MAX_ICON_SIZE);
    async_runtime::spawn_blocking(move || assets::get_shortcut_icons(paths, normalized_size))
        .await
        .map_err(|err| format!("quick_search_get_shortcut_icons task join failed: {}", err))?
}

/// 批量获取快捷项图标（非 Windows 平台降级实现）。
#[cfg(not(target_os = "windows"))]
pub async fn quick_search_get_shortcut_icons(
    paths: Vec<String>,
    _size: Option<u32>,
) -> Result<HashMap<String, String>, String> {
    let _ = paths;
    Ok(HashMap::new())
}

/// 批量获取图片缩略图（Windows）。
#[cfg(target_os = "windows")]
pub async fn quick_search_get_image_thumbnails(
    paths: Vec<String>,
    size: Option<u32>,
) -> Result<HashMap<String, String>, String> {
    let normalized_size = size.unwrap_or(DEFAULT_ICON_SIZE).clamp(16, MAX_ICON_SIZE);
    async_runtime::spawn_blocking(move || assets::get_image_thumbnails(paths, normalized_size))
        .await
        .map_err(|err| {
            format!(
                "quick_search_get_image_thumbnails task join failed: {}",
                err
            )
        })?
}

/// 批量获取图片缩略图（非 Windows 平台降级实现）。
#[cfg(not(target_os = "windows"))]
pub async fn quick_search_get_image_thumbnails(
    paths: Vec<String>,
    _size: Option<u32>,
) -> Result<HashMap<String, String>, String> {
    let _ = paths;
    Ok(HashMap::new())
}

/// 预热/刷新索引（Windows）。
#[cfg(target_os = "windows")]
pub fn quick_search_prepare_index(force: Option<bool>) -> Result<(), String> {
    manager::prepare_index(force.unwrap_or(false))
}

/// 预热/刷新索引（非 Windows 平台降级实现）。
#[cfg(not(target_os = "windows"))]
pub fn quick_search_prepare_index(force: Option<bool>) -> Result<(), String> {
    let _ = force;
    Ok(())
}

/// 获取快速搜索当前运行状态（Windows）。
#[cfg(target_os = "windows")]
pub fn quick_search_get_status() -> QuickSearchStatus {
    manager::get_status()
}

/// 获取快速搜索当前运行状态（非 Windows 平台降级实现）。
#[cfg(not(target_os = "windows"))]
pub fn quick_search_get_status() -> QuickSearchStatus {
    QuickSearchStatus {
        provider: "unavailable".to_string(),
        db_loaded: false,
        index_warmed: false,
        last_refresh_ms: None,
        last_error: Some("Quick search is only available on Windows".to_string()),
    }
}
