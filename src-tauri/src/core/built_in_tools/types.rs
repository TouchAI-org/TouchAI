// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生类型定义。

use serde::{Deserialize, Serialize};

/// 内置 Bash 工具的执行请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInBashExecutionRequest {
    /// 用户或上层工具网关要执行的 PowerShell 命令文本。
    pub command: String,
    /// 可选工作目录。留空时沿用当前进程工作目录。
    pub working_directory: Option<String>,
    /// 可选超时，单位毫秒。
    pub timeout_ms: Option<u64>,
}

/// 内置 Bash 工具的结构化执行结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInBashExecutionResponse {
    /// 原始命令，便于审计和前端日志展示。
    pub command: String,
    /// 当前实现固定为 PowerShell，方便前端按命令环境类型展示。
    pub shell: String,
    /// 实际使用的工作目录。
    pub working_directory: Option<String>,
    /// 进程退出码；被超时终止时通常为 `None`。
    pub exit_code: Option<i32>,
    /// 是否成功退出。超时或非 0 退出码都视为 false。
    pub success: bool,
    /// 是否因超时中止。
    pub timed_out: bool,
    /// 总耗时，单位毫秒。
    pub duration_ms: u64,
    /// 标准输出全文。
    pub stdout: String,
    /// 标准错误全文。
    pub stderr: String,
    /// 为了避免前端重复拼接，原生层直接给出组合输出。
    pub combined_output: String,
}
