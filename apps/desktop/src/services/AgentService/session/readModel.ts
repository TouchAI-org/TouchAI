// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { db } from '@database';
import { findLatestContextCompaction } from '@database/queries/messageParts';
import {
    findContextMessageRows,
    findMessagesBySessionId,
    type MessageRow,
} from '@database/queries/messages';

import { type ContextSummary, readContextSummary } from '../contracts/context';

interface SessionContext {
    messages: MessageRow[];
    summary?: ContextSummary;
    summaryPartId?: number;
}

export interface SessionReadModel {
    getMessages(sessionId: number): Promise<MessageRow[]>;
    getContext(sessionId: number): Promise<SessionContext>;
}

/** One consistent read snapshot shared by capability checks and transport construction. */
export function createSessionReadModel(): SessionReadModel {
    const pendingBySession = new Map<number, Promise<SessionContext>>();
    const getContext = (sessionId: number): Promise<SessionContext> => {
        const cached = pendingBySession.get(sessionId);
        if (cached) return cached;
        const pending = db
            .transaction(
                async (tx): Promise<SessionContext> => {
                    const part = await findLatestContextCompaction(sessionId, tx);
                    const summary = part ? readContextSummary(part) : undefined;
                    if (
                        summary &&
                        summary.invalidatedAt === undefined &&
                        summary.firstKeptMessageId <= part!.message_id
                    ) {
                        const retained = await findContextMessageRows(
                            sessionId,
                            { ids: summary.systemMessageIds },
                            tx
                        );
                        const tail = await findContextMessageRows(
                            sessionId,
                            { firstId: summary.firstKeptMessageId },
                            tx
                        );
                        const byId = new Map(retained.map((row) => [row.id, row]));
                        if (
                            tail[0]?.id === summary.firstKeptMessageId &&
                            summary.systemMessageIds.every((id) => byId.get(id)?.role === 'system')
                        ) {
                            return {
                                messages: [...retained, ...tail],
                                summary,
                                summaryPartId: part!.id,
                            };
                        }
                    }
                    return { messages: await findMessagesBySessionId(sessionId, tx) };
                },
                { behavior: 'deferred' }
            )
            .catch((error: unknown) => {
                if (pendingBySession.get(sessionId) === pending) pendingBySession.delete(sessionId);
                throw error;
            });
        pendingBySession.set(sessionId, pending);
        return pending;
    };
    return { getContext, getMessages: async (sessionId) => (await getContext(sessionId)).messages };
}
