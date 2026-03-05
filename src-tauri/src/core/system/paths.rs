// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 应用目录与路径解析能力。

use std::{path::PathBuf, sync::OnceLock};

/// 应用运行期目录枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppDirectory {
    Data,
    Logs,
    Cache,
    CacheIcons,
    Assets,
    AssetsFont,
}

/// 应用基础目录布局统一声明。
///
/// 后续新增目录仅需在此处追加，初始化流程会自动处理。
pub(crate) const APP_DIRECTORY_LAYOUT: &[(AppDirectory, &str, &str)] = &[
    (AppDirectory::Data, "DATA", "data"),
    (AppDirectory::Logs, "LOGS", "logs"),
    (AppDirectory::Cache, "CACHE", "cache"),
    (AppDirectory::CacheIcons, "CACHE_ICONS", "cache/icons"),
    (AppDirectory::Assets, "ASSETS", "assets"),
    (AppDirectory::AssetsFont, "ASSETS_FONT", "assets/font"),
];

/// 解析应用根目录。
///
/// - Debug: 回溯到项目根目录
/// - Release: 取可执行文件同级目录
fn resolve_app_root_directory() -> Result<PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|err| format!("Failed to resolve current exe: {err}"))?
        .parent()
        .ok_or_else(|| "Failed to get executable directory".to_string())?
        .to_path_buf();

    if cfg!(debug_assertions) {
        exe_dir
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "Failed to get project root".to_string())
    } else {
        Ok(exe_dir)
    }
}

/// 获取应用根目录（缓存）。
fn app_root_directory() -> Result<PathBuf, String> {
    static APP_ROOT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    APP_ROOT.get_or_init(resolve_app_root_directory).clone()
}

/// 从统一目录布局中取相对路径。
fn directory_relative_path(directory: AppDirectory) -> Result<&'static str, String> {
    APP_DIRECTORY_LAYOUT
        .iter()
        .find_map(|(kind, _, relative_path)| (*kind == directory).then_some(*relative_path))
        .ok_or_else(|| format!("Directory mapping is missing for {directory:?}"))
}

/// 获取指定目录的绝对路径。
pub fn app_directory_path(directory: AppDirectory) -> Result<PathBuf, String> {
    let root = app_root_directory()?;
    Ok(root.join(directory_relative_path(directory)?))
}

/// 从前端传入的目录键解析目录枚举。
///
/// 内部统一要求 UPPER_SNAKE_CASE（下划线）格式。
pub fn parse_app_directory_key(value: &str) -> Result<AppDirectory, String> {
    let normalized_key = value.trim().to_ascii_uppercase();

    APP_DIRECTORY_LAYOUT
        .iter()
        .find_map(|(directory, key, _)| (*key == normalized_key.as_str()).then_some(*directory))
        .ok_or_else(|| {
            let supported_keys = APP_DIRECTORY_LAYOUT
                .iter()
                .map(|(_, key, _)| *key)
                .collect::<Vec<_>>()
                .join(", ");
            format!("Unsupported app directory '{value}'. Supported: {supported_keys}")
        })
}
