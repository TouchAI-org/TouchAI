// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { McpServerCreateData, McpServerEntity, McpServerUpdateData } from '../types';

/**
 * 查找所有 MCP 服务器
 */
export const findAllMcpServers = async (): Promise<McpServerEntity[]> =>
    native.database.operation<McpServerEntity[]>({
        kind: 'mcp_server_list',
        enabledOnly: false,
    });

/**
 * 查找所有启用的 MCP 服务器
 */
export const findEnabledMcpServers = async (): Promise<McpServerEntity[]> =>
    native.database.operation<McpServerEntity[]>({
        kind: 'mcp_server_list',
        enabledOnly: true,
    });

/**
 * 根据 ID 查找 MCP 服务器
 */
export const findMcpServerById = async (id: number): Promise<McpServerEntity | undefined> =>
    (await native.database.operation<McpServerEntity | null>({
        kind: 'mcp_server_find_by_id',
        id,
    })) ?? undefined;

/**
 * 根据名称查找 MCP 服务器
 */
export const findMcpServerByName = async (name: string): Promise<McpServerEntity | undefined> =>
    (await native.database.operation<McpServerEntity | null>({
        kind: 'mcp_server_find_by_name',
        name,
    })) ?? undefined;

/**
 * 创建 MCP 服务器
 */
export const createMcpServer = async (data: McpServerCreateData): Promise<McpServerEntity> => {
    const createdServer = await native.database.operation<McpServerEntity | null>({
        kind: 'mcp_server_create',
        data: { ...data },
    });

    if (!createdServer) {
        throw new Error('Failed to create MCP server');
    }

    return createdServer;
};

/**
 * 更新 MCP 服务器
 */
export const updateMcpServer = async (
    id: number,
    data: McpServerUpdateData
): Promise<McpServerEntity | undefined> => {
    return (
        (await native.database.operation<McpServerEntity | null>({
            kind: 'mcp_server_update',
            id,
            data: { ...data },
        })) ?? undefined
    );
};

/**
 * 删除 MCP 服务器
 */
export const deleteMcpServer = async (id: number): Promise<void> => {
    await native.database.operation({ kind: 'mcp_server_delete', id });
};

/**
 * 统计 MCP 服务器数量
 */
export const countMcpServers = async (): Promise<number> => {
    return native.database.operation<number>({ kind: 'mcp_server_count' });
};
