import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgent } from '@/composables/agent/useAgent';

/**
 * When a conversation is reopened the page has to pick a model and provider to show in the
 * composer. The saved model row wins; if it was deleted the session's own columns are the only
 * record left of what the conversation used.
 */
const { getSessionDataMock, sessionTaskCenterMock } = vi.hoisted(() => ({
    getSessionDataMock: vi.fn(),
    sessionTaskCenterMock: {
        attachSessionView: vi.fn(() => null),
        approveTaskToolCall: vi.fn(() => true),
        cancelTask: vi.fn(() => true),
        rejectTaskToolCall: vi.fn(() => true),
        startTask: vi.fn(),
        subscribeTask: vi.fn(),
    },
}));

vi.mock('@database/queries/sessions', () => ({
    findSessionById: vi.fn(async () => ({ id: 1, title: 'Active session' })),
}));

vi.mock('@services/NotificationService', () => ({ notify: vi.fn() }));

vi.mock('@/services/AgentService', async () => {
    const actual =
        await vi.importActual<typeof import('@/services/AgentService')>('@/services/AgentService');
    return { ...actual, sessionTaskCenter: sessionTaskCenterMock };
});

vi.mock('@/services/AgentService/session', async () => {
    const actual = await vi.importActual<typeof import('@/services/AgentService/session')>(
        '@/services/AgentService/session'
    );
    return {
        ...actual,
        getSessionData: getSessionDataMock,
        buildSessionHistoryFromData: vi.fn(async () => []),
    };
});

function sessionData(overrides: Record<string, unknown> = {}) {
    return {
        session: {
            id: 7,
            title: 'Deploy plan',
            model: 'gpt-5',
            provider_id: 3,
        },
        messages: [],
        turns: [],
        attempts: [],
        model: { model_id: 'gpt-5', provider_id: 3 },
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    sessionTaskCenterMock.attachSessionView.mockReturnValue(null);
});

describe('user reopens a conversation whose model still exists', () => {
    it('user gets the model and provider from the saved model row', async () => {
        getSessionDataMock.mockResolvedValue(sessionData());
        const mounted = await mountComposable(() => useAgent());

        const loaded = await mounted.result.openSession(7);

        expect(loaded).toMatchObject({ sessionId: 7, title: 'Deploy plan' });
        expect(loaded.modelId).toBe('gpt-5');
        expect(loaded.providerId).toBe(3);

        mounted.unmount();
    });
});

describe('user reopens a conversation whose model was deleted', () => {
    it('user gets the model id from the session record instead', async () => {
        // The model row is gone, so the session's own columns are the only record left.
        getSessionDataMock.mockResolvedValue(sessionData({ model: null }));
        const mounted = await mountComposable(() => useAgent());

        const loaded = await mounted.result.openSession(7);

        expect(loaded.modelId).toBe('gpt-5');
        expect(loaded.providerId).toBe(3);

        mounted.unmount();
    });

    it('user gets no model shown when the session never recorded one', async () => {
        getSessionDataMock.mockResolvedValue(
            sessionData({
                model: null,
                session: { id: 7, title: 'Deploy plan', model: null, provider_id: null },
            })
        );
        const mounted = await mountComposable(() => useAgent());

        const loaded = await mounted.result.openSession(7);

        // A null is honest here; inventing a default would send the next prompt to the wrong model.
        expect(loaded.modelId).toBeNull();
        expect(loaded.providerId).toBeNull();

        mounted.unmount();
    });

    it('user gets the provider kept even when the model id is missing', async () => {
        getSessionDataMock.mockResolvedValue(
            sessionData({
                model: null,
                session: { id: 7, title: 'Deploy plan', model: null, provider_id: 5 },
            })
        );
        const mounted = await mountComposable(() => useAgent());

        const loaded = await mounted.result.openSession(7);

        expect(loaded.modelId).toBeNull();
        expect(loaded.providerId).toBe(5);

        mounted.unmount();
    });
});
