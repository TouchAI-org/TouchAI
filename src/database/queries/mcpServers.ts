// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, eq } from 'drizzle-orm';

import { db } from '../index';
import { mcpServers } from '../schema';
import type { McpServerCreateData, McpServerEntity, McpServerUpdateData } from '../types';

/**
 * 查找所有 MCP 服务器
 */
export const findAllMcpServers = async (): Promise<McpServerEntity[]> =>
    await db.select().from(mcpServers).orderBy(asc(mcpServers.name)).all();

/**
 * 查找所有启用的 MCP 服务器
 */
export const findEnabledMcpServers = async (): Promise<McpServerEntity[]> =>
    db
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.enabled, 1))
        .orderBy(asc(mcpServers.name))
        .all();

/**
 * 根据 ID 查找 MCP 服务器
 */
export const findMcpServerById = async (id: number): Promise<McpServerEntity | undefined> =>
    await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();

/**
 * 根据名称查找 MCP 服务器
 */
export const findMcpServerByName = async (name: string): Promise<McpServerEntity | undefined> =>
    await db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();

/**
 * 创建 MCP 服务器
 */
export const createMcpServer = async (data: McpServerCreateData): Promise<McpServerEntity> => {
    const createdServer = await db.insert(mcpServers).values(data).returning().get();

    if (!createdServer || createdServer.id === undefined) {
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
    const updatedServer = await db
        .update(mcpServers)
        .set(data)
        .where(eq(mcpServers.id, id))
        .returning()
        .get();

    return updatedServer && updatedServer.id !== undefined ? updatedServer : undefined;
};

/**
 * 删除 MCP 服务器
 */
export const deleteMcpServer = async (id: number): Promise<void> => {
    await db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
};

/**
 * 统计 MCP 服务器数量
 */
export const countMcpServers = async (): Promise<number> => {
    const result = await db.select({ count: count() }).from(mcpServers).get();

    return result?.count || 0;
};
