// Copyright (c) 2026. 千诚. Licensed under GPL v3
import { and, asc, count, desc, eq, type SQL, sql } from 'drizzle-orm';

import { db } from '../index';
import { messageParts, messages, type ToolLogKind } from '../schema';
import type { BuiltInToolLogEntity, McpToolLogEntity } from '../types';

function toolPayload(data: Record<string, unknown>): Record<string, unknown> {
    const payload = { ...data };
    for (const key of ['message_id', 'session_id', 'tool_call_id', 'created_at'])
        delete payload[key];
    if (typeof data.tool_call_id === 'string') payload.toolCallId = data.tool_call_id;
    return payload;
}

export type ToolPartEntity = McpToolLogEntity | BuiltInToolLogEntity;
export async function findToolParts(
    kind: ToolLogKind,
    condition?: SQL,
    options?: { limit?: number; offset?: number }
): Promise<ToolPartEntity[]> {
    const query = db
        .select({ part: messageParts, session_id: messages.session_id })
        .from(messageParts)
        .innerJoin(messages, eq(messages.id, messageParts.message_id))
        .where(and(eq(messageParts.type, 'tool_call'), eq(messageParts.tool_kind, kind), condition))
        .orderBy(desc(messageParts.created_at), desc(messageParts.id));
    const rows = options
        ? await query
              .limit(options.limit ?? 100)
              .offset(options.offset ?? 0)
              .all()
        : await query.all();
    return rows.map(
        ({ part, session_id }) =>
            ({
                ...JSON.parse(part.data),
                id: part.id,
                tool_call_id: part.tool_call_id!,
                session_id,
                message_id: part.message_id,
                created_at: part.created_at,
            }) as ToolPartEntity
    );
}
export async function createToolPart(
    kind: ToolLogKind,
    data: Record<string, unknown>
): Promise<ToolPartEntity> {
    return db.transaction(async (tx) => {
        let messageId = data.message_id as number | undefined;
        if (!messageId) {
            if (typeof data.session_id !== 'number')
                throw new Error('A tool call must belong to a session');
            const row = await tx
                .insert(messages)
                .values({ session_id: data.session_id, role: 'tool_call' })
                .returning()
                .get();
            if (!row) throw new Error('Failed to create tool message');
            messageId = row.id;
        }
        const maximum = await tx
            .select({
                value: sql<number>`coalesce(max(${messageParts.sort_order}), -1)`.as('value'),
            })
            .from(messageParts)
            .where(eq(messageParts.message_id, messageId))
            .get();
        const { tool_call_id: callId, created_at: createdAt } = data;
        const payload = toolPayload(data);
        const part = await tx
            .insert(messageParts)
            .values({
                message_id: messageId,
                type: 'tool_call',
                content: '',
                sort_order: (maximum?.value ?? -1) + 1,
                data: JSON.stringify({
                    iteration: 1,
                    output: null,
                    status: 'pending',
                    duration_ms: null,
                    error_message: null,
                    ...(kind === 'builtin'
                        ? {
                              approval_state: 'none',
                              approval_summary: null,
                              conversation_semantic_json: null,
                          }
                        : {}),
                    ...payload,
                    toolCallId: callId,
                    toolKind: kind,
                }),
                ...(typeof createdAt === 'string' ? { created_at: createdAt } : {}),
            })
            .returning()
            .get();
        if (!part) throw new Error('Failed to persist tool part');
        const parent = await tx.select().from(messages).where(eq(messages.id, messageId)).get();
        return {
            ...JSON.parse(part.data),
            id: part.id,
            tool_call_id: part.tool_call_id!,
            session_id: parent!.session_id,
            message_id: messageId,
            created_at: part.created_at,
        } as ToolPartEntity;
    });
}
export async function updateToolPart(
    kind: ToolLogKind,
    condition: SQL,
    patch: Record<string, unknown>
): Promise<ToolPartEntity | undefined> {
    return db.transaction(async (tx) => {
        const existing = await tx
            .select()
            .from(messageParts)
            .where(
                and(eq(messageParts.type, 'tool_call'), eq(messageParts.tool_kind, kind), condition)
            )
            .orderBy(asc(messageParts.id))
            .all();
        let result: ToolPartEntity | undefined;
        for (const part of existing) {
            const { message_id, created_at } = patch;
            const payload = toolPayload(patch);
            const updated = await tx
                .update(messageParts)
                .set({
                    data: JSON.stringify({ ...JSON.parse(part.data), ...payload, toolKind: kind }),
                    ...(typeof message_id === 'number' ? { message_id } : {}),
                    ...(typeof created_at === 'string' ? { created_at } : {}),
                    updated_at: sql`datetime('now')`,
                })
                .where(eq(messageParts.id, part.id))
                .returning()
                .get();
            if (updated && !result) {
                const parent = await tx
                    .select()
                    .from(messages)
                    .where(eq(messages.id, updated.message_id))
                    .get();
                result = {
                    ...JSON.parse(updated.data),
                    id: updated.id,
                    message_id: updated.message_id,
                    session_id: parent!.session_id,
                    tool_call_id: updated.tool_call_id!,
                    created_at: updated.created_at,
                } as ToolPartEntity;
            }
        }
        return result;
    });
}
export const countToolParts = async (kind: ToolLogKind, condition?: SQL): Promise<number> => {
    const row = await db
        .select({ count: count() })
        .from(messageParts)
        .innerJoin(messages, eq(messages.id, messageParts.message_id))
        .where(and(eq(messageParts.type, 'tool_call'), eq(messageParts.tool_kind, kind), condition))
        .get();
    return row?.count ?? 0;
};
export const toolData = (field: string) =>
    sql`json_extract(${messageParts.data}, ${'$."' + field + '"'})`;
