import { findConversationMessagePage } from '@/database/queries/messages';
import { findSessionById } from '@/database/queries/sessions';

import type { ReadConversationHistory } from './create';

export const databaseReadConversationHistory: ReadConversationHistory = Object.freeze({
    async findSession(sessionId: string) {
        const numericId = Number(sessionId);
        if (!Number.isInteger(numericId) || numericId <= 0) return null;
        const session = await findSessionById(numericId);
        if (!session || session.session_id !== sessionId) return null;
        return {
            id: session.id,
            session_id: session.session_id,
            title: session.title,
            model: session.model,
            created_at: session.created_at,
            archived: !!session.archived_at,
        };
    },
    async listMessages(options: Parameters<ReadConversationHistory['listMessages']>[0]) {
        return findConversationMessagePage(options);
    },
});
