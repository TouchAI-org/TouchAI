import { findMessagesBySessionId } from '@/database/queries/messages';
import {
    createSession as insertSession,
    dismissSessionTerminalStatus as dismissStatus,
    findSessionById,
    listSessions as selectSessions,
} from '@/database/queries/sessions';
import { findSessionTurnAttemptsBySessionId } from '@/database/queries/sessionTurnAttempts';
import { findSessionTurnsBySessionId } from '@/database/queries/sessionTurns';

import type {
    SessionHistoryData,
    SessionListItem,
    SessionListOptions,
} from '../contracts/historyRead';

export async function readSessionHistoryData(sessionId: number): Promise<SessionHistoryData> {
    const session = await findSessionById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    const [messages, turns, attempts] = await Promise.all([
        findMessagesBySessionId(sessionId),
        findSessionTurnsBySessionId(sessionId),
        findSessionTurnAttemptsBySessionId(sessionId),
    ]);
    return {
        session: {
            id: session.id,
            session_id: session.session_id,
            title: session.title,
            model: session.model,
            provider_id: session.provider_id,
            created_at: session.created_at,
            updated_at: session.updated_at,
        },
        messages,
        turns,
        attempts,
    };
}

export async function createSession(
    title: string,
    model: string,
    providerId?: number | null
): Promise<number> {
    const session = await insertSession({
        session_id: crypto.randomUUID(),
        title,
        model,
        provider_id: providerId ?? null,
    });
    return session.id;
}

export const listSessions = (options: SessionListOptions = {}): Promise<SessionListItem[]> =>
    selectSessions(options);
export const dismissSessionTerminalStatus = (sessionId: number) => dismissStatus(sessionId);
