// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import { type DatabaseExecutor, db } from '../index';
import { messageParts } from '../schema';
import type { MessagePartCreateData, MessagePartEntity } from '../types';

/** Derive plain text only at consumers that need it; parts remain the source of truth. */
export function getMessageText(parts: readonly MessagePartEntity[]): string {
    return parts
        .filter((part) => part.type === 'text' || part.type === 'tool_result')
        .map((part) => part.content)
        .join('');
}

/**
 * 按消息批量读取片段，避免历史恢复时按消息逐条查询。
 */
export const findMessagePartsByMessageIds = async (
    messageIds: number[]
): Promise<MessagePartEntity[]> => {
    if (messageIds.length === 0) {
        return [];
    }

    return db
        .select()
        .from(messageParts)
        .where(inArray(messageParts.message_id, messageIds))
        .orderBy(asc(messageParts.message_id), asc(messageParts.sort_order), asc(messageParts.id))
        .all();
};

/** 按主键读取单个片段。 */
export const findMessagePartById = async (
    id: number,
    database: DatabaseExecutor = db
): Promise<MessagePartEntity | undefined> => {
    const part = await database.select().from(messageParts).where(eq(messageParts.id, id)).get();
    return part;
};

/**
 * 创建一条消息的有序片段。
 */
export const createMessageParts = async (
    parts: MessagePartCreateData[],
    database: DatabaseExecutor = db
): Promise<void> => {
    if (parts.length === 0) {
        return;
    }

    await database.insert(messageParts).values(parts).run();
};

/** 正文仅存于 parts；摘要等 SQL 读路径按原始顺序派生，不再保存第二份全文。 */
export function messageText(messageId: AnySQLiteColumn) {
    return sql<string>`coalesce((
        SELECT group_concat(content, '') FROM (
            SELECT content FROM message_parts
            WHERE message_id = ${messageId} AND type IN ('text', 'tool_result')
            ORDER BY sort_order, id
        )
    ), '')`;
}

/** Update only changed output parts; caller owns the transaction. Tool/file parts are untouched. */
export async function syncOutputParts(
    messageId: number,
    drafts: MessagePartCreateData[],
    database: DatabaseExecutor = db
): Promise<void> {
    const existing = await database
        .select()
        .from(messageParts)
        .where(
            and(
                eq(messageParts.message_id, messageId),
                inArray(messageParts.type, ['text', 'reasoning'])
            )
        )
        .all();
    const byOrder = new Map(existing.map((part) => [part.sort_order, part]));
    for (const draft of drafts) {
        const previous = byOrder.get(draft.sort_order);
        if (!previous) {
            await database.insert(messageParts).values(draft).run();
            continue;
        }
        if (
            previous.type === draft.type &&
            previous.content === draft.content &&
            previous.started_at === (draft.started_at ?? null) &&
            previous.ended_at === (draft.ended_at ?? null)
        )
            continue;
        await database
            .update(messageParts)
            .set({
                type: draft.type,
                content: draft.content,
                started_at: draft.started_at ?? null,
                ended_at: draft.ended_at ?? null,
                updated_at: sql`datetime('now')`,
            })
            .where(eq(messageParts.id, previous.id))
            .run();
    }
    const orders = drafts.map((part) => part.sort_order);
    await database
        .delete(messageParts)
        .where(
            and(
                eq(messageParts.message_id, messageId),
                inArray(messageParts.type, ['text', 'reasoning']),
                ...(orders.length ? [notInArray(messageParts.sort_order, orders)] : [])
            )
        )
        .run();
}
