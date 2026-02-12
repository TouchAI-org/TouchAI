// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { count, desc, eq } from 'drizzle-orm';

import { db } from '../index';
import { aiRequests } from '../schema';
import type { AiRequestCreateData, AiRequestEntity, AiRequestUpdateData } from '../types';

/**
 * 创建 AI 请求
 */
export const createAiRequest = async (
    requestDraft: AiRequestCreateData
): Promise<AiRequestEntity> => {
    const drizzle = await db.getDb();
    await drizzle.insert(aiRequests).values(requestDraft).run();

    const lastInsert = await drizzle
        .select()
        .from(aiRequests)
        .orderBy(desc(aiRequests.id))
        .limit(1)
        .get();

    if (!lastInsert) {
        throw new Error('Failed to create AI request');
    }
    return lastInsert;
};

/**
 * 更新 AI 请求
 */
export const updateAiRequest = async ({
    id,
    requestPatch,
}: {
    id: number;
    requestPatch: AiRequestUpdateData;
}): Promise<void> => {
    await (await db.getDb())
        .update(aiRequests)
        .set(requestPatch)
        .where(eq(aiRequests.id, id))
        .run();
};

/**
 * 统计 AI 请求数量
 */
export const countAiRequests = async (): Promise<number> => {
    const result = await (await db.getDb()).select({ count: count() }).from(aiRequests).get();
    return result?.count || 0;
};

/**
 * 删除所有 AI 请求
 */
export const deleteAllAiRequests = async (): Promise<void> => {
    await (await db.getDb()).delete(aiRequests).run();
};
