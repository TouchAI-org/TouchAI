import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgent } from '@/composables/agent/useAgent';
import type { PendingUserMessage } from '@/services/AgentService';

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
        restoreSessionQueue: vi.fn<() => Promise<PendingUserMessage[]>>(async () => []),
        resumeSessionQueue: vi.fn(),
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
        loadCompleteSessionHistory: vi.fn(async (sessionId: number) => {
            const data = (await getSessionDataMock(sessionId)) as {
                session: unknown;
                model: unknown;
            };
            return { history: [], session: data.session, model: data.model };
        }),
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

describe('user reopens a conversation with durable pending messages', () => {
    it('user gets the queued bubbles restored and the queue resumed', async () => {
        const pending = {
            id: 'pending-1',
            prompt: 'continue later',
            delivery: 'queue' as const,
            attachments: [],
            createdAt: 1,
        };
        getSessionDataMock.mockResolvedValue(sessionData());
        sessionTaskCenterMock.restoreSessionQueue.mockResolvedValueOnce([pending]);
        const mounted = await mountComposable(() => useAgent());

        await mounted.result.openSession(7);

        expect(mounted.result.pendingUserMessages.value).toEqual([pending]);
        expect(sessionTaskCenterMock.resumeSessionQueue).toHaveBeenCalledWith(7);

        mounted.unmount();
    });
});

describe('user changes views while saved history is still loading', () => {
    it('user opens another conversation and keeps its queue when the earlier history arrives later', async () => {
        let resolveEarlier!: (data: ReturnType<typeof sessionData>) => void;
        const earlierData = new Promise<ReturnType<typeof sessionData>>((resolve) => {
            resolveEarlier = resolve;
        });
        getSessionDataMock.mockImplementation((sessionId: number) =>
            sessionId === 7
                ? earlierData
                : Promise.resolve(sessionData({ session: { id: 8, title: 'Newer conversation' } }))
        );
        const earlierPending: PendingUserMessage = {
            id: 'earlier-pending',
            prompt: 'earlier queue',
            delivery: 'queue',
            attachments: [],
            createdAt: 1,
        };
        const newerPending = { ...earlierPending, id: 'newer-pending', prompt: 'newer queue' };
        sessionTaskCenterMock.restoreSessionQueue
            .mockResolvedValueOnce([earlierPending])
            .mockResolvedValueOnce([newerPending]);
        const mounted = await mountComposable(() => useAgent());

        const earlierOpen = mounted.result.openSession(7);
        await mounted.result.openSession(8);
        resolveEarlier(sessionData());
        await expect(earlierOpen).resolves.toMatchObject({ sessionId: 7 });

        expect(mounted.result.currentSessionId.value).toBe(8);
        expect(mounted.result.pendingUserMessages.value).toEqual([newerPending]);
        mounted.unmount();
    });

    it.each(['clear', 'unmount'] as const)(
        'user leaves the conversation through %s and is not brought back by a late history load',
        async (action) => {
            let resolveEarlier!: (data: ReturnType<typeof sessionData>) => void;
            getSessionDataMock.mockReturnValue(
                new Promise<ReturnType<typeof sessionData>>((resolve) => {
                    resolveEarlier = resolve;
                })
            );
            const mounted = await mountComposable(() => useAgent());
            const earlierOpen = mounted.result.openSession(7);

            if (action === 'clear') mounted.result.clearSession();
            else mounted.unmount();
            resolveEarlier(sessionData());
            await expect(earlierOpen).resolves.toMatchObject({ sessionId: 7 });

            expect(mounted.result.currentSessionId.value).toBeNull();
            expect(mounted.result.pendingUserMessages.value).toEqual([]);
            expect(mounted.result.sessionHistory.value).toEqual([]);
            if (action === 'clear') mounted.unmount();
        }
    );
});
