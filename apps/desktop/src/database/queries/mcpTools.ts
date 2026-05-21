// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, asc, count, eq } from 'drizzle-orm';

import { db } from '../index';
import { mcpTools } from '../schema';
import type { McpToolCreateData, McpToolEntity, McpToolUpdateData } from '../types';

/**
 * 查找所有 MCP 工具
 */
export const findAllMcpTools = async (): Promise<McpToolEntity[]> =>
    await db.select().from(mcpTools).orderBy(asc(mcpTools.name)).all();

/**
 * 根据服务器 ID 查找所有工具
 */
export const findMcpToolsByServerId = async (serverId: number): Promise<McpToolEntity[]> =>
    db
        .select()
        .from(mcpTools)
        .where(eq(mcpTools.server_id, serverId))
        .orderBy(asc(mcpTools.name))
        .all();

/**
 * 根据服务器 ID 查找所有启用的工具
 */
export const findEnabledMcpToolsByServerId = async (serverId: number): Promise<McpToolEntity[]> =>
    db
        .select()
        .from(mcpTools)
        .where(and(eq(mcpTools.server_id, serverId), eq(mcpTools.enabled, 1)))
        .orderBy(asc(mcpTools.name))
        .all();

/**
 * 根据 ID 查找 MCP 工具
 */
export const findMcpToolById = async (id: number): Promise<McpToolEntity | undefined> =>
    await db.select().from(mcpTools).where(eq(mcpTools.id, id)).get();

/**
 * 根据服务器 ID 和工具名称查找工具
 */
export const findMcpToolByServerIdAndName = async (
    serverId: number,
    name: string
): Promise<McpToolEntity | undefined> =>
    db
        .select()
        .from(mcpTools)
        .where(and(eq(mcpTools.server_id, serverId), eq(mcpTools.name, name)))
        .get();

/**
 * 创建 MCP 工具
 */
export const createMcpTool = async (data: McpToolCreateData): Promise<McpToolEntity> => {
    const createdTool = await db.insert(mcpTools).values(data).returning().get();

    if (!createdTool || createdTool.id === undefined) {
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
    const updatedTool = await db
        .update(mcpTools)
        .set(data)
        .where(eq(mcpTools.id, id))
        .returning()
        .get();

    return updatedTool && updatedTool.id !== undefined ? updatedTool : undefined;
};

/**
 * 删除 MCP 工具
 */
export const deleteMcpTool = async (id: number): Promise<void> => {
    await db.delete(mcpTools).where(eq(mcpTools.id, id)).run();
};

/**
 * 删除服务器的所有工具
 */
export const deleteMcpToolsByServerId = async (serverId: number): Promise<void> => {
    await db.delete(mcpTools).where(eq(mcpTools.server_id, serverId)).run();
};

/**
 * 统计 MCP 工具数量
 */
export const countMcpTools = async (): Promise<number> => {
    const result = await db.select({ count: count() }).from(mcpTools).get();

    return result?.count || 0;
};

/**
 * 统计服务器的工具数量
 */
export const countMcpToolsByServerId = async (serverId: number): Promise<number> => {
    const result = await db
        .select({ count: count() })
        .from(mcpTools)
        .where(eq(mcpTools.server_id, serverId))
        .get();

    return result?.count || 0;
};
