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
    await db.select().from(mcpToolLogs).where(eq(mcpToolLogs.tool_call_id, toolCallId)).get();

/**
 * 根据 ID 查找工具日志
 */
export const findMcpToolLogById = async (id: number): Promise<McpToolLogEntity | undefined> =>
    await db.select().from(mcpToolLogs).where(eq(mcpToolLogs.id, id)).get();

/**
 * 根据消息 ID 查找工具日志
 */
export const findMcpToolLogsByMessageId = async (messageId: number): Promise<McpToolLogEntity[]> =>
    db
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
        .select()
        .from(mcpToolLogs)
        .where(and(eq(mcpToolLogs.session_id, sessionId), eq(mcpToolLogs.iteration, iteration)))
        .orderBy(desc(mcpToolLogs.created_at))
        .all();

/**
 * 创建 MCP 工具日志
 */
export const createMcpToolLog = async (data: McpToolLogCreateData): Promise<McpToolLogEntity> => {
    const createdToolLog = await db.insert(mcpToolLogs).values(data).returning().get();

    if (!createdToolLog || createdToolLog.id === undefined) {
        throw new Error('Failed to create MCP tool log');
    }
    return createdToolLog;
};

/**
 * 更新 MCP 工具日志
 */
export const updateMcpToolLog = async (
    id: number,
    data: McpToolLogUpdateData
): Promise<McpToolLogEntity | undefined> => {
    const updatedToolLog = await db
        .update(mcpToolLogs)
        .set(data)
        .where(eq(mcpToolLogs.id, id))
        .returning()
        .get();

    return updatedToolLog && updatedToolLog.id !== undefined ? updatedToolLog : undefined;
};

/**
 * 根据 tool_call_id 更新工具日志
 */
export const updateMcpToolLogByCallId = async (
    toolCallId: string,
    data: McpToolLogUpdateData
): Promise<McpToolLogEntity | undefined> => {
    const updatedToolLog = await db
        .update(mcpToolLogs)
        .set(data)
        .where(eq(mcpToolLogs.tool_call_id, toolCallId))
        .returning()
        .get();

    return updatedToolLog && updatedToolLog.id !== undefined ? updatedToolLog : undefined;
};

/**
 * 删除 MCP 工具日志
 */
export const deleteMcpToolLog = async (id: number): Promise<void> => {
    await db.delete(mcpToolLogs).where(eq(mcpToolLogs.id, id)).run();
};

/**
 * 删除会话的所有工具日志
 */
export const deleteMcpToolLogsBySessionId = async (sessionId: number): Promise<void> => {
    await db.delete(mcpToolLogs).where(eq(mcpToolLogs.session_id, sessionId)).run();
};

/**
 * 统计 MCP 工具日志数量
 */
export const countMcpToolLogs = async (): Promise<number> => {
    const result = await db.select({ count: count() }).from(mcpToolLogs).get();

    return result?.count || 0;
};

/**
 * 统计会话的工具日志数量
 */
export const countMcpToolLogsBySessionId = async (sessionId: number): Promise<number> => {
    const result = await db
        .select({ count: count() })
        .from(mcpToolLogs)
        .where(eq(mcpToolLogs.session_id, sessionId))
        .get();

    return result?.count || 0;
};
