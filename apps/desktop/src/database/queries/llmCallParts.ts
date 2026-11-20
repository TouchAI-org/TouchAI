import { eq, sql } from 'drizzle-orm';

import type { DatabaseExecutor } from '../index';
import { messageParts } from '../schema';

/** The usage owner supplies serialized payloads; this writer only appends rows atomically. */
export async function insertPreparedLlmCallParts(
    messageId: number,
    parts: readonly { data: string; durationMs: number; ttftMs?: number }[],
    database: DatabaseExecutor
): Promise<void> {
    if (!parts.length) return;
    const maximum = await database
        .select({ value: sql<number>`coalesce(max(${messageParts.sort_order}), -1)` })
        .from(messageParts)
        .where(eq(messageParts.message_id, messageId))
        .get();
    const baseOrder = (maximum?.value ?? -1) + 1;
    const now = Date.now();
    for (const [index, part] of parts.entries()) {
        const startedAt = part.ttftMs === undefined ? null : now - part.durationMs;
        await database
            .insert(messageParts)
            .values({
                message_id: messageId,
                type: 'llm_call',
                content: '',
                data: part.data,
                started_at: startedAt,
                ended_at: startedAt === null ? null : startedAt + part.durationMs,
                sort_order: baseOrder + index,
            })
            .run();
    }
}
