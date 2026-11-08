// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 请求级会话只读模型。
 *
 * 同一个 turn 的准备阶段会多次需要同一会话的消息行（附件能力预检、transport 重建等）。
 * 读模型在**单次请求内**缓存首个 `findMessagesBySessionId` 结果，跨消费者复用同一次查询；
 * 它不是长期缓存，因此不存在写后读到旧数据的问题。
 */

import { findMessagesBySessionId, type MessageRow } from '@database/queries/messages';

export interface SessionReadModel {
    /** 读取会话消息行；同一会话在本次请求内只查一次。 */
    getMessages(sessionId: number): Promise<MessageRow[]>;
}

export function createSessionReadModel(): SessionReadModel {
    const pendingBySession = new Map<number, Promise<MessageRow[]>>();

    return {
        getMessages(sessionId: number): Promise<MessageRow[]> {
            const cached = pendingBySession.get(sessionId);
            if (cached) {
                return cached;
            }

            // 缓存 Promise 而非结果：并发消费者共享同一次查询。
            const pending = findMessagesBySessionId(sessionId);
            pendingBySession.set(sessionId, pending);
            return pending;
        },
    };
}
