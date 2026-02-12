// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, desc, eq } from 'drizzle-orm';

import { db } from '../index';
import { messages } from '../schema';
import type { MessageCreateData, MessageEntity, SessionIdPayload } from '../types';

/**
 * 根据会话 ID 查找所有消息
 */
export const findMessagesBySessionId = async ({
    sessionId,
}: SessionIdPayload): Promise<MessageEntity[]> =>
    (await db.getDb())
        .select()
        .from(messages)
        .where(eq(messages.session_id, sessionId))
        .orderBy(asc(messages.created_at))
        .all();

/**
 * 创建消息
 */
export const createMessage = async (data: MessageCreateData): Promise<MessageEntity> => {
    const drizzle = await db.getDb();
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
    const result = await (await db.getDb()).select({ count: count() }).from(messages).get();

    return result?.count || 0;
};

/**
 * 删除所有消息
 */
export const deleteAllMessages = async (): Promise<void> => {
    await (await db.getDb()).delete(messages).run();
};
