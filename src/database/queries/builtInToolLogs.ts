// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { count, desc, eq } from 'drizzle-orm';

import { db } from '../index';
import { builtInToolLogs } from '../schema';
import type {
    BuiltInToolLogCreateData,
    BuiltInToolLogEntity,
    BuiltInToolLogUpdateData,
} from '../types';

/**
 * 根据工具 ID 查询日志。
 */
export const findBuiltInToolLogsByToolId = async (
    toolId: string,
    options?: { limit?: number; offset?: number }
): Promise<BuiltInToolLogEntity[]> => {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    return db
        .getDb()
        .select()
        .from(builtInToolLogs)
        .where(eq(builtInToolLogs.tool_id, toolId))
        .orderBy(desc(builtInToolLogs.created_at))
        .limit(limit)
        .offset(offset)
        .all();
};

/**
 * 根据会话 ID 查询内置工具日志。
 */
export const findBuiltInToolLogsBySessionId = async (
    sessionId: number
): Promise<BuiltInToolLogEntity[]> =>
    db
        .getDb()
        .select()
        .from(builtInToolLogs)
        .where(eq(builtInToolLogs.session_id, sessionId))
        .orderBy(desc(builtInToolLogs.created_at))
        .all();

/**
 * 根据 tool_call_id 查询日志。
 */
export const findBuiltInToolLogByCallId = async (
    toolCallId: string
): Promise<BuiltInToolLogEntity | undefined> =>
    db
        .getDb()
        .select()
        .from(builtInToolLogs)
        .where(eq(builtInToolLogs.tool_call_id, toolCallId))
        .get();

/**
 * 创建日志。
 */
export const createBuiltInToolLog = async (
    data: BuiltInToolLogCreateData
): Promise<BuiltInToolLogEntity> => {
    const createdToolLog = await db.getDb().insert(builtInToolLogs).values(data).returning().get();

    if (!createdToolLog || createdToolLog.id === undefined) {
        throw new Error('Failed to create built-in tool log');
    }

    return createdToolLog;
};

/**
 * 根据 tool_call_id 更新日志。
 */
export const updateBuiltInToolLogByCallId = async (
    toolCallId: string,
    data: BuiltInToolLogUpdateData
): Promise<BuiltInToolLogEntity | undefined> => {
    const updatedToolLog = await db
        .getDb()
        .update(builtInToolLogs)
        .set(data)
        .where(eq(builtInToolLogs.tool_call_id, toolCallId))
        .returning()
        .get();

    return updatedToolLog && updatedToolLog.id !== undefined ? updatedToolLog : undefined;
};

/**
 * 统计工具日志数量。
 */
export const countBuiltInToolLogs = async (): Promise<number> => {
    const result = await db.getDb().select({ count: count() }).from(builtInToolLogs).get();
    return result?.count || 0;
};
