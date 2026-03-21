// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生命令。

use crate::core::built_in_tools::{
    self, BuiltInBashExecutionRequest, BuiltInBashExecutionResponse,
};

/// 执行内置 Bash 工具请求。
///
/// 命令层保持薄封装，避免把参数校验、平台分支和进程生命周期管理
/// 散落到 Tauri 注册入口；真正的执行流程统一收口到核心层。
#[tauri::command]
pub async fn built_in_tools_execute_bash(
    request: BuiltInBashExecutionRequest,
) -> Result<BuiltInBashExecutionResponse, String> {
    built_in_tools::execute_bash(request).await
}
