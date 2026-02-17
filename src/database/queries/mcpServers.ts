// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, eq } from 'drizzle-orm';

import { db } from '../index';
import { mcpServers } from '../schema';
import type { McpServerCreateData, McpServerEntity, McpServerUpdateData } from '../types';

/**
 * 查找所有 MCP 服务器
 */
export const findAllMcpServers = async (): Promise<McpServerEntity[]> =>
    db.getDb().select().from(mcpServers).orderBy(asc(mcpServers.name)).all();

/**
 * 查找所有启用的 MCP 服务器
 */
export const findEnabledMcpServers = async (): Promise<McpServerEntity[]> =>
    db
        .getDb()
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.enabled, 1))
        .orderBy(asc(mcpServers.name))
        .all();

/**
 * 根据 ID 查找 MCP 服务器
 */
export const findMcpServerById = async (id: number): Promise<McpServerEntity | undefined> =>
    db.getDb().select().from(mcpServers).where(eq(mcpServers.id, id)).get();

/**
 * 根据名称查找 MCP 服务器
 */
export const findMcpServerByName = async (name: string): Promise<McpServerEntity | undefined> =>
    db.getDb().select().from(mcpServers).where(eq(mcpServers.name, name)).get();

/**
 * 创建 MCP 服务器
 */
export const createMcpServer = async (data: McpServerCreateData): Promise<McpServerEntity> => {
    const drizzle = db.getDb();
    await drizzle.insert(mcpServers).values(data).run();

    // 使用 last_insert_rowid() 获取刚插入的记录 ID，避免并发插入时取到错误记录
    const [row] = await db.rawQuery<{ id: number }>('SELECT last_insert_rowid() as id');
    if (!row) {
        throw new Error('Failed to create MCP server');
    }

    const lastInsert = await drizzle
        .select()
        .from(mcpServers)
        .where(eq(mcpServers.id, row.id))
        .get();

    if (!lastInsert) {
        throw new Error('Failed to create MCP server');
    }
    return lastInsert;
};

/**
 * 更新 MCP 服务器
 */
export const updateMcpServer = async (
    id: number,
    data: McpServerUpdateData
): Promise<McpServerEntity | undefined> => {
    const drizzle = db.getDb();
    await drizzle.update(mcpServers).set(data).where(eq(mcpServers.id, id)).run();

    return findMcpServerById(id);
};

/**
 * 删除 MCP 服务器
 */
export const deleteMcpServer = async (id: number): Promise<void> => {
    await db.getDb().delete(mcpServers).where(eq(mcpServers.id, id)).run();
};

/**
 * 统计 MCP 服务器数量
 */
export const countMcpServers = async (): Promise<number> => {
    const result = await db.getDb().select({ count: count() }).from(mcpServers).get();

    return result?.count || 0;
};
