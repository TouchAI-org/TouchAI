// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 快速搜索对外传输类型定义。

use serde::Serialize;

/// 前端展示用的快捷项。
#[derive(Debug, Clone, Serialize)]
pub struct QuickShortcutItem {
    /// 展示名称。
    pub name: String,
    /// 文件或快捷方式绝对路径。
    pub path: String,
    /// 来源分类（例如 `start_menu_user`、`desktop_user`、`file`）。
    pub source: String,
}

/// 内置工具使用的文件搜索结果。
#[derive(Debug, Clone, Serialize)]
pub struct QuickSearchFileItem {
    /// 展示名称。
    pub name: String,
    /// 匹配到的绝对路径。
    pub path: String,
}

/// 分页搜索结果。
#[derive(Debug, Clone, Serialize)]
pub struct QuickSearchResult {
    /// 匹配的快捷方式列表（仅 page=0 时非空）。
    pub shortcuts: Vec<QuickShortcutItem>,
    /// 当前页的文件结果。
    pub files: Vec<QuickShortcutItem>,
    /// 去重后的文件结果总数（用于分页）。
    pub total_files: usize,
    /// Everything 报告的匹配总数（用于状态栏显示）。
    pub total_results: u32,
    /// 下次 loadMore 应传回的 Everything 偏移量。
    pub next_offset: u32,
}

/// 快速搜索运行时状态快照。
#[derive(Debug, Clone, Serialize)]
pub struct QuickSearchStatus {
    /// 当前检索提供者标识。
    pub provider: String,
    /// Everything 数据库是否完成加载。
    pub db_loaded: bool,
    /// 索引是否完成至少一次预热。
    pub index_warmed: bool,
    /// 最近一次刷新耗时（毫秒）。
    pub last_refresh_ms: Option<u64>,
    /// 最近一次错误信息（若存在）。
    pub last_error: Option<String>,
}
