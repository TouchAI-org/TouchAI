// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, asc, count, desc, eq, lt, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { messages } from '../schema';
import type { MessageCreateData, MessageEntity, MessagePartEntity } from '../types';
import { findAttachmentsByMessageIds, type MessageAttachmentRow } from './attachments';
import { findMessagePartsByMessageIds } from './messageParts';

/** A database message is returned once, with its ordered parts and resolved attachments. */
export interface MessageRow extends MessageEntity {
    parts: MessagePartEntity[];
    attachments: MessageAttachmentRow[];
}

/** 向前（更早）分页的结果：消息按 id 升序，供直接拼接渲染。 */
export interface MessagesPage {
    messages: MessageRow[];
    hasMore: boolean;
}

/** 为一批消息补全 parts 与附件，避免逐条查询。 */
async function hydrateMessageRows(rows: MessageEntity[]): Promise<MessageRow[]> {
    const ids = rows.map((row) => row.id);
    const [parts, attachments] = await Promise.all([
        findMessagePartsByMessageIds(ids),
        findAttachmentsByMessageIds(ids),
    ]);
    const partsByMessage = new Map<number, MessagePartEntity[]>();
    for (const part of parts) {
        const current = partsByMessage.get(part.message_id);
        if (current) current.push(part);
        else partsByMessage.set(part.message_id, [part]);
    }
    const attachmentsByMessage = new Map<number, MessageAttachmentRow[]>();
    for (const attachment of attachments) {
        const current = attachmentsByMessage.get(attachment.message_id);
        if (current) current.push(attachment);
        else attachmentsByMessage.set(attachment.message_id, [attachment]);
    }
    return rows.map((row) => ({
        ...row,
        parts: partsByMessage.get(row.id) ?? [],
        attachments: attachmentsByMessage.get(row.id) ?? [],
    }));
}

export async function findMessagesBySessionId(sessionId: number): Promise<MessageRow[]> {
    const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.session_id, sessionId))
        .orderBy(asc(messages.id))
        .all();

    return hydrateMessageRows(rows);
}

/**
 * 向前分页读取会话消息（先取最新一页，再按 `beforeMessageId` 向前翻）。
 *
 * 先按 id 倒序取 `limit + 1` 条以判断是否还有更早消息，再反转成升序，
 * 只 hydrate 本页的 parts 与附件，避免长会话首屏全量读取。
 */
export async function findMessagesPageBySessionId(
    sessionId: number,
    options: { limit: number; beforeMessageId?: number | null }
): Promise<MessagesPage> {
    const limit = Math.max(1, Math.floor(options.limit));
    const conditions = [eq(messages.session_id, sessionId)];
    if (options.beforeMessageId !== undefined && options.beforeMessageId !== null) {
        conditions.push(lt(messages.id, options.beforeMessageId));
    }

    const rows = await db
        .select()
        .from(messages)
        .where(and(...conditions))
        .orderBy(desc(messages.id))
        .limit(limit + 1)
        .all();
    const hasMore = rows.length > limit;
    const pageRows = (hasMore ? rows.slice(0, limit) : rows).reverse();

    return { messages: await hydrateMessageRows(pageRows), hasMore };
}
/**
 * 创建消息。
 *
 * @param data 消息初始数据。
 * @returns 新创建的消息记录。
 */
export const createMessage = async (
    data: MessageCreateData,
    database: DatabaseExecutor = db
): Promise<MessageEntity> => {
    const createdMessage = await database.insert(messages).values(data).returning().get();

    if (!createdMessage || createdMessage.id === undefined) {
        throw new Error('Failed to create message');
    }

    return createdMessage;
};

/** 更新消息身份；正文由 message_parts 保存。 */
export const updateMessage = async (
    messageId: number,
    patch: Partial<Pick<MessageEntity, 'role'>>,
    database: DatabaseExecutor = db
): Promise<void> => {
    await database
        .update(messages)
        .set({ ...patch, updated_at: sql`datetime('now')` })
        .where(eq(messages.id, messageId))
        .run();
};

/**
 * 统计所有消息数。
 *
 * @returns 当前数据库中的消息总数。
 */
export const countMessages = async (): Promise<number> => {
    const result = await db.select({ count: count() }).from(messages).get();

    return result?.count || 0;
};

/**
 * 删除所有消息。
 *
 * @returns 无。
 */
export const deleteAllMessages = async (): Promise<void> => {
    await db.delete(messages).run();
};
