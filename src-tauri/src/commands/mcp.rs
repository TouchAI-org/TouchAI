// Copyright (c) 2026. 千诚. Licensed under GPL v3.

//! MCP 进程管理命令。

use crate::core::mcp::{
    McpClientManager, McpServerConfig, McpToolCallResponse, McpToolDefinition, ServerStatusInfo,
};
use tauri::State;

// ===== MCP 客户端命令 =====

#[tauri::command]
pub async fn mcp_connect_server(
    client_manager: State<'_, McpClientManager>,
    config: McpServerConfig,
) -> Result<(), String> {
    client_manager.connect_server(config).await
}

#[tauri::command]
pub async fn mcp_disconnect_server(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
) -> Result<(), String> {
    client_manager.disconnect_server(server_id).await
}

#[tauri::command]
pub async fn mcp_list_tools(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
) -> Result<Vec<McpToolDefinition>, String> {
    client_manager.list_tools(server_id).await
}

#[tauri::command]
pub async fn mcp_call_tool(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<McpToolCallResponse, String> {
    client_manager
        .call_tool(server_id, tool_name, arguments)
        .await
}

#[tauri::command]
pub async fn mcp_get_client_status(
    client_manager: State<'_, McpClientManager>,
    server_id: i64,
) -> Result<ServerStatusInfo, String> {
    client_manager.get_server_status(server_id).await
}

#[tauri::command]
pub async fn mcp_get_all_client_statuses(
    client_manager: State<'_, McpClientManager>,
) -> Result<Vec<ServerStatusInfo>, String> {
    Ok(client_manager.get_all_server_statuses().await)
}

#[tauri::command]
pub async fn mcp_disconnect_all(client_manager: State<'_, McpClientManager>) -> Result<(), String> {
    client_manager.disconnect_all().await
}
