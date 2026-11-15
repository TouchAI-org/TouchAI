import { asc, eq, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { sessionPendingMessages } from '../schema';
import type {
    SessionPendingMessageCreateData,
    SessionPendingMessageEntity,
    SessionPendingMessageUpdateData,
} from '../types';

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

/**
 * Append one pending message.
 *
 * The next position is read inside the transaction so delivery can leave gaps
 * without making the next insert collide with the unique session/position index.
 */
export async function appendPendingMessage(
    data: SessionPendingMessageCreateData,
    database: DatabaseExecutor = db
): Promise<void> {
    if (database === db) {
        await db.transaction((tx) => appendPendingMessage(data, tx));
        return;
    }

    const maximum = await database
        .select({
            value: sql<number>`coalesce(max(${sessionPendingMessages.position}), -1)`,
        })
        .from(sessionPendingMessages)
        .where(eq(sessionPendingMessages.session_id, data.session_id))
        .get();

    await database
        .insert(sessionPendingMessages)
        .values({
            ...data,
            position: (maximum?.value ?? -1) + 1,
        })
        .onConflictDoNothing()
        .run();
}

export async function updatePendingMessage(
    messageId: string,
    data: SessionPendingMessageUpdateData,
    database: DatabaseExecutor = db
): Promise<void> {
    await database
        .update(sessionPendingMessages)
        .set({
            ...data,
            updated_at: data.updated_at ?? sql`datetime('now')`,
        })
        .where(eq(sessionPendingMessages.id, messageId))
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
