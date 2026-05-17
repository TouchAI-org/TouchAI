// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! 内置工具原生命令。

use crate::core::built_in_tools::{
    self, BashExecutionRegistry, BuiltInBashExecutionRequest, BuiltInBashExecutionResponse,
};
use tauri::State;

/// 执行内置 Bash 工具请求。
///
/// 命令层保持薄封装，避免把参数校验、平台分支和进程生命周期管理
/// 散落到 Tauri 注册入口；真正的执行流程统一收口到核心层。
///
/// 执行前会自动释放嵌入的 rg 二进制并追加到 PATH，
/// 使模型可以直接在 bash 中调用 `rg`。
#[tauri::command]
pub async fn built_in_tools_execute_bash(
    request: BuiltInBashExecutionRequest,
    registry: State<'_, BashExecutionRegistry>,
) -> Result<BuiltInBashExecutionResponse, String> {
    built_in_tools::execute_bash(request, registry.inner()).await
}

/// 取消一条正在执行中的内置 Bash 请求。
#[tauri::command]
pub fn built_in_tools_cancel_bash(
    execution_id: String,
    registry: State<'_, BashExecutionRegistry>,
) -> Result<bool, String> {
    Ok(registry.cancel(&execution_id))
}
