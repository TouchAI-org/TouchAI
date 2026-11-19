// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { db } from '@/database/index';
import { findLatestContextCompaction } from '@/database/queries/messageParts';
import { findContextMessageRows, findMessagesBySessionId } from '@/database/queries/messages';

import { readContextSummary } from '../contracts/context';
import type {
    SessionContext,
    SessionReadModel,
    StoredContextMessage,
} from '../contracts/contextRead';

export type { SessionReadModel } from '../contracts/contextRead';

function projectContextMessage(row: StoredContextMessage): StoredContextMessage {
    return {
        id: row.id,
        role: row.role,
        parts: row.parts.map(({ type, content, data, sort_order }) => ({
            type,
            content,
            data,
            sort_order,
        })),
        attachments: row.attachments.map(
            ({
                id,
                hash,
                type,
                original_name,
                origin_path,
                mime_type,
                size,
                created_at,
                message_id,
                sort_order,
                tool_call_id,
                tool_kind,
            }) => ({
                id,
                hash,
                type,
                original_name,
                origin_path,
                mime_type,
                size,
                created_at,
                message_id,
                sort_order,
                tool_call_id,
                tool_kind,
            })
        ),
    };
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
                                messages: [...retained, ...tail].map(projectContextMessage),
                                summary,
                                summaryPartId: part!.id,
                            };
                        }
                    }
                    return {
                        messages: (await findMessagesBySessionId(sessionId, tx)).map(
                            projectContextMessage
                        ),
                    };
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
