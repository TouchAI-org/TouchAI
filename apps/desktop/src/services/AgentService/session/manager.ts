// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { MessageRow } from '@database/queries/messages';
import { findMessagesBySessionId, findMessagesPageBySessionId } from '@database/queries/messages';
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

/** 分页版本的会话数据：消息只包含当前页。 */
export interface SessionDataPage extends Omit<SessionData, 'messages'> {
    messages: MessageRow[];
    hasMoreMessages: boolean;
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

/**
 * 分页获取会话数据：消息只读取一页，其余会话级元数据保持完整。
 *
 * 用于长会话首屏：先展示最新一页，用户向上滚动时用 `beforeMessageId` 继续向前取。
 */
export async function getSessionDataPage(
    sessionId: number,
    options: { limit: number; beforeMessageId?: number | null }
): Promise<SessionDataPage> {
    const session = await findSessionById(sessionId);
    if (!session) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const [page, turns, attempts, model] = await Promise.all([
        findMessagesPageBySessionId(sessionId, options),
        findSessionTurnsBySessionId(sessionId),
        findSessionTurnAttemptsBySessionId(sessionId),
        findLatestModelBySessionId({ sessionId }),
    ]);

    return {
        session,
        messages: page.messages,
        turns,
        attempts,
        model,
        hasMoreMessages: page.hasMore,
    };
}
