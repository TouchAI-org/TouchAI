import {
    type ConversationSearchMessage,
    findConversationSearchMatchCandidates,
    findConversationSearchMessagesBySessionIds,
} from '@/database/queries/messages';
import { listSessions, type ListSessionsOptions } from '@/database/queries/sessions';

import {
    CONVERSATION_SEARCH_MATCH_MAX_CANDIDATES,
    CONVERSATION_SEARCH_MATCH_PAGE_SIZE,
} from './constants';
import type { SearchConversationHistory } from './create';
import { extractMatchedSnippet } from './operations';

function hasCasedCharacter(value: string): boolean {
    for (const character of value) {
        if (character.toLocaleLowerCase() !== character.toLocaleUpperCase()) return true;
    }
    return false;
}

export const databaseSearchConversationHistory: SearchConversationHistory = Object.freeze({
    async listCandidates(options: Parameters<SearchConversationHistory['listCandidates']>[0]) {
        const sessions = await listSessions({
            query: options.query,
            limit: options.limit,
            fromDate: options.fromDate,
            toDate: options.toDate,
            model: options.model,
            roles: options.roles,
            textContentOnly: options.textContentOnly,
        } satisfies ListSessionsOptions);
        return sessions.map((session) => ({
            id: session.id,
            session_id: session.session_id,
            title: session.title,
            model: session.model,
            created_at: session.created_at,
            last_message_at: session.last_message_at,
            message_count: session.message_count,
            archived_at: session.archived_at,
        }));
    },
    async findMessages(
        sessionIds: Parameters<SearchConversationHistory['findMessages']>[0],
        roles: Parameters<SearchConversationHistory['findMessages']>[1]
    ) {
        return (await findConversationSearchMessagesBySessionIds(
            sessionIds,
            roles
        )) satisfies ConversationSearchMessage[];
    },
    async findMatchMessages(
        sessionIds: Parameters<SearchConversationHistory['findMatchMessages']>[0],
        roles: Parameters<SearchConversationHistory['findMatchMessages']>[1],
        query: Parameters<SearchConversationHistory['findMatchMessages']>[2],
        limitPerSession: Parameters<SearchConversationHistory['findMatchMessages']>[3]
    ) {
        const normalizedQuery = query.trim().toLocaleLowerCase();
        if (sessionIds.length === 0 || roles.length === 0 || !normalizedQuery) return [];

        const perSession = Math.max(1, Math.floor(limitPerSession));
        // SQLite lower() folds ASCII only, so its substring filter is exact only when the
        // query has no cased characters for either folding to differ on.
        const foldedTextOnly = !hasCasedCharacter(normalizedQuery);
        const counts = new Map<number, number>();
        const remainingSessionIds = new Set(sessionIds);
        const matches: ConversationSearchMessage[] = [];
        let scanned = 0;
        let cursor: { sessionId: number; messageId: number } | undefined;

        while (scanned < CONVERSATION_SEARCH_MATCH_MAX_CANDIDATES && remainingSessionIds.size > 0) {
            const page = await findConversationSearchMatchCandidates({
                sessionIds: [...remainingSessionIds],
                roles,
                query: normalizedQuery,
                limit: CONVERSATION_SEARCH_MATCH_PAGE_SIZE,
                foldedTextOnly,
                cursor,
            });
            if (page.length === 0) break;

            for (const message of page) {
                if ((counts.get(message.session_id) ?? 0) >= perSession) continue;
                if (!message.content.toLocaleLowerCase().includes(normalizedQuery)) continue;
                if (!extractMatchedSnippet(message.content, query)) continue;
                matches.push(message);
                counts.set(message.session_id, (counts.get(message.session_id) ?? 0) + 1);
            }

            scanned += page.length;
            // Sessions that already have enough anchors must not keep consuming the global
            // candidate budget, or they can starve every session ordered after them.
            for (const sessionId of remainingSessionIds) {
                if ((counts.get(sessionId) ?? 0) >= perSession) {
                    remainingSessionIds.delete(sessionId);
                }
            }
            if (remainingSessionIds.size === 0) break;
            if (page.length < CONVERSATION_SEARCH_MATCH_PAGE_SIZE) break;
            const last = page[page.length - 1]!;
            cursor = { sessionId: last.session_id, messageId: last.id };
        }

        return matches.sort(
            (left, right) => left.session_id - right.session_id || left.id - right.id
        );
    },
});
