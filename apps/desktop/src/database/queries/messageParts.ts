// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import { type DatabaseExecutor, db } from '../index';
import { messageParts } from '../schema';
import type { MessagePartCreateData, MessagePartEntity } from '../types';

/** Derive plain text only at consumers that need it; parts remain the source of truth. */
export function getMessageText(parts: readonly MessagePartEntity[]): string {
    return parts
        .filter((part) => part.type === 'text')
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
 * 按工具调用 id 反查 tool_call 片段。
 *
 * 工具结果只能回写到 `tool_call` 片段上；当写入方弄丢了片段主键时，
 * 靠这个查询把它找回来，而不是退化成追加一条助手文本。
 */
export const findToolCallPartByCallId = async (
    toolCallId: string,
    database: DatabaseExecutor = db
): Promise<MessagePartEntity | undefined> => {
    const part = await database
        .select()
        .from(messageParts)
        .where(and(eq(messageParts.type, 'tool_call'), eq(messageParts.tool_call_id, toolCallId)))
        .orderBy(asc(messageParts.id))
        .get();
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

/**
 * 在消息末尾追加一条片段，sort_order 由当前最大序号推导。
 *
 * 工具结果等“后置写入”的片段用它避免与既有片段争抢顺序。
 */
export const appendMessagePart = async (
    messageId: number,
    part: Omit<MessagePartCreateData, 'message_id' | 'sort_order'>,
    database: DatabaseExecutor = db
): Promise<MessagePartEntity> => {
    const maximum = await database
        .select({
            value: sql<number>`coalesce(max(${messageParts.sort_order}), -1)`.as('value'),
        })
        .from(messageParts)
        .where(eq(messageParts.message_id, messageId))
        .get();
    const inserted = await database
        .insert(messageParts)
        .values({
            ...part,
            message_id: messageId,
            sort_order: (maximum?.value ?? -1) + 1,
        })
        .returning()
        .get();

    if (!inserted) {
        throw new Error('Failed to append message part');
    }

    return inserted;
};

/**
 * 合并片段 data 的 JSON 字段；调用方负责事务边界。
 */
export const mergeMessagePartData = async (
    partId: number,
    patch: Record<string, unknown>,
    database: DatabaseExecutor = db
): Promise<MessagePartEntity | undefined> => {
    const part = await database
        .select()
        .from(messageParts)
        .where(eq(messageParts.id, partId))
        .get();
    if (!part) {
        return undefined;
    }

    const data = JSON.stringify({
        ...(JSON.parse(part.data) as Record<string, unknown>),
        ...patch,
    });
    await database
        .update(messageParts)
        .set({ data, updated_at: sql`datetime('now')` })
        .where(eq(messageParts.id, partId))
        .run();

    return { ...part, data };
};

/**
 * 正文仅存于 parts；摘要等 SQL 读路径按原始顺序派生，不再保存第二份全文。
 *
 * tool_call 片段的正文即工具输出（保存在 data.output），因此这里同时读取
 * text 片段与 tool_call 输出，保证会话搜索与预览仍能命中工具结果。
 */
export function messageText(messageId: AnySQLiteColumn) {
    return sql<string>`coalesce((
        SELECT group_concat(content, '') FROM (
            SELECT CASE
                       WHEN type = 'text' THEN content
                       ELSE coalesce(json_extract(data, '$.output'), '')
                   END AS content
            FROM message_parts
            WHERE message_id = ${messageId} AND type IN ('text', 'tool_call')
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
            previous.ended_at === (draft.ended_at ?? null) &&
            previous.data === (draft.data ?? '{}')
        )
            continue;
        await database
            .update(messageParts)
            .set({
                type: draft.type,
                content: draft.content,
                data: draft.data ?? '{}',
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
