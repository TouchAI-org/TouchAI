import { countMessages, deleteAllMessages } from '@/database/queries/messages';
import { countSessions, deleteAllSessions } from '@/database/queries/sessions';
import { countSessionTurns, deleteAllSessionTurns } from '@/database/queries/sessionTurns';

export function createHistoryMaintenance() {
    return Object.freeze({
        async stats() {
            const [sessions, messages, sessionTurns] = await Promise.all([
                countSessions(),
                countMessages(),
                countSessionTurns(),
            ]);
            return { sessions, messages, sessionTurns };
        },
        async clear(category: 'sessions' | 'messages' | 'sessionTurns') {
            if (category === 'sessions') await deleteAllSessions();
            else if (category === 'messages') await deleteAllMessages();
            else if (category === 'sessionTurns') await deleteAllSessionTurns();
            else throw new Error('UNKNOWN_HISTORY_CATEGORY');
        },
    });
}
