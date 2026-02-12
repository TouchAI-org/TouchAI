// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { count, desc } from 'drizzle-orm';

import { db } from '../index';
import { sessions } from '../schema';
import type { SessionCreateData, SessionEntity } from '../types';

/**
 * 创建会话
 */
export const createSession = async (data: SessionCreateData): Promise<SessionEntity> => {
    const drizzle = await db.getDb();
    await drizzle.insert(sessions).values(data).run();

    const lastInsert = await drizzle
        .select()
        .from(sessions)
        .orderBy(desc(sessions.id))
        .limit(1)
        .get();

    if (!lastInsert) {
        throw new Error('Failed to create session');
    }
    return lastInsert;
};

/**
 * 统计会话数
 */
export const countSessions = async (): Promise<number> => {
    const result = await (await db.getDb()).select({ count: count() }).from(sessions).get();

    return result?.count || 0;
};

/**
 * 删除所有会话
 */
export const deleteAllSessions = async (): Promise<void> => {
    await (await db.getDb()).delete(sessions).run();
};
