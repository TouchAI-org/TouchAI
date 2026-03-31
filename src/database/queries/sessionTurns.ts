// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, desc, eq } from 'drizzle-orm';

import { db } from '../index';
import { models, providers, sessionTurns } from '../schema';
import type { SessionTurnCreateData, SessionTurnEntity, SessionTurnUpdateData } from '../types';
import { type ModelWithProvider, modelWithProviderSelection } from './models';

export interface SessionTurnHistoryRow {
    id: number;
    session_id: number | null;
    prompt_message_id: number | null;
    response_message_id: number | null;
    status: SessionTurnEntity['status'];
    error_message: string | null;
    created_at: string;
    updated_at: string;
}

/**
 * 创建会话轮次。
 */
export const createSessionTurn = async (
    turnDraft: SessionTurnCreateData
): Promise<SessionTurnEntity> => {
    const createdTurn = await db.getDb().insert(sessionTurns).values(turnDraft).returning().get();

    if (!createdTurn || createdTurn.id === undefined) {
        throw new Error('Failed to create session turn');
    }

    return createdTurn;
};

/**
 * 更新会话轮次。
 */
export const updateSessionTurn = async ({
    id,
    turnPatch,
}: {
    id: number;
    turnPatch: SessionTurnUpdateData;
}): Promise<void> => {
    await db.getDb().update(sessionTurns).set(turnPatch).where(eq(sessionTurns.id, id)).run();
};

/**
 * 查找会话最近一次轮次所使用的模型与服务商。
 */
export const findLatestModelBySessionId = async ({
    sessionId,
}: {
    sessionId: number;
}): Promise<ModelWithProvider | null> => {
    const result = await db
        .getDb()
        .select(modelWithProviderSelection)
        .from(sessionTurns)
        .innerJoin(models, eq(models.id, sessionTurns.model_id))
        .innerJoin(providers, eq(providers.id, models.provider_id))
        .where(eq(sessionTurns.session_id, sessionId))
        .orderBy(desc(sessionTurns.created_at), desc(sessionTurns.id))
        .limit(1)
        .get();

    if (!result || result.id === undefined) {
        return null;
    }

    return result as ModelWithProvider;
};

/**
 * 查询会话内所有轮次元数据，供历史回放还原 turn 级状态使用。
 */
export const findSessionTurnsBySessionId = async (
    sessionId: number
): Promise<SessionTurnHistoryRow[]> => {
    return db
        .getDb()
        .select({
            id: sessionTurns.id,
            session_id: sessionTurns.session_id,
            prompt_message_id: sessionTurns.prompt_message_id,
            response_message_id: sessionTurns.response_message_id,
            status: sessionTurns.status,
            error_message: sessionTurns.error_message,
            created_at: sessionTurns.created_at,
            updated_at: sessionTurns.updated_at,
        })
        .from(sessionTurns)
        .where(eq(sessionTurns.session_id, sessionId))
        .orderBy(asc(sessionTurns.created_at), asc(sessionTurns.id))
        .all();
};

/**
 * 统计会话轮次数量。
 */
export const countSessionTurns = async (): Promise<number> => {
    const result = await db.getDb().select({ count: count() }).from(sessionTurns).get();
    return result?.count || 0;
};

/**
 * 删除所有会话轮次。
 */
export const deleteAllSessionTurns = async (): Promise<void> => {
    await db.getDb().delete(sessionTurns).run();
};
