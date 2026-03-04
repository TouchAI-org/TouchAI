// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! Quick Search 对外传输类型定义。

use serde::Serialize;

/// 前端展示用的快捷项。
#[derive(Debug, Clone, Serialize)]
pub struct QuickShortcutItem {
    /// 展示名称。
    pub name: String,
    /// 文件或快捷方式绝对路径。
    pub path: String,
    /// 来源分类（如 start_menu_user / desktop_user / file）。
    pub source: String,
}

/// Quick Search 运行时状态快照。
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
