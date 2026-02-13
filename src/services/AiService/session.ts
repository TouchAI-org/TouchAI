// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findMessagesBySessionId } from '@database/queries/messages';
import { createSession as dbCreateSession } from '@database/queries/sessions';
import type { MessageEntity } from '@database/types';

/**
 * 创建会话
 */
export async function createSession(title: string, model: string): Promise<number> {
    const session = await dbCreateSession({
        session_id: crypto.randomUUID(),
        title,
        model,
    });
    return session.id;
}

/**
 * 获取会话消息历史
 */
export async function getSessionMessages(sessionId: number): Promise<MessageEntity[]> {
    return await findMessagesBySessionId({ sessionId });
}
