import { findConversationMessagePage, findMessageInSession } from '@/database/queries/messages';
import { findSessionByPublicId } from '@/database/queries/sessions';

import type { ReadConversationHistory } from './create';

export const databaseReadConversationHistory: ReadConversationHistory = Object.freeze({
    async findSession(sessionId: string) {
        const session = await findSessionByPublicId(sessionId);
        if (!session) return null;
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
    async hasMessage(sessionId: number, messageId: number) {
        return findMessageInSession(sessionId, messageId);
    },
});
