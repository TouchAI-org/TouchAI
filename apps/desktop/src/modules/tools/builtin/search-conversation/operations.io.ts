import {
    type ConversationSearchMessage,
    findConversationSearchMessagesBySessionIds,
} from '@/database/queries/messages';
import { listSessions, type ListSessionsOptions } from '@/database/queries/sessions';

import type { SearchConversationHistory } from './create';

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
});
