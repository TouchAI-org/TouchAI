// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, count, desc, eq, exists, or, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';

import { db } from '../index';
import { messages, models, sessions, sessionTurns } from '../schema';
import type { SessionCreateData, SessionEntity, SessionUpdateData } from '../types';

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

/**
 * 创建会话。
 */
export const createSession = async (data: SessionCreateData): Promise<SessionEntity> => {
    const createdSession = await db.getDb().insert(sessions).values(data).returning().get();

    if (!createdSession || createdSession.id === undefined) {
        throw new Error('Failed to create session');
    }

    return createdSession;
};

/**
 * 根据主键查找会话。
 */
export const findSessionById = async (sessionId: number): Promise<SessionEntity | undefined> =>
    db.getDb().select().from(sessions).where(eq(sessions.id, sessionId)).get();

/**
 * 列出会话。
 */
export const listSessions = async (options: ListSessionsOptions = {}): Promise<SessionEntity[]> => {
    const query = options.query?.trim().toLocaleLowerCase() ?? '';
    const limit = normalizeSessionLimit(options.limit);
    const drizzle = db.getDb();
    const searchableMessages = aliasedTable(messages, 'searchable_messages');

    if (query) {
        const pattern = `%${escapeLikePattern(query)}%`;
        const titleMatches = sql`lower(${sessions.title}) LIKE ${pattern} ESCAPE '\\'`;
        const contentMatches = exists(
            drizzle
                .select({ id: searchableMessages.id })
                .from(searchableMessages)
                .where(
                    and(
                        eq(searchableMessages.session_id, sessions.id),
                        or(
                            eq(searchableMessages.role, 'user'),
                            eq(searchableMessages.role, 'assistant'),
                            eq(searchableMessages.role, 'tool_result')
                        ),
                        sql`lower(${searchableMessages.content}) LIKE ${pattern} ESCAPE '\\'`
                    )
                )
                .limit(1)
        );
        const searchWhereClause = or(titleMatches, contentMatches)!;

        return drizzle
            .select()
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
        .select()
        .from(sessions)
        .orderBy(
            desc(sql`coalesce(${sessions.last_message_at}, ${sessions.updated_at})`),
            desc(sessions.id)
        )
        .limit(limit)
        .all();
};

/**
 * 更新会话基础字段。
 */
export const updateSession = async ({
    id,
    sessionPatch,
}: {
    id: number;
    sessionPatch: SessionUpdateData;
}): Promise<void> => {
    await db
        .getDb()
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
 * - `tool_call` 默认不参与摘要优先级，避免把工具入参刷成会话预览；
 * - 若 assistant 尚未落库，则退回到非空 `tool_result`，再退到用户消息；
 * - 只有异常链路完全没有可读消息时，才回退到非空 `tool_call`，尽量保证列表可见；
 * - 读路径只读 sessions 表，避免列表查询为每条会话重复扫描 messages。
 */
export const refreshSessionMetadata = async (sessionId: number): Promise<void> => {
    const drizzle = db.getDb();
    const assistantMessages = aliasedTable(messages, 'assistant_messages');
    const toolResultMessages = aliasedTable(messages, 'tool_result_messages');
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
                eq(assistantMessages.role, 'assistant')
            )
        )
        .orderBy(desc(assistantMessages.created_at), desc(assistantMessages.id))
        .limit(1);

    const toolResultTimestampQuery = drizzle
        .select({ value: toolResultMessages.created_at })
        .from(toolResultMessages)
        .where(
            and(
                eq(toolResultMessages.session_id, sessionId),
                eq(toolResultMessages.role, 'tool_result'),
                sql`trim(${toolResultMessages.content}) <> ''`
            )
        )
        .orderBy(desc(toolResultMessages.created_at), desc(toolResultMessages.id))
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
                sql`trim(${toolCallMessages.content}) <> ''`
            )
        )
        .orderBy(desc(toolCallMessages.created_at), desc(toolCallMessages.id))
        .limit(1);

    const assistantPreviewQuery = drizzle
        .select({
            value: sql<string>`
                CASE
                    WHEN length(${assistantMessages.content}) > 160
                        THEN substr(${assistantMessages.content}, 1, 160) || '...'
                    ELSE ${assistantMessages.content}
                END
            `,
        })
        .from(assistantMessages)
        .where(
            and(
                eq(assistantMessages.session_id, sessionId),
                eq(assistantMessages.role, 'assistant')
            )
        )
        .orderBy(desc(assistantMessages.created_at), desc(assistantMessages.id))
        .limit(1);

    const toolResultPreviewQuery = drizzle
        .select({
            value: sql<string>`
                CASE
                    WHEN length(${toolResultMessages.content}) > 160
                        THEN substr(${toolResultMessages.content}, 1, 160) || '...'
                    ELSE ${toolResultMessages.content}
                END
            `,
        })
        .from(toolResultMessages)
        .where(
            and(
                eq(toolResultMessages.session_id, sessionId),
                eq(toolResultMessages.role, 'tool_result'),
                sql`trim(${toolResultMessages.content}) <> ''`
            )
        )
        .orderBy(desc(toolResultMessages.created_at), desc(toolResultMessages.id))
        .limit(1);

    const userPreviewQuery = drizzle
        .select({
            value: sql<string>`
                CASE
                    WHEN length(${userMessages.content}) > 160
                        THEN substr(${userMessages.content}, 1, 160) || '...'
                    ELSE ${userMessages.content}
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
                    WHEN length(${toolCallMessages.content}) > 160
                        THEN substr(${toolCallMessages.content}, 1, 160) || '...'
                    ELSE ${toolCallMessages.content}
                END
            `,
        })
        .from(toolCallMessages)
        .where(
            and(
                eq(toolCallMessages.session_id, sessionId),
                eq(toolCallMessages.role, 'tool_call'),
                sql`trim(${toolCallMessages.content}) <> ''`
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
                    (${toolResultTimestampQuery}),
                    (${userTimestampQuery}),
                    (${toolCallTimestampQuery})
                )
            `,
            last_message_preview: sql<string | null>`
                coalesce(
                    (${assistantPreviewQuery}),
                    (${toolResultPreviewQuery}),
                    (${userPreviewQuery}),
                    (${toolCallPreviewQuery})
                )
            `,
            provider_id: sql<number | null>`(${latestProviderIdQuery})`,
            updated_at: sql`datetime('now')`,
        })
        .where(eq(sessions.id, sessionId))
        .run();
};

/**
 * 统计会话数量。
 */
export const countSessions = async (): Promise<number> => {
    const result = await db.getDb().select({ count: count() }).from(sessions).get();
    return result?.count || 0;
};

/**
 * 删除所有会话。
 */
export const deleteAllSessions = async (): Promise<void> => {
    await db.getDb().delete(sessions).run();
};
