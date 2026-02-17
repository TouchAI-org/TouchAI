// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * MCP Native Commands
 *
 * 封装所有 MCP 相关的 Rust 后端命令
 */

import { invoke } from '@tauri-apps/api/core';

// ===== Types =====

export type McpTransportType = 'stdio' | 'sse' | 'http';

export interface McpServerConfig {
    id: number;
    name: string;
    transport_type: McpTransportType;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    enabled: boolean;
    tool_timeout: number;
}

export interface McpToolDefinition {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface McpToolContent {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mime_type?: string;
    uri?: string;
    blob?: string;
}

export interface McpToolCallResponse {
    success: boolean;
    content: McpToolContent[];
    is_error: boolean;
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpServerStatusInfo {
    server_id: number;
    status: McpServerStatus;
    error?: string;
    version?: string;
}

// ===== Commands =====

/**
 * 连接到 MCP 服务器
 */
export async function connectServer(config: McpServerConfig): Promise<void> {
    return invoke('mcp_connect_server', { config });
}

/**
 * 断开 MCP 服务器连接
 */
export async function disconnectServer(serverId: number): Promise<void> {
    return invoke('mcp_disconnect_server', { serverId });
}

/**
 * 列出服务器的所有工具
 */
export async function listTools(serverId: number): Promise<McpToolDefinition[]> {
    return invoke('mcp_list_tools', { serverId });
}

/**
 * 调用 MCP 工具
 */
export async function callTool(
    serverId: number,
    toolName: string,
    args: Record<string, unknown>
): Promise<McpToolCallResponse> {
    return invoke('mcp_call_tool', {
        serverId,
        toolName,
        arguments: args,
    });
}

/**
 * 获取服务器状态
 */
export async function getServerStatus(serverId: number): Promise<McpServerStatusInfo> {
    return invoke('mcp_get_client_status', { serverId });
}

/**
 * 批量获取所有服务器状态
 */
export async function getAllServerStatuses(): Promise<McpServerStatusInfo[]> {
    return invoke('mcp_get_all_client_statuses');
}

/**
 * 断开所有服务器连接
 */
export async function disconnectAll(): Promise<void> {
    return invoke('mcp_disconnect_all');
}
