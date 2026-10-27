// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! MCP 进程管理命令。

use crate::core::mcp::{
    McpClientManager, McpServerConfig, McpToolCallResponse, McpToolDefinition, ServerStatusInfo,
};
use crate::core::observability::trace::with_traceparent;
use tauri::State;

// ===== MCP 客户端命令 =====

#[tauri::command]
pub async fn mcp_connect_server(
    client_manager: State<'_, McpClientManager>,
    config: McpServerConfig,
    traceparent: Option<String>,
) -> Result<(), String> {
    with_traceparent(
        traceparent,
        "mcp.connect",
        client_manager.connect_server(config),
    )
    .await
}

#[tauri::command]
pub async fn mcp_disconnect_server(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
    traceparent: Option<String>,
) -> Result<(), String> {
    with_traceparent(
        traceparent,
        "mcp.disconnect",
        client_manager.disconnect_server(server_id),
    )
    .await
}

#[tauri::command]
pub async fn mcp_list_tools(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
    traceparent: Option<String>,
) -> Result<Vec<McpToolDefinition>, String> {
    with_traceparent(
        traceparent,
        "mcp.list_tools",
        client_manager.list_tools(server_id),
    )
    .await
}

#[tauri::command]
pub async fn mcp_call_tool(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
    tool_name: String,
    arguments: serde_json::Value,
    timeout_ms: Option<u64>,
    traceparent: Option<String>,
) -> Result<McpToolCallResponse, String> {
    with_traceparent(
        traceparent,
        "mcp.call_tool",
        client_manager.call_tool(server_id, tool_name, arguments, timeout_ms),
    )
    .await
}

#[tauri::command]
pub async fn mcp_get_client_status(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
) -> Result<ServerStatusInfo, String> {
    client_manager.get_server_status(server_id).await
}

/// 获取全部 MCP 客户端状态。
#[tauri::command]
pub async fn mcp_get_all_client_statuses(
    client_manager: State<'_, McpClientManager>,
) -> Result<Vec<ServerStatusInfo>, String> {
    // 统一走 Result 语义，保持命令层错误处理一致。
    client_manager.get_all_server_statuses_result().await
}

#[tauri::command]
pub async fn mcp_disconnect_all(client_manager: State<'_, McpClientManager>) -> Result<(), String> {
    client_manager.disconnect_all().await
}
