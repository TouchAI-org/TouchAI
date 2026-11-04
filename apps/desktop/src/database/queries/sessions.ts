// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';
import { and, count, desc, eq, or, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';

import { type DatabaseExecutor, db } from '../index';
import { messages, models, sessions, sessionTurns } from '../schema';
import type { SessionCreateData, SessionEntity, SessionUpdateData } from '../types';
import { messageText } from './messageParts';

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

/**
 * 创建会话。
 */
export const createSession = async (
    data: SessionCreateData,
    database: DatabaseExecutor = db
): Promise<SessionEntity> => {
    // Task writes still join the caller's Drizzle transaction until their Rust bundle lands.
    if (database === db) {
        const createdSession = await native.database.operation<SessionEntity | null>({
            kind: 'session_create',
            data: { ...data },
        });

        if (!createdSession || createdSession.id === undefined) {
            throw new Error('Failed to create session');
        }

        return createdSession;
    }

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
    (await native.database.operation<SessionEntity | null>({
        kind: 'session_find_by_id',
        id: sessionId,
    })) ?? undefined;

/**
 * 列出会话。
 */
export const listSessions = async (options: ListSessionsOptions = {}): Promise<SessionEntity[]> => {
    return native.database.operation<SessionEntity[]>({
        kind: 'session_list',
        query: options.query?.trim().toLocaleLowerCase(),
        limit: normalizeSessionLimit(options.limit),
    });
};

export const dismissSessionTerminalStatus = async (sessionId: number): Promise<void> => {
    await native.database.operation({
        kind: 'session_dismiss_terminal_status',
        id: sessionId,
    });
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
    // Task writes still join the caller's Drizzle transaction until their Rust bundle lands.
    if (database === db) {
        await native.database.operation({
            kind: 'session_update',
            id,
            data: { ...sessionPatch },
        });
        return;
    }

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
    // Task writes still join the caller's Drizzle transaction until their Rust bundle lands.
    if (database === db) {
        await native.database.operation({
            kind: 'session_refresh_metadata',
            id: sessionId,
        });
        return;
    }

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
    return native.database.operation<number>({ kind: 'session_count' });
};

/**
 * 删除所有会话。
 */
export const deleteAllSessions = async (): Promise<void> => {
    await native.database.operation({ kind: 'session_delete_all' });
};
