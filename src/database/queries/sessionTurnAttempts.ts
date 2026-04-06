// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, count, eq, inArray } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { sessionTurnAttempts, sessionTurns } from '../schema';
import type {
    SessionTurnAttemptCreateData,
    SessionTurnAttemptEntity,
    SessionTurnAttemptUpdateData,
} from '../types';

export interface SessionTurnAttemptHistoryRow {
    id: number;
    turn_id: number;
    attempt_index: number;
    max_retries: number;
    status: SessionTurnAttemptEntity['status'];
    checkpoint_json: string;
    error_message: string | null;
    started_at: string;
    finished_at: string | null;
    created_at: string;
    updated_at: string;
}

const SESSION_TURN_ATTEMPT_HISTORY_SELECTION = {
    id: sessionTurnAttempts.id,
    turn_id: sessionTurnAttempts.turn_id,
    attempt_index: sessionTurnAttempts.attempt_index,
    max_retries: sessionTurnAttempts.max_retries,
    status: sessionTurnAttempts.status,
    checkpoint_json: sessionTurnAttempts.checkpoint_json,
    error_message: sessionTurnAttempts.error_message,
    started_at: sessionTurnAttempts.started_at,
    finished_at: sessionTurnAttempts.finished_at,
    created_at: sessionTurnAttempts.created_at,
    updated_at: sessionTurnAttempts.updated_at,
} as const;

/**
 * 创建会话轮次尝试。
 */
export const createSessionTurnAttempt = async (
    attemptDraft: SessionTurnAttemptCreateData,
    database: DatabaseExecutor = db
): Promise<SessionTurnAttemptEntity> => {
    const createdAttempt = await database
        .insert(sessionTurnAttempts)
        .values(attemptDraft)
        .returning()
        .get();

    if (!createdAttempt || createdAttempt.id === undefined) {
        throw new Error('Failed to create session turn attempt');
    }

    return createdAttempt;
};

/**
 * 更新会话轮次尝试。
 */
export const updateSessionTurnAttempt = async ({
    id,
    attemptPatch,
    database = db,
}: {
    id: number;
    attemptPatch: SessionTurnAttemptUpdateData;
    database?: DatabaseExecutor;
}): Promise<void> => {
    await database
        .update(sessionTurnAttempts)
        .set(attemptPatch)
        .where(eq(sessionTurnAttempts.id, id))
        .run();
};

/**
 * 查询会话内全部尝试元数据。
 */
export const findSessionTurnAttemptsBySessionId = async (
    sessionId: number
): Promise<SessionTurnAttemptHistoryRow[]> => {
    return db
        .select(SESSION_TURN_ATTEMPT_HISTORY_SELECTION)
        .from(sessionTurnAttempts)
        .innerJoin(sessionTurns, eq(sessionTurns.id, sessionTurnAttempts.turn_id))
        .where(eq(sessionTurns.session_id, sessionId))
        .orderBy(
            asc(sessionTurnAttempts.turn_id),
            asc(sessionTurnAttempts.attempt_index),
            asc(sessionTurnAttempts.id)
        )
        .all();
};

/**
 * 查询指定轮次的尝试元数据。
 */
export const findSessionTurnAttemptsByTurnIds = async (
    turnIds: number[]
): Promise<SessionTurnAttemptHistoryRow[]> => {
    if (turnIds.length === 0) {
        return [];
    }

    return db
        .select(SESSION_TURN_ATTEMPT_HISTORY_SELECTION)
        .from(sessionTurnAttempts)
        .where(inArray(sessionTurnAttempts.turn_id, turnIds))
        .orderBy(
            asc(sessionTurnAttempts.turn_id),
            asc(sessionTurnAttempts.attempt_index),
            asc(sessionTurnAttempts.id)
        )
        .all();
};

/**
 * 统计会话轮次尝试数量。
 */
export const countSessionTurnAttempts = async (): Promise<number> => {
    const result = await db.select({ count: count() }).from(sessionTurnAttempts).get();
    return result?.count || 0;
};

/**
 * 删除所有会话轮次尝试。
 */
export const deleteAllSessionTurnAttempts = async (): Promise<void> => {
    await db.delete(sessionTurnAttempts).run();
};
