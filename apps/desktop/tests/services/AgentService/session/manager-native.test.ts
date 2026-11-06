import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionData } from '@/services/AgentService/session/manager';
import { getSessionData } from '@/services/AgentService/session/manager';

const mocks = vi.hoisted(() => ({
    operation: vi.fn<() => Promise<SessionData>>(),
}));

vi.mock('@services/NativeService', () => ({
    native: { database: { operation: mocks.operation } },
}));

const SESSION_DATA: SessionData = {
    session: {
        id: 12,
        session_id: 'saved-session',
        title: 'Saved conversation',
        model: 'model-1',
        provider_id: 3,
        last_message_preview: 'Answer',
        last_message_at: '2026-01-01 00:00:01',
        message_count: 2,
        status_badge_dismissed_turn_id: null,
        pending_terminal_status: null,
        pinned_at: null,
        archived_at: null,
        created_at: '2026-01-01 00:00:00',
        updated_at: '2026-01-01 00:00:01',
    },
    messages: [],
    turns: [],
    attempts: [],
    model: null,
};

describe('user opens a saved conversation', () => {
    beforeEach(() => {
        mocks.operation.mockReset();
    });

    it('user sees the native history snapshot without separate lookups', async () => {
        mocks.operation.mockResolvedValue(SESSION_DATA);

        await expect(getSessionData(12)).resolves.toBe(SESSION_DATA);
        expect(mocks.operation).toHaveBeenCalledExactlyOnceWith({
            kind: 'session_history',
            sessionId: 12,
        });
    });

    it('user sees the native missing-session error unchanged', async () => {
        const error = Object.assign(new Error('Session 12 not found'), {
            code: 'database-not-found',
        });
        mocks.operation.mockRejectedValue(error);

        await expect(getSessionData(12)).rejects.toBe(error);
    });
});
