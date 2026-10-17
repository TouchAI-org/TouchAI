// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生类型定义。

use serde::{Deserialize, Serialize};

/// 内置 Bash 工具的执行请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInBashExecutionRequest {
    /// 本次执行的唯一标识，用于后续取消。
    pub execution_id: String,
    /// 用户或上层工具网关要执行的 PowerShell 命令文本。
    pub command: String,
    /// 可选工作目录。留空时沿用当前进程工作目录。
    pub working_directory: Option<String>,
    /// 可选超时，单位毫秒。
    pub timeout_ms: Option<u64>,
    /// 是否启用输出压缩：执行前自动为命令添加压缩前缀以精简输出。
    #[serde(default)]
    pub compact_output: bool,
    /// 是否跳过压缩直接返回原始输出。为 true 时不走 rtk。
    #[serde(default)]
    pub raw_output: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltInBashStreamChunk {
    pub execution_id: String,
    pub stream: BuiltInBashStreamChannel,
    pub chunk: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BuiltInBashEvent {
    Chunk {
        execution_id: String,
        stream: BuiltInBashStreamChannel,
        chunk: String,
    },
    Completed {
        execution_id: String,
        response: BuiltInBashExecutionResponse,
    },
    Failed {
        execution_id: String,
        error: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuiltInBashStreamChannel {
    Stdout,
    Stderr,
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
    /// 是否因外部取消请求而中止。
    pub cancelled: bool,
    /// 总耗时，单位毫秒。
    pub duration_ms: u64,
    /// 标准输出全文。
    pub stdout: String,
    /// 标准错误全文。
    pub stderr: String,
    /// 为了避免前端重复拼接，原生层直接给出组合输出。
    pub combined_output: String,
    /// 输出是否经过 rtk 压缩。
    #[serde(default)]
    pub compressed: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_bash_chunk_events_with_camel_case_fields() {
        let value = serde_json::to_value(BuiltInBashEvent::Chunk {
            execution_id: "exec-1".to_string(),
            stream: BuiltInBashStreamChannel::Stdout,
            chunk: "alpha".to_string(),
        })
        .expect("event should serialize");

        assert_eq!(
            value,
            serde_json::json!({
                "kind": "chunk",
                "executionId": "exec-1",
                "stream": "stdout",
                "chunk": "alpha",
            })
        );
    }
}
