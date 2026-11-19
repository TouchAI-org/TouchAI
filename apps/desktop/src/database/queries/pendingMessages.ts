import { asc, eq, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { sessionPendingMessages } from '../schema';
import type { SessionPendingMessageCreateData, SessionPendingMessageEntity } from '../types';

/** Return the queued messages for one session in their user-visible order. */
export async function findPendingMessagesBySessionId(
    sessionId: number,
    database: DatabaseExecutor = db
): Promise<SessionPendingMessageEntity[]> {
    return database
        .select()
        .from(sessionPendingMessages)
        .where(eq(sessionPendingMessages.session_id, sessionId))
        .orderBy(asc(sessionPendingMessages.position), asc(sessionPendingMessages.id))
        .all();
}

export async function savePendingMessage(
    data: SessionPendingMessageCreateData,
    database: DatabaseExecutor = db
): Promise<void> {
    if (database === db) {
        await db.transaction((tx) => savePendingMessage(data, tx));
        return;
    }

    await database
        .insert(sessionPendingMessages)
        .values({
            ...data,
            position: sql`(SELECT coalesce(max(${sessionPendingMessages.position}), -1) + 1 FROM ${sessionPendingMessages} WHERE ${sessionPendingMessages.session_id} = ${data.session_id})`,
        })
        .onConflictDoUpdate({
            target: sessionPendingMessages.id,
            set: {
                prompt: data.prompt,
                model_id: data.model_id,
                provider_id: data.provider_id,
                payload_version: data.payload_version,
                payload_json: data.payload_json,
                updated_at: sql`datetime('now')`,
            },
        })
        .run();
}

export async function deletePendingMessage(
    messageId: string,
    database: DatabaseExecutor = db
): Promise<void> {
    await database
        .delete(sessionPendingMessages)
        .where(eq(sessionPendingMessages.id, messageId))
        .run();
}

export async function clearPendingMessagesForSession(
    sessionId: number,
    database: DatabaseExecutor = db
): Promise<void> {
    await database
        .delete(sessionPendingMessages)
        .where(eq(sessionPendingMessages.session_id, sessionId))
        .run();
}

/**
 * Rewrite the queue order in one transaction.
 *
 * Positions are shifted first because the old and new values can overlap while
 * the unique index is being updated row by row.
 */
export async function reorderPendingMessages(
    sessionId: number,
    orderedMessageIds: readonly string[],
    database: DatabaseExecutor = db
): Promise<void> {
    if (database === db) {
        await db.transaction((tx) => reorderPendingMessages(sessionId, orderedMessageIds, tx));
        return;
    }

    const rows = await database
        .select({
            id: sessionPendingMessages.id,
        })
        .from(sessionPendingMessages)
        .where(eq(sessionPendingMessages.session_id, sessionId))
        .orderBy(asc(sessionPendingMessages.position), asc(sessionPendingMessages.id))
        .all();
    if (rows.length === 0) {
        return;
    }

    const existingIds = new Set(rows.map((row) => row.id));
    const desiredIds = orderedMessageIds.filter((id) => existingIds.has(id));
    const desired = new Set(desiredIds);
    for (const row of rows) {
        if (!desired.has(row.id)) {
            desiredIds.push(row.id);
        }
    }
    await database
        .update(sessionPendingMessages)
        .set({
            position: sql`${sessionPendingMessages.position} + 1000000`,
            updated_at: sql`datetime('now')`,
        })
        .where(eq(sessionPendingMessages.session_id, sessionId))
        .run();

    for (const [position, messageId] of desiredIds.entries()) {
        await database
            .update(sessionPendingMessages)
            .set({
                position,
                updated_at: sql`datetime('now')`,
            })
            .where(eq(sessionPendingMessages.id, messageId))
            .run();
    }
}

export async function updatePendingMessagesModel(
    sessionId: number,
    modelId: string | null,
    providerId: number | null,
    database: DatabaseExecutor = db
): Promise<void> {
    await database
        .update(sessionPendingMessages)
        .set({
            model_id: modelId,
            provider_id: providerId,
            updated_at: sql`datetime('now')`,
        })
        .where(eq(sessionPendingMessages.session_id, sessionId))
        .run();
}
