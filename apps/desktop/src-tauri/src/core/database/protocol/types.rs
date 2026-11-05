// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时与前端通信的数据结构。

use serde::Deserialize;

/// 导出数据库备份请求。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupExportRequest {
    pub target_path: String,
}

/// 备份导入模式。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseImportMode {
    ChatOnly,
    Full,
}

/// 备份导入请求。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseImportRequest {
    pub source_path: String,
    pub mode: DatabaseImportMode,
}
