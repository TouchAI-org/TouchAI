// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { attachments, messageParts } from '../schema';
import type { AttachmentCreateData, AttachmentEntity, MessageAttachmentCreateData } from '../types';

export interface MessageAttachmentRow extends AttachmentEntity {
    message_id: number;
    sort_order: number;
}

/**
 * 根据内容哈希查找附件缓存记录。
 *
 * @param hash 附件内容的 SHA-256 哈希。
 * @returns 已存在的缓存记录；不存在时返回 null。
 */
export async function findAttachmentByHash(
    hash: string,
    database: DatabaseExecutor = db
): Promise<AttachmentEntity | null> {
    return (
        (await database.select().from(attachments).where(eq(attachments.hash, hash)).get()) ?? null
    );
}

/**
 * 创建附件缓存记录。
 *
 * @param data 附件缓存元数据。
 * @returns 新创建的附件记录。
 */
export async function createAttachmentRecord(
    data: AttachmentCreateData,
    database: DatabaseExecutor = db
): Promise<AttachmentEntity> {
    const createdAttachment = await database.insert(attachments).values(data).returning().get();

    if (!createdAttachment || createdAttachment.id === undefined) {
        throw new Error('Failed to load created attachment record');
    }

    return createdAttachment;
}

/**
 * 创建消息与附件的关联记录。
 *
 * @param data 消息附件关联数据。
 * @returns void
 */
export async function createMessageAttachment(
    data: MessageAttachmentCreateData,
    database: DatabaseExecutor = db
): Promise<void> {
    const maximum = await database
        .select({ value: sql<number>`coalesce(max(${messageParts.sort_order}), -1)` })
        .from(messageParts)
        .where(eq(messageParts.message_id, data.message_id))
        .get();
    await database
        .insert(messageParts)
        .values({
            message_id: data.message_id,
            type: 'attachment',
            content: '',
            attachment_id: data.attachment_id,
            data: JSON.stringify({ originPath: data.origin_path }),
            sort_order: (maximum?.value ?? -1) + 1,
            ...(data.created_at ? { created_at: data.created_at } : {}),
        })
        .run();
}

/**
 * 按消息批量加载附件。
 *
 * @param messageIds 消息主键集合。
 * @returns 附件关联行，已按消息与顺序排序。
 */
export async function findAttachmentsByMessageIds(
    messageIds: number[]
): Promise<MessageAttachmentRow[]> {
    if (messageIds.length === 0) {
        return [];
    }

    return db
        .select({
            message_id: messageParts.message_id,
            sort_order: messageParts.sort_order,
            id: attachments.id,
            hash: attachments.hash,
            type: attachments.type,
            original_name: attachments.original_name,
            origin_path: sql<string>`json_extract(${messageParts.data}, '$.originPath')`,
            mime_type: attachments.mime_type,
            size: attachments.size,
            created_at: attachments.created_at,
        })
        .from(messageParts)
        .innerJoin(attachments, eq(attachments.id, messageParts.attachment_id))
        .where(
            and(inArray(messageParts.message_id, messageIds), eq(messageParts.type, 'attachment'))
        )
        .orderBy(asc(messageParts.message_id), asc(messageParts.sort_order), asc(messageParts.id))
        .all();
}
