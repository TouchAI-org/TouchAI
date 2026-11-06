// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { McpToolCreateData, McpToolEntity, McpToolUpdateData } from '../types';

/**
 * 查找所有 MCP 工具
 */
export const findAllMcpTools = async (): Promise<McpToolEntity[]> =>
    native.database.operation<McpToolEntity[]>({
        kind: 'mcp_tool_list',
        enabledOnly: false,
    });

/**
 * 根据服务器 ID 查找所有工具
 */
export const findMcpToolsByServerId = async (serverId: number): Promise<McpToolEntity[]> =>
    native.database.operation<McpToolEntity[]>({
        kind: 'mcp_tool_list',
        serverId,
        enabledOnly: false,
    });

/**
 * 根据服务器 ID 查找所有启用的工具
 */
export const findEnabledMcpToolsByServerId = async (serverId: number): Promise<McpToolEntity[]> =>
    native.database.operation<McpToolEntity[]>({
        kind: 'mcp_tool_list',
        serverId,
        enabledOnly: true,
    });

/**
 * 根据 ID 查找 MCP 工具
 */
export const findMcpToolById = async (id: number): Promise<McpToolEntity | undefined> =>
    (await native.database.operation<McpToolEntity | null>({
        kind: 'mcp_tool_find_by_id',
        id,
    })) ?? undefined;

/**
 * 根据服务器 ID 和工具名称查找工具
 */
export const findMcpToolByServerIdAndName = async (
    serverId: number,
    name: string
): Promise<McpToolEntity | undefined> =>
    (await native.database.operation<McpToolEntity | null>({
        kind: 'mcp_tool_find_by_server_and_name',
        serverId,
        name,
    })) ?? undefined;

/**
 * 创建 MCP 工具
 */
export const createMcpTool = async (data: McpToolCreateData): Promise<McpToolEntity> => {
    const createdTool = await native.database.operation<McpToolEntity | null>({
        kind: 'mcp_tool_create',
        data: { ...data },
    });

    if (!createdTool) {
        throw new Error('Failed to create MCP tool');
    }

    return createdTool;
};

/**
 * 更新 MCP 工具
 */
export const updateMcpTool = async (
    id: number,
    data: McpToolUpdateData
): Promise<McpToolEntity | undefined> => {
    return (
        (await native.database.operation<McpToolEntity | null>({
            kind: 'mcp_tool_update',
            id,
            data: { ...data },
        })) ?? undefined
    );
};

/**
 * 删除 MCP 工具
 */
export const deleteMcpTool = async (id: number): Promise<void> => {
    await native.database.operation({ kind: 'mcp_tool_delete', id });
};

/**
 * 删除服务器的所有工具
 */
export const deleteMcpToolsByServerId = async (serverId: number): Promise<void> => {
    await native.database.operation({ kind: 'mcp_tool_delete_by_server', serverId });
};

/**
 * 统计 MCP 工具数量
 */
export const countMcpTools = async (): Promise<number> => {
    return native.database.operation<number>({ kind: 'mcp_tool_count' });
};

/**
 * 统计服务器的工具数量
 */
export const countMcpToolsByServerId = async (serverId: number): Promise<number> => {
    return native.database.operation<number>({ kind: 'mcp_tool_count', serverId });
};
