// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { asc, eq, inArray } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { attachments, messageAttachments } from '../schema';
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
    await database.insert(messageAttachments).values(data).run();
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
            message_id: messageAttachments.message_id,
            sort_order: messageAttachments.sort_order,
            id: attachments.id,
            hash: attachments.hash,
            type: attachments.type,
            original_name: attachments.original_name,
            mime_type: attachments.mime_type,
            size: attachments.size,
            created_at: attachments.created_at,
        })
        .from(messageAttachments)
        .innerJoin(attachments, eq(attachments.id, messageAttachments.attachment_id))
        .where(inArray(messageAttachments.message_id, messageIds))
        .orderBy(
            asc(messageAttachments.message_id),
            asc(messageAttachments.sort_order),
            asc(messageAttachments.id)
        )
        .all();
}
