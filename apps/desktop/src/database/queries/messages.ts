// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, asc, count, desc, eq, gt, gte, inArray, lt, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import { messages } from '../schema';
import type { MessageCreateData, MessageEntity, MessagePartEntity } from '../types';
import { findAttachmentsByMessageIds, type MessageAttachmentRow } from './attachments';
import { findMessagePartsByMessageIds } from './messageParts';
import { buildSessionSearchTrigramExpression } from './sessionSearchTrigrams';

/** A database message is returned once, with its ordered parts and resolved attachments. */
export interface MessageRow extends MessageEntity {
    parts: MessagePartEntity[];
    attachments: MessageAttachmentRow[];
}

export interface ConversationSearchMessage {
    id: number;
    session_id: number;
    role: 'user' | 'assistant';
    content: string;
}

/** 为一批消息补全 parts 与附件，避免逐条查询。 */
async function hydrateMessageRows(
    rows: MessageEntity[],
    database: DatabaseExecutor = db
): Promise<MessageRow[]> {
    const ids = rows.map((row) => row.id);
    const [parts, attachments] = await Promise.all([
        findMessagePartsByMessageIds(ids, database),
        findAttachmentsByMessageIds(ids, database),
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

export async function findMessagesBySessionId(
    sessionId: number,
    database: DatabaseExecutor = db
): Promise<MessageRow[]> {
    const rows = await database
        .select()
        .from(messages)
        .where(eq(messages.session_id, sessionId))
        .orderBy(asc(messages.id))
        .all();

    return hydrateMessageRows(rows, database);
}

/**
 * Loads at most the first and last 50 eligible messages for every candidate session in one
 * database round trip. System and tool messages never enter the ranking payload.
 */
export async function findConversationSearchMessagesBySessionIds(
    sessionIds: readonly number[],
    roles: readonly ('user' | 'assistant')[],
    database: DatabaseExecutor = db
): Promise<ConversationSearchMessage[]> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    const uniqueRoles = [...new Set(roles)].filter(
        (role): role is 'user' | 'assistant' => role === 'user' || role === 'assistant'
    );
    if (uniqueSessionIds.length === 0 || uniqueRoles.length === 0) return [];

    const roleValues = sql.join(
        uniqueRoles.map((role) => sql`${role}`),
        sql`, `
    );

    const rows = await database.all<[number, number, 'user' | 'assistant', string]>(sql`
        WITH candidate_sessions(session_id) AS (
            SELECT value
            FROM json_each(${JSON.stringify(uniqueSessionIds)})
        ),
        selected_message_ids(session_id, message_id) AS (
            SELECT
                candidate_sessions.session_id AS session_id,
                first_messages.value AS message_id
            FROM candidate_sessions,
                 json_each((
                     SELECT json_group_array(id)
                     FROM (
                         SELECT messages.id
                         FROM messages
                         WHERE messages.session_id = candidate_sessions.session_id
                           AND messages.role IN (${roleValues})
                         ORDER BY messages.id
                         LIMIT 50
                     )
                 )) AS first_messages
            UNION
            SELECT
                candidate_sessions.session_id AS session_id,
                last_messages.value AS message_id
            FROM candidate_sessions,
                 json_each((
                     SELECT json_group_array(id)
                     FROM (
                         SELECT messages.id
                         FROM messages
                         WHERE messages.session_id = candidate_sessions.session_id
                           AND messages.role IN (${roleValues})
                         ORDER BY messages.id DESC
                         LIMIT 50
                     )
                 )) AS last_messages
        )
        SELECT
            messages.id AS id,
            messages.session_id AS session_id,
            messages.role AS role,
            coalesce((
                SELECT group_concat(parts.content, '')
                FROM (
                    SELECT content
                    FROM message_parts
                    WHERE message_id = messages.id
                      AND type = 'text'
                    ORDER BY sort_order, id
                ) AS parts
            ), '') AS content
        FROM selected_message_ids
        INNER JOIN messages
            ON messages.id = selected_message_ids.message_id
        WHERE messages.session_id IN (${sql.join(
            uniqueSessionIds.map((sessionId) => sql`${sessionId}`),
            sql`, `
        )})
          AND messages.role IN (${roleValues})
        ORDER BY messages.session_id, messages.id
    `);
    return rows.map(([id, sessionId, role, content]) => ({
        id,
        session_id: sessionId,
        role,
        content,
    }));
}

/**
 * Returns the latest keyword matches per candidate session, bounded per session. The trigram
 * index narrows candidates; the caller re-validates and cleans the text, so this returns a
 * larger candidate window than the final snippet count. Unlike the ranking sample this can
 * reach a real hit from the middle of a long conversation.
 */
export async function findConversationSearchMatchMessages(
    sessionIds: readonly number[],
    roles: readonly ('user' | 'assistant')[],
    query: string,
    limitPerSession: number,
    database: DatabaseExecutor = db
): Promise<ConversationSearchMessage[]> {
    const uniqueSessionIds = [...new Set(sessionIds)];
    const uniqueRoles = [...new Set(roles)].filter(
        (role): role is 'user' | 'assistant' => role === 'user' || role === 'assistant'
    );
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const perSession = Math.min(50, Math.max(1, Math.floor(limitPerSession)) * 10);
    if (uniqueSessionIds.length === 0 || uniqueRoles.length === 0 || !normalizedQuery) return [];

    const roleValues = sql.join(
        uniqueRoles.map((role) => sql`${role}`),
        sql`, `
    );
    const trigramExpression = buildSessionSearchTrigramExpression(normalizedQuery);
    const indexedCandidates = trigramExpression
        ? sql`AND messages.id IN (
                SELECT rowid FROM message_search_fts
                WHERE message_search_fts MATCH ${trigramExpression}
            )`
        : sql``;
    // SQLite lower() folds ASCII only, while the caller matches with Unicode case folding.
    // When trigram candidates are available they are already case-insensitive across scripts;
    // otherwise keep the ASCII fallback and let the caller verify the full text.
    const fallbackTextFilter = trigramExpression
        ? sql``
        : sql`AND instr(lower(content), ${normalizedQuery}) > 0`;

    const rows = await database.all<[number, number, 'user' | 'assistant', string]>(sql`
        WITH candidate_sessions(session_id) AS (
            SELECT value
            FROM json_each(${JSON.stringify(uniqueSessionIds)})
        ),
        message_text AS (
            SELECT
                messages.id AS id,
                messages.session_id AS session_id,
                messages.role AS role,
                coalesce((
                    SELECT group_concat(parts.content, '')
                    FROM (
                        SELECT content
                        FROM message_parts
                        WHERE message_id = messages.id AND type = 'text'
                        ORDER BY sort_order, id
                    ) AS parts
                ), '') AS content
            FROM messages
            INNER JOIN candidate_sessions
                ON candidate_sessions.session_id = messages.session_id
            WHERE messages.role IN (${roleValues})
              ${indexedCandidates}
        ),
        matched AS (
            SELECT
                id,
                session_id,
                role,
                content,
                ROW_NUMBER() OVER (
                    PARTITION BY session_id
                    ORDER BY id DESC
                ) AS match_rank
            FROM message_text
            WHERE 1 = 1
              ${fallbackTextFilter}
        )
        SELECT id, session_id, role, content
        FROM matched
        WHERE match_rank <= ${perSession}
        ORDER BY session_id, id
    `);
    return rows.map(([id, sessionId, role, content]) => ({
        id,
        session_id: sessionId,
        role,
        content,
    }));
}

/** Separate range and point reads keep the session/id index usable for long archives. */
export async function findContextMessageRows(
    sessionId: number,
    options: { firstId?: number; beforeId?: number; ids?: number[] },
    database: DatabaseExecutor = db
): Promise<MessageRow[]> {
    if (options.ids?.length === 0) return [];
    const rows = await database
        .select()
        .from(messages)
        .where(
            and(
                eq(messages.session_id, sessionId),
                options.firstId === undefined ? undefined : gte(messages.id, options.firstId),
                options.beforeId === undefined ? undefined : lt(messages.id, options.beforeId),
                options.ids === undefined ? undefined : inArray(messages.id, options.ids)
            )
        )
        .orderBy(asc(messages.id))
        .all();
    return hydrateMessageRows(rows, database);
}

export interface ConversationReadMessage {
    id: number;
    role: 'user' | 'assistant';
    created_at: string;
    content: string;
}

export async function findMessageInSession(
    sessionId: number,
    messageId: number,
    database: DatabaseExecutor = db
): Promise<boolean> {
    const row = await database
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.session_id, sessionId), eq(messages.id, messageId)))
        .get();
    return row !== undefined;
}

/**
 * Paged conversation read. `before` walks toward older messages, `after` toward newer ones.
 * Rows are always returned ascending by id so the caller renders them in reading order.
 */
export async function findConversationMessagePage(
    options: {
        sessionId: number;
        anchorId?: number;
        direction: 'before' | 'after';
        limit: number;
        roles: readonly ('user' | 'assistant')[];
    },
    database: DatabaseExecutor = db
): Promise<ConversationReadMessage[]> {
    const roles = [...new Set(options.roles)].filter(
        (role): role is 'user' | 'assistant' => role === 'user' || role === 'assistant'
    );
    if (roles.length === 0 || options.limit <= 0) return [];

    const rows = await database
        .select({
            id: messages.id,
            role: messages.role,
            created_at: messages.created_at,
        })
        .from(messages)
        .where(
            and(
                eq(messages.session_id, options.sessionId),
                inArray(messages.role, roles),
                options.anchorId === undefined
                    ? undefined
                    : options.direction === 'before'
                      ? lt(messages.id, options.anchorId)
                      : gt(messages.id, options.anchorId)
            )
        )
        .orderBy(options.direction === 'before' ? desc(messages.id) : asc(messages.id))
        .limit(options.limit)
        .all();

    if (rows.length === 0) return [];

    const ordered = options.direction === 'before' ? [...rows].reverse() : rows;
    const parts = await findMessagePartsByMessageIds(
        ordered.map((row) => row.id),
        database
    );
    const contentByMessage = new Map<number, string>();
    for (const part of [...parts].sort(
        (left, right) => left.sort_order - right.sort_order || left.id - right.id
    )) {
        if (part.type !== 'text') continue;
        contentByMessage.set(
            part.message_id,
            (contentByMessage.get(part.message_id) ?? '') + part.content
        );
    }

    return ordered.map((row) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        created_at: row.created_at,
        content: contentByMessage.get(row.id) ?? '',
    }));
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
