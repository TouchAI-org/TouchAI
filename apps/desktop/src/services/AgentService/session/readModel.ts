// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Request-level read model. A turn asks for the same conversation while
 * checking attachments and rebuilding transport, so cache one native snapshot
 * per session for the lifetime of this request.
 */

import type { MessageRow } from '@database/queries/messages';
import type { MessagePartEntity } from '@database/types';
import { native } from '@services/NativeService';

export interface SessionContext {
    messages: MessageRow[];
    summaryPart?: MessagePartEntity;
}

export interface SessionReadModel {
    getMessages(sessionId: number): Promise<MessageRow[]>;
    getContext(sessionId: number): Promise<SessionContext>;
}

export function createSessionReadModel(): SessionReadModel {
    const pendingBySession = new Map<number, Promise<SessionContext>>();

    const getContext = (sessionId: number): Promise<SessionContext> => {
        const cached = pendingBySession.get(sessionId);
        if (cached) return cached;

        const pending = native.database
            .operation<SessionContext>({
                kind: 'session_context',
                sessionId,
            })
            .catch((error: unknown) => {
                if (pendingBySession.get(sessionId) === pending) {
                    pendingBySession.delete(sessionId);
                }
                throw error;
            });
        pendingBySession.set(sessionId, pending);
        return pending;
    };

    return {
        getContext,
        getMessages: async (sessionId) => (await getContext(sessionId)).messages,
    };
}
