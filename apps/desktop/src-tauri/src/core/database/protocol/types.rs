// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 数据库运行时与前端通信的数据结构。

use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};

/// 通用数据库执行方法，对齐前端 Drizzle 代理层的调用语义。
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseQueryMethod {
    Run,
    All,
    Get,
    Values,
}

/// 前端发送到 Rust 数据库运行时的标准查询请求。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryRequest {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<JsonValue>,
    pub method: DatabaseQueryMethod,
}

/// 统一查询响应格式，便于前端驱动同时处理普通查询和事务查询。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseQueryResponse {
    pub rows: Vec<JsonMap<String, JsonValue>>,
    pub rows_affected: u64,
    pub last_insert_id: Option<i64>,
}

/// SQLite 事务开启模式。
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DatabaseTransactionBehavior {
    Deferred,
    Immediate,
    Exclusive,
}

impl DatabaseTransactionBehavior {
    /// 生成对应的 `BEGIN ...` 语句，由运行时统一执行。
    pub fn begin_sql(self) -> &'static str {
        match self {
            Self::Deferred => "BEGIN DEFERRED",
            Self::Immediate => "BEGIN IMMEDIATE",
            Self::Exclusive => "BEGIN EXCLUSIVE",
        }
    }
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
