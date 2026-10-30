// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';

import { type DatabaseExecutor, db } from '../index';
import { messages, models, sessions, sessionTurns } from '../schema';
import type { SessionCreateData, SessionEntity, SessionUpdateData } from '../types';
import { messageText } from './messageParts';
import { buildSessionSearchTrigramExpression } from './sessionSearchTrigrams';

export interface ListSessionsOptions {
    query?: string;
    limit?: number;
}

const DEFAULT_SESSION_LIMIT = 40;
const MAX_SESSION_LIMIT = 1000;

function normalizeSessionLimit(limit?: number): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return DEFAULT_SESSION_LIMIT;
    }

    return Math.max(1, Math.min(Math.trunc(limit), MAX_SESSION_LIMIT));
}

function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
}

function isTerminalTurnStatus(
    status: string | null | undefined
): status is NonNullable<SessionEntity['pending_terminal_status']> {
    return status === 'completed' || status === 'failed';
}

function createSessionListSelection(drizzle: typeof db) {
    const latestTurns = aliasedTable(sessionTurns, 'latest_session_turns');
    const latestTurnIdQuery = drizzle
        .select({ value: latestTurns.id })
        .from(latestTurns)
        .where(eq(latestTurns.session_id, sessions.id))
        .orderBy(desc(latestTurns.created_at), desc(latestTurns.id))
        .limit(1);
    const latestTurnStatusQuery = drizzle
        .select({ value: latestTurns.status })
        .from(latestTurns)
        .where(eq(latestTurns.session_id, sessions.id))
        .orderBy(desc(latestTurns.created_at), desc(latestTurns.id))
        .limit(1);

    return {
        id: sessions.id,
        session_id: sessions.session_id,
        title: sessions.title,
        model: sessions.model,
        provider_id: sessions.provider_id,
        last_message_preview: sessions.last_message_preview,
        last_message_at: sessions.last_message_at,
        message_count: sessions.message_count,
        status_badge_dismissed_turn_id: sessions.status_badge_dismissed_turn_id,
        pending_terminal_status: sql<SessionEntity['pending_terminal_status']>`
            CASE
                WHEN (${latestTurnStatusQuery}) IN ('completed', 'failed')
                    AND coalesce((${latestTurnIdQuery}), 0) > coalesce(${sessions.status_badge_dismissed_turn_id}, 0)
                THEN (${latestTurnStatusQuery})
                ELSE NULL
            END
        `.as('pending_terminal_status'),
        pinned_at: sessions.pinned_at,
        archived_at: sessions.archived_at,
        created_at: sessions.created_at,
        updated_at: sessions.updated_at,
    };
}

/**
 * 创建会话。
 */
export const createSession = async (
    data: SessionCreateData,
    database: DatabaseExecutor = db
): Promise<SessionEntity> => {
    const createdSession = await database.insert(sessions).values(data).returning().get();

    if (!createdSession || createdSession.id === undefined) {
        throw new Error('Failed to create session');
    }

    return {
        ...createdSession,
        status_badge_dismissed_turn_id: createdSession.status_badge_dismissed_turn_id ?? null,
        pending_terminal_status: null,
    };
};

/**
 * 根据主键查找会话。
 */
export const findSessionById = async (sessionId: number): Promise<SessionEntity | undefined> =>
    await db
        .select(createSessionListSelection(db))
        .from(sessions)
        .where(eq(sessions.id, sessionId))
        .get();

/**
 * 列出会话。
 */
export const listSessions = async (options: ListSessionsOptions = {}): Promise<SessionEntity[]> => {
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    const limit = normalizeSessionLimit(options.limit);
    const drizzle = db;
    const searchableMessages = aliasedTable(messages, 'searchable_messages');
    const sessionSelection = createSessionListSelection(drizzle);

    if (query) {
        const pattern = `%${escapeLikePattern(query)}%`;
        const titleMatches = sql`lower(${sessions.title}) LIKE ${pattern} ESCAPE '\\'`;
        // The compact trigram index only supplies candidates, never the source text.
        // Several necessary trigrams are AND-ed to narrow the candidate set; the full
        // LIKE check below still rejects false positives and preserves old semantics.
        // Short queries (and NUL-containing input) cannot safely use trigram MATCH.
        const trigramExpression = buildSessionSearchTrigramExpression(query);
        const indexedCandidates = trigramExpression
            ? sql`${searchableMessages.id} IN (
                    SELECT rowid FROM message_search_fts
                    WHERE message_search_fts MATCH ${trigramExpression}
                )`
            : undefined;
        const contentMatches = inArray(
            sessions.id,
            drizzle
                .select({ sessionId: searchableMessages.session_id })
                .from(searchableMessages)
                .where(
                    and(
                        or(
                            eq(searchableMessages.role, 'user'),
                            eq(searchableMessages.role, 'assistant'),
                            eq(searchableMessages.role, 'tool_call')
                        ),
                        indexedCandidates,
                        sql`lower(${messageText(searchableMessages.id)}) LIKE ${pattern} ESCAPE '\\'`
                    )
                )
        );
        const searchWhereClause = or(titleMatches, contentMatches)!;

        return drizzle
            .select(sessionSelection)
            .from(sessions)
            .orderBy(
                desc(sql`coalesce(${sessions.last_message_at}, ${sessions.updated_at})`),
                desc(sessions.id)
            )
            .limit(limit)
            .where(searchWhereClause)
            .all();
    }

    return drizzle
        .select(sessionSelection)
        .from(sessions)
        .orderBy(
            desc(sql`coalesce(${sessions.last_message_at}, ${sessions.updated_at})`),
            desc(sessions.id)
        )
        .limit(limit)
        .all();
};

export const dismissSessionTerminalStatus = async (
    sessionId: number,
    database: DatabaseExecutor = db
): Promise<void> => {
    const latestTurn = await database
        .select({
            id: sessionTurns.id,
            status: sessionTurns.status,
        })
        .from(sessionTurns)
        .where(eq(sessionTurns.session_id, sessionId))
        .orderBy(desc(sessionTurns.created_at), desc(sessionTurns.id))
        .limit(1)
        .get();

    if (!latestTurn || !isTerminalTurnStatus(latestTurn.status)) {
        return;
    }

    await database
        .update(sessions)
        .set({
            status_badge_dismissed_turn_id: latestTurn.id,
        })
        .where(eq(sessions.id, sessionId))
        .run();
};

/**
 * 更新会话基础字段。
 */
export const updateSession = async ({
    id,
    sessionPatch,
    database = db,
}: {
    id: number;
    sessionPatch: SessionUpdateData;
    database?: DatabaseExecutor;
}): Promise<void> => {
    await database
        .update(sessions)
        .set({
            ...sessionPatch,
            updated_at: sql`datetime('now')`,
        })
        .where(eq(sessions.id, id))
        .run();
};

/**
 * 根据消息与请求记录刷新会话元数据。
 *
 * 会话列表需要频繁按“最近回复时间 / 摘要 / 计数”读取，因此把这组字段收敛到写入时回算：
 * - assistant 正文优先；
 * - 若 assistant 尚未落库，则退回到工具输出（tool_call 片段 data.output）；
 * - 再退到用户消息，保证列表始终可见；
 * - 读路径只读 sessions 表，避免列表查询为每条会话重复扫描 messages。
 */
export const refreshSessionMetadata = async (
    sessionId: number,
    database: DatabaseExecutor = db
): Promise<void> => {
    const drizzle = database;
    const assistantMessages = aliasedTable(messages, 'assistant_messages');
    const userMessages = aliasedTable(messages, 'user_messages');
    const toolCallMessages = aliasedTable(messages, 'tool_call_messages');
    const latestTurns = aliasedTable(sessionTurns, 'latest_turns');
    const latestModels = aliasedTable(models, 'latest_models');

    const assistantTimestampQuery = drizzle
        .select({ value: assistantMessages.created_at })
        .from(assistantMessages)
        .where(
            and(
                eq(assistantMessages.session_id, sessionId),
                eq(assistantMessages.role, 'assistant'),
                sql`trim(${messageText(assistantMessages.id)}) <> ''`
            )
        )
        .orderBy(desc(assistantMessages.created_at), desc(assistantMessages.id))
        .limit(1);

    const userTimestampQuery = drizzle
        .select({ value: userMessages.created_at })
        .from(userMessages)
        .where(and(eq(userMessages.session_id, sessionId), eq(userMessages.role, 'user')))
        .orderBy(desc(userMessages.created_at), desc(userMessages.id))
        .limit(1);

    const toolCallTimestampQuery = drizzle
        .select({ value: toolCallMessages.created_at })
        .from(toolCallMessages)
        .where(
            and(
                eq(toolCallMessages.session_id, sessionId),
                eq(toolCallMessages.role, 'tool_call'),
                sql`trim(${messageText(toolCallMessages.id)}) <> ''`
            )
        )
        .orderBy(desc(toolCallMessages.created_at), desc(toolCallMessages.id))
        .limit(1);

    const assistantPreviewQuery = drizzle
        .select({
            value: sql<string>`
                CASE
                    WHEN length(${messageText(assistantMessages.id)}) > 160
                        THEN substr(${messageText(assistantMessages.id)}, 1, 160) || '...'
                    ELSE ${messageText(assistantMessages.id)}
                END
            `,
        })
        .from(assistantMessages)
        .where(
            and(
                eq(assistantMessages.session_id, sessionId),
                eq(assistantMessages.role, 'assistant'),
                sql`trim(${messageText(assistantMessages.id)}) <> ''`
            )
        )
        .orderBy(desc(assistantMessages.created_at), desc(assistantMessages.id))
        .limit(1);

    const userPreviewQuery = drizzle
        .select({
            value: sql<string>`
                CASE
                    WHEN length(${messageText(userMessages.id)}) > 160
                        THEN substr(${messageText(userMessages.id)}, 1, 160) || '...'
                    ELSE ${messageText(userMessages.id)}
                END
            `,
        })
        .from(userMessages)
        .where(and(eq(userMessages.session_id, sessionId), eq(userMessages.role, 'user')))
        .orderBy(desc(userMessages.created_at), desc(userMessages.id))
        .limit(1);

    const toolCallPreviewQuery = drizzle
        .select({
            value: sql<string>`
                CASE
                    WHEN length(${messageText(toolCallMessages.id)}) > 160
                        THEN substr(${messageText(toolCallMessages.id)}, 1, 160) || '...'
                    ELSE ${messageText(toolCallMessages.id)}
                END
            `,
        })
        .from(toolCallMessages)
        .where(
            and(
                eq(toolCallMessages.session_id, sessionId),
                eq(toolCallMessages.role, 'tool_call'),
                sql`trim(${messageText(toolCallMessages.id)}) <> ''`
            )
        )
        .orderBy(desc(toolCallMessages.created_at), desc(toolCallMessages.id))
        .limit(1);

    const messageCountQuery = drizzle
        .select({ value: count() })
        .from(messages)
        .where(
            and(
                eq(messages.session_id, sessionId),
                or(eq(messages.role, 'user'), eq(messages.role, 'assistant'))
            )
        );

    const latestProviderIdQuery = drizzle
        .select({ value: latestModels.provider_id })
        .from(latestTurns)
        .innerJoin(latestModels, eq(latestModels.id, latestTurns.model_id))
        .where(eq(latestTurns.session_id, sessionId))
        .orderBy(desc(latestTurns.created_at), desc(latestTurns.id))
        .limit(1);

    await drizzle
        .update(sessions)
        .set({
            message_count: sql<number>`(${messageCountQuery})`,
            last_message_at: sql<string | null>`
                coalesce(
                    (${assistantTimestampQuery}),
                    (${toolCallTimestampQuery}),
                    (${userTimestampQuery})
                )
            `,
            last_message_preview: sql<string | null>`
                coalesce(
                    (${assistantPreviewQuery}),
                    (${toolCallPreviewQuery}),
                    (${userPreviewQuery})
                )
            `,
            provider_id: sql<
                number | null
            >`coalesce((${latestProviderIdQuery}), ${sessions.provider_id})`,
            updated_at: sql`datetime('now')`,
        })
        .where(eq(sessions.id, sessionId))
        .run();
};

/**
 * 统计会话数量。
 */
export const countSessions = async (): Promise<number> => {
    const result = await db.select({ count: count() }).from(sessions).get();
    return result?.count || 0;
};

/**
 * 删除所有会话。
 */
export const deleteAllSessions = async (): Promise<void> => {
    await db.delete(sessions).run();
};
