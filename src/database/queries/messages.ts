// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { UpdateResult } from 'kysely';

import { db } from '../index';
import type { Message, MessageRole, MessageUpdate, NewMessage } from '../schema';

/**
 * 根据 ID 查找消息
 */
export const findMessageById = async (id: number) =>
    (await db.getKysely())
        .selectFrom('messages')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

/**
 * 根据会话 ID 查找所有消息
 */
export const findMessagesBySessionId = async (sessionId: number) =>
    (await db.getKysely())
        .selectFrom('messages')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy('created_at', 'asc')
        .execute();

/**
 * 根据会话 ID 和角色查找消息
 */
export const findMessagesBySessionIdAndRole = async (sessionId: number, role: MessageRole) =>
    (await db.getKysely())
        .selectFrom('messages')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('role', '=', role)
        .orderBy('created_at', 'asc')
        .execute();

/**
 * 获取会话的最新消息
 */
export const getLatestMessages = async (sessionId: number, limit: number = 10) =>
    (await db.getKysely())
        .selectFrom('messages')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute();

/**
 * 搜索消息
 */
export const searchMessages = async (keyword: string, sessionId?: number) => {
    const pattern = `%${keyword}%`;
    let query = (await db.getKysely())
        .selectFrom('messages')
        .selectAll()
        .where('content', 'like', pattern);

    if (sessionId !== undefined) {
        query = query.where('session_id', '=', sessionId);
    }

    return query.orderBy('created_at', 'desc').execute();
};

/**
 * 创建消息
 */
export const createMessage = async (data: NewMessage): Promise<Message> => {
    await (await db.getKysely()).insertInto('messages').values(data).execute();

    // 获取最后插入的记录
    const lastInsert = await (await db.getKysely())
        .selectFrom('messages')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst();

    if (!lastInsert) {
        throw new Error('Failed to create message');
    }
    return lastInsert;
};

/**
 * 批量创建消息
 */
export const createMessages = async (data: NewMessage[]): Promise<Message[]> => {
    await (await db.getKysely()).insertInto('messages').values(data).execute();

    // 获取最后插入的记录
    const lastInserts = await (await db.getKysely())
        .selectFrom('messages')
        .selectAll()
        .orderBy('id', 'desc')
        .limit(data.length)
        .execute();

    return lastInserts;
};

/**
 * 更新消息
 */
export const updateMessage = async (id: number, data: MessageUpdate): Promise<UpdateResult> => {
    const result = await (await db.getKysely())
        .updateTable('messages')
        .set(data)
        .where('id', '=', id)
        .executeTakeFirst();

    if (!result || result.numUpdatedRows === 0n) {
        throw new Error(`Message with id ${id} not found`);
    }

    return result;
};

/**
 * 删除消息
 */
export const deleteMessage = async (id: number): Promise<boolean> => {
    const result = await (await db.getKysely())
        .deleteFrom('messages')
        .where('id', '=', id)
        .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
};

/**
 * 删除会话的所有消息
 */
export const deleteMessagesBySessionId = async (sessionId: number): Promise<number> => {
    const result = await (await db.getKysely())
        .deleteFrom('messages')
        .where('session_id', '=', sessionId)
        .executeTakeFirst();

    return Number(result.numDeletedRows);
};

/**
 * 统计会话的消息数
 */
export const countMessagesBySessionId = async (sessionId: number): Promise<number> => {
    const result = await (
        await db.getKysely()
    )
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('session_id', '=', sessionId)
        .executeTakeFirst();

    return result?.count || 0;
};

/**
 * 统计所有消息数
 */
export const countMessages = async (): Promise<number> => {
    const result = await (
        await db.getKysely()
    )
        .selectFrom('messages')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirst();

    return result?.count || 0;
};

/**
 * 删除所有消息
 */
export const deleteAllMessages = async (): Promise<number> => {
    const result = await (await db.getKysely()).deleteFrom('messages').executeTakeFirst();

    return Number(result.numDeletedRows);
};

/**
 * 获取消息及会话信息（JOIN 查询）
 */
export const findMessageWithSession = async (messageId: number) =>
    (await db.getKysely())
        .selectFrom('messages')
        .innerJoin('sessions', 'sessions.id', 'messages.session_id')
        .select([
            'messages.id',
            'messages.session_id',
            'messages.role',
            'messages.content',
            'messages.created_at',
            'messages.updated_at',
            'sessions.title as session_title',
            'sessions.model as session_model',
        ])
        .where('messages.id', '=', messageId)
        .executeTakeFirst();
