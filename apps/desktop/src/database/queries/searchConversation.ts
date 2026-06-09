// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { and, desc, eq, exists, or, sql } from 'drizzle-orm';
import { aliasedTable } from 'drizzle-orm/alias';

import { redactSecretLikeContent } from '@/utils/secretLikeContent';

import { db } from '../index';
import { messages, sessions, sessionTurns } from '../schema';
import type { SessionEntity } from '../types';

export interface SearchConversationSessionsOptions {
    query?: string;
    keywords?: string[];
    keywordMode?: 'any' | 'all';
    limit?: number;
    fromDate?: string;
    toDate?: string;
    model?: string;
    role?: 'user' | 'assistant';
}

const DEFAULT_SEARCH_CONVERSATION_LIMIT = 10;
const MAX_SEARCH_CONVERSATION_LIMIT = 50;

function normalizeSearchConversationLimit(limit?: number): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return DEFAULT_SEARCH_CONVERSATION_LIMIT;
    }

    return Math.max(1, Math.min(Math.trunc(limit), MAX_SEARCH_CONVERSATION_LIMIT));
}

function escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
}

function normalizeConversationKeywords(options: SearchConversationSessionsOptions): string[] {
    return Array.from(
        new Set(
            [options.query, ...(options.keywords ?? [])]
                .map((item) => item?.trim())
                .filter((item): item is string => Boolean(item))
                .map((item) => redactSecretLikeContent(item))
        )
    ) as string[];
}

function createSearchConversationSelection() {
    const latestTurns = aliasedTable(sessionTurns, 'latest_session_turns');
    const latestTurnIdQuery = db
        .select({ value: latestTurns.id })
        .from(latestTurns)
        .where(eq(latestTurns.session_id, sessions.id))
        .orderBy(desc(latestTurns.created_at), desc(latestTurns.id))
        .limit(1);
    const latestTurnStatusQuery = db
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

function buildKeywordCondition(keyword: string, role?: SearchConversationSessionsOptions['role']) {
    const searchableMessages = aliasedTable(messages, 'searchable_messages');
    const pattern = `%${escapeLikePattern(keyword.toLocaleLowerCase())}%`;
    const roleCondition = role
        ? eq(searchableMessages.role, role)
        : or(eq(searchableMessages.role, 'user'), eq(searchableMessages.role, 'assistant'))!;
    const contentMatches = exists(
        db
            .select({ id: searchableMessages.id })
            .from(searchableMessages)
            .where(
                and(
                    eq(searchableMessages.session_id, sessions.id),
                    roleCondition,
                    sql`lower(${searchableMessages.content}) LIKE ${pattern} ESCAPE '\\'`
                )
            )
            .limit(1)
    );

    if (role) {
        return contentMatches;
    }

    const titleMatches = sql`lower(${sessions.title}) LIKE ${pattern} ESCAPE '\\'`;
    const previewMatches = sql`lower(${sessions.last_message_preview}) LIKE ${pattern} ESCAPE '\\'`;
    return or(titleMatches, previewMatches, contentMatches)!;
}

export const searchConversationSessions = async (
    options: SearchConversationSessionsOptions
): Promise<SessionEntity[]> => {
    const keywords = normalizeConversationKeywords(options);
    const limit = normalizeSearchConversationLimit(options.limit);
    const keywordMode = options.keywordMode ?? 'any';
    const keywordConditions = keywords.map((keyword) =>
        buildKeywordCondition(keyword, options.role)
    );
    const filterConditions = [];

    if (options.fromDate) {
        filterConditions.push(sql`${sessions.created_at} >= ${options.fromDate}`);
    }

    if (options.toDate) {
        filterConditions.push(sql`${sessions.created_at} <= ${options.toDate}`);
    }

    if (options.model) {
        filterConditions.push(eq(sessions.model, options.model));
    }

    const keywordWhereClause =
        keywordConditions.length === 0
            ? undefined
            : keywordMode === 'all'
              ? and(...keywordConditions)
              : or(...keywordConditions);
    const whereParts = [keywordWhereClause, ...filterConditions].filter(Boolean);
    const whereClause = whereParts.length > 0 ? and(...whereParts) : undefined;

    const query = db
        .select(createSearchConversationSelection())
        .from(sessions)
        .orderBy(
            desc(sql`coalesce(${sessions.last_message_at}, ${sessions.updated_at})`),
            desc(sessions.id)
        )
        .limit(limit);

    return whereClause ? query.where(whereClause).all() : query.all();
};
