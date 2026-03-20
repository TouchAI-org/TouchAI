// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findLatestModelBySessionId } from '@database/queries/aiRequests';
import type { MessageRow } from '@database/queries/messages';
import { findMessagesBySessionId } from '@database/queries/messages';
import type { ModelWithProvider } from '@database/queries/models';
import {
    createSession as dbCreateSession,
    findSessionById,
    listSessions as dbListSessions,
    type ListSessionsOptions,
} from '@database/queries/sessions';
import type { SessionEntity } from '@database/types';

export interface SessionConversationData {
    session: SessionEntity;
    messages: MessageRow[];
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
 * 获取会话完整对话与最近模型信息。
 */
export async function getSessionConversation(sessionId: number): Promise<SessionConversationData> {
    const session = await findSessionById(sessionId);
    if (!session) {
        throw new Error(`Session ${sessionId} not found`);
    }

    const [messages, model] = await Promise.all([
        findMessagesBySessionId(sessionId),
        findLatestModelBySessionId({ sessionId }),
    ]);

    return {
        session,
        messages,
        model,
    };
}
