// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, desc, eq, or } from 'drizzle-orm';

import { db } from '../index';
import { mcpToolLogs, messages } from '../schema';
import type { MessageCreateData, MessageEntity } from '../types';

export interface MessageRow extends MessageEntity {
    tool_call_id: string | null;
    tool_name: string | null;
    tool_input: string | null;
    tool_log_ref_id: number | null;
}

/**
 * 根据会话 ID 查找所有消息（LEFT JOIN mcp_tool_logs）。
 *
 * 一条 tool_call 消息可能展开为多行（一次调用多个工具），
 * 调用方需按 message id 分组。
 */
export const findMessagesBySessionId = async (sessionId: number): Promise<MessageRow[]> =>
    db
        .getDb()
        .select({
            id: messages.id,
            session_id: messages.session_id,
            role: messages.role,
            content: messages.content,
            tool_log_id: messages.tool_log_id,
            created_at: messages.created_at,
            updated_at: messages.updated_at,
            tool_call_id: mcpToolLogs.tool_call_id,
            tool_name: mcpToolLogs.tool_name,
            tool_input: mcpToolLogs.input,
            tool_log_ref_id: mcpToolLogs.id,
        })
        .from(messages)
        .leftJoin(
            mcpToolLogs,
            or(eq(mcpToolLogs.message_id, messages.id), eq(messages.tool_log_id, mcpToolLogs.id))
        )
        .where(eq(messages.session_id, sessionId))
        .orderBy(asc(messages.created_at), asc(mcpToolLogs.id))
        .all();

/**
 * 创建消息
 */
export const createMessage = async (data: MessageCreateData): Promise<MessageEntity> => {
    const drizzle = db.getDb();
    await drizzle.insert(messages).values(data).run();

    const lastInsert = await drizzle
        .select()
        .from(messages)
        .orderBy(desc(messages.id))
        .limit(1)
        .get();

    if (!lastInsert) {
        throw new Error('Failed to create message');
    }
    return lastInsert;
};

/**
 * 统计所有消息数
 */
export const countMessages = async (): Promise<number> => {
    const result = await db.getDb().select({ count: count() }).from(messages).get();

    return result?.count || 0;
};

/**
 * 删除所有消息
 */
export const deleteAllMessages = async (): Promise<void> => {
    await db.getDb().delete(messages).run();
};
