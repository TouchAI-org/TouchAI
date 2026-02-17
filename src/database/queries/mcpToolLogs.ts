// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, count, desc, eq } from 'drizzle-orm';

import { db } from '../index';
import { mcpToolLogs } from '../schema';
import type { McpToolLogCreateData, McpToolLogEntity, McpToolLogUpdateData } from '../types';

/**
 * 根据会话 ID 查找所有工具日志
 */
export const findMcpToolLogsBySessionId = async (sessionId: number): Promise<McpToolLogEntity[]> =>
    db
        .getDb()
        .select()
        .from(mcpToolLogs)
        .where(eq(mcpToolLogs.session_id, sessionId))
        .orderBy(desc(mcpToolLogs.created_at))
        .all();

/**
 * 根据服务器 ID 查找所有工具日志
 */
export const findMcpToolLogsByServerId = async (
    serverId: number,
    options?: { limit?: number; offset?: number }
): Promise<McpToolLogEntity[]> => {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    return db
        .getDb()
        .select()
        .from(mcpToolLogs)
        .where(eq(mcpToolLogs.server_id, serverId))
        .orderBy(desc(mcpToolLogs.created_at))
        .limit(limit)
        .offset(offset)
        .all();
};

/**
 * 根据 tool_call_id 查找工具日志
 */
export const findMcpToolLogByCallId = async (
    toolCallId: string
): Promise<McpToolLogEntity | undefined> =>
    db.getDb().select().from(mcpToolLogs).where(eq(mcpToolLogs.tool_call_id, toolCallId)).get();

/**
 * 根据 ID 查找工具日志
 */
export const findMcpToolLogById = async (id: number): Promise<McpToolLogEntity | undefined> =>
    db.getDb().select().from(mcpToolLogs).where(eq(mcpToolLogs.id, id)).get();

/**
 * 根据消息 ID 查找工具日志
 */
export const findMcpToolLogsByMessageId = async (messageId: number): Promise<McpToolLogEntity[]> =>
    db
        .getDb()
        .select()
        .from(mcpToolLogs)
        .where(eq(mcpToolLogs.message_id, messageId))
        .orderBy(mcpToolLogs.id)
        .all();

/**
 * 根据会话 ID 和迭代次数查找工具日志
 */
export const findMcpToolLogsBySessionIdAndIteration = async (
    sessionId: number,
    iteration: number
): Promise<McpToolLogEntity[]> =>
    db
        .getDb()
        .select()
        .from(mcpToolLogs)
        .where(and(eq(mcpToolLogs.session_id, sessionId), eq(mcpToolLogs.iteration, iteration)))
        .orderBy(desc(mcpToolLogs.created_at))
        .all();

/**
 * 创建 MCP 工具日志
 */
export const createMcpToolLog = async (data: McpToolLogCreateData): Promise<McpToolLogEntity> => {
    const drizzle = db.getDb();
    await drizzle.insert(mcpToolLogs).values(data).run();

    // 使用 last_insert_rowid() 获取刚插入的记录 ID，避免并发插入时取到错误记录
    const [row] = await db.rawQuery<{ id: number }>('SELECT last_insert_rowid() as id');
    if (!row) {
        throw new Error('Failed to create MCP tool log');
    }

    const lastInsert = await drizzle
        .select()
        .from(mcpToolLogs)
        .where(eq(mcpToolLogs.id, row.id))
        .get();

    if (!lastInsert) {
        throw new Error('Failed to create MCP tool log');
    }
    return lastInsert;
};

/**
 * 更新 MCP 工具日志
 */
export const updateMcpToolLog = async (
    id: number,
    data: McpToolLogUpdateData
): Promise<McpToolLogEntity | undefined> => {
    const drizzle = db.getDb();
    await drizzle.update(mcpToolLogs).set(data).where(eq(mcpToolLogs.id, id)).run();

    return db.getDb().select().from(mcpToolLogs).where(eq(mcpToolLogs.id, id)).get();
};

/**
 * 根据 tool_call_id 更新工具日志
 */
export const updateMcpToolLogByCallId = async (
    toolCallId: string,
    data: McpToolLogUpdateData
): Promise<McpToolLogEntity | undefined> => {
    const drizzle = db.getDb();
    await drizzle
        .update(mcpToolLogs)
        .set(data)
        .where(eq(mcpToolLogs.tool_call_id, toolCallId))
        .run();

    return findMcpToolLogByCallId(toolCallId);
};

/**
 * 删除 MCP 工具日志
 */
export const deleteMcpToolLog = async (id: number): Promise<void> => {
    await db.getDb().delete(mcpToolLogs).where(eq(mcpToolLogs.id, id)).run();
};

/**
 * 删除会话的所有工具日志
 */
export const deleteMcpToolLogsBySessionId = async (sessionId: number): Promise<void> => {
    await db.getDb().delete(mcpToolLogs).where(eq(mcpToolLogs.session_id, sessionId)).run();
};

/**
 * 统计 MCP 工具日志数量
 */
export const countMcpToolLogs = async (): Promise<number> => {
    const result = await db.getDb().select({ count: count() }).from(mcpToolLogs).get();

    return result?.count || 0;
};

/**
 * 统计会话的工具日志数量
 */
export const countMcpToolLogsBySessionId = async (sessionId: number): Promise<number> => {
    const result = await db
        .getDb()
        .select({ count: count() })
        .from(mcpToolLogs)
        .where(eq(mcpToolLogs.session_id, sessionId))
        .get();

    return result?.count || 0;
};
