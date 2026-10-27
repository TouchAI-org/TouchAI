// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { MessageRow } from '@database/queries/messages';
import { findMessagesBySessionId } from '@database/queries/messages';
import type { ModelWithProvider } from '@database/queries/models';
import {
    createSession as dbCreateSession,
    dismissSessionTerminalStatus as dbDismissSessionTerminalStatus,
    findSessionById,
    listSessions as dbListSessions,
    type ListSessionsOptions,
} from '@database/queries/sessions';
import {
    findSessionTurnAttemptsBySessionId,
    type SessionTurnAttemptHistoryRow,
} from '@database/queries/sessionTurnAttempts';
import {
    findLatestModelBySessionId,
    findSessionTurnsBySessionId,
    type SessionTurnHistoryRow,
} from '@database/queries/sessionTurns';
import type { SessionEntity } from '@database/types';

export interface SessionData {
    session: SessionEntity;
    messages: MessageRow[];
    turns: SessionTurnHistoryRow[];
    attempts: SessionTurnAttemptHistoryRow[];
    model: ModelWithProvider | null;
}

/**
 * 创建会话。
 */
export async function createSession(
    title: string,
    model: string,
    providerId?: number | null
): Promise<number> {
    const session = await dbCreateSession({
        session_id: crypto.randomUUID(),
        title,
        model,
        provider_id: providerId ?? null,
    });

    return session.id;
}

/**
 * 列出历史会话。
 */
export async function listSessions(options: ListSessionsOptions = {}): Promise<SessionEntity[]> {
    return dbListSessions(options);
}

/**
 * 确认会话终态徽标。
 */
export async function dismissSessionTerminalStatus(sessionId: number): Promise<void> {
    await dbDismissSessionTerminalStatus(sessionId);
}

/**
 * 获取会话完整数据与最近模型信息。
 */
export async function getSessionData(sessionId: number): Promise<SessionData> {
    const session = await findSessionById(sessionId);
    if (!session) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const [messages, turns, attempts, model] = await Promise.all([
        findMessagesBySessionId(sessionId),
        findSessionTurnsBySessionId(sessionId),
        findSessionTurnAttemptsBySessionId(sessionId),
        findLatestModelBySessionId({ sessionId }),
    ]);

    return {
        session,
        messages,
        turns,
        attempts,
        model,
    };
}
