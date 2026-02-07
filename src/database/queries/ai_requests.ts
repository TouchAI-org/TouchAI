// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { UpdateResult } from 'kysely';

import { db } from '../index';
import type { AiRequest, AiRequestUpdate, NewAiRequest } from '../schema';

/**
 * 根据 ID 查找 AI 请求
 */
export const findAiRequestById = async (id: number) =>
    (await db.getKysely())
        .selectFrom('ai_requests')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

/**
 * 根据会话 ID 查找 AI 请求
 */
export const findAiRequestsBySessionId = async (sessionId: number) =>
    (await db.getKysely())
        .selectFrom('ai_requests')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy('created_at', 'desc')
        .execute();

/**
 * 根据状态查找 AI 请求
 */
export const findAiRequestsByStatus = async (
    status: 'pending' | 'streaming' | 'completed' | 'failed'
) =>
    (await db.getKysely())
        .selectFrom('ai_requests')
        .selectAll()
        .where('status', '=', status)
        .orderBy('created_at', 'desc')
        .execute();

/**
 * 查找所有 AI 请求
 */
export const findAllAiRequests = async (limit?: number) => {
    let query = (await db.getKysely())
        .selectFrom('ai_requests')
        .selectAll()
        .orderBy('created_at', 'desc');

    if (limit) {
        query = query.limit(limit);
    }

    return query.execute();
};

/**
 * 创建 AI 请求
 */
export const createAiRequest = async (data: NewAiRequest): Promise<AiRequest> => {
    const result = await (await db.getKysely())
        .insertInto('ai_requests')
        .values(data)
        .returningAll()
        .executeTakeFirst();

    if (!result) {
        // 如果 returning 不工作，尝试获取最后插入的记录
        const lastInsert = await (await db.getKysely())
            .selectFrom('ai_requests')
            .selectAll()
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();

        if (!lastInsert) {
            throw new Error('Failed to create AI request');
        }
        return lastInsert;
    }

    return result;
};

/**
 * 更新 AI 请求
 */
export const updateAiRequest = async (id: number, data: AiRequestUpdate): Promise<UpdateResult> => {
    const result = await (await db.getKysely())
        .updateTable('ai_requests')
        .set(data)
        .where('id', '=', id)
        .executeTakeFirst();

    if (!result) {
        throw new Error(`AI request with id ${id} not found`);
    }
    return result;
};

/**
 * 删除 AI 请求
 */
export const deleteAiRequest = async (id: number): Promise<boolean> => {
    const result = await (await db.getKysely())
        .deleteFrom('ai_requests')
        .where('id', '=', id)
        .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
};

/**
 * 统计 AI 请求数量
 */
export const countAiRequests = async (): Promise<number> => {
    const result = await (
        await db.getKysely()
    )
        .selectFrom('ai_requests')
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirst();
    return Number(result?.count || 0);
};

/**
 * 删除所有 AI 请求
 */
export const deleteAllAiRequests = async (): Promise<number> => {
    const result = await (await db.getKysely()).deleteFrom('ai_requests').executeTakeFirst();

    return Number(result.numDeletedRows);
};
