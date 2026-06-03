import type { SessionEntity } from '@database/types';
import type { Index } from '@services/AgentService/infrastructure/attachments';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { AppEvent } from '@/services/EventService/types';
import { createInputHistorySnapshot, type SessionMessage } from '@/types/session';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';

const {
    agentCallbacks,
    agentState,
    dismissSessionTerminalStatusMock,
    eventHandlers,
    listSessionsMock,
    notifyMock,
    useAgentMock,
} = vi.hoisted(() => {
    const callbacksHolder: { current: Record<string, unknown> | null } = { current: null };
    const handlers = new Map<string, (payload?: unknown) => unknown>();
    const agent = {
        isLoading: { value: false },
        error: { value: null },
        currentSessionId: { value: null as number | null },
        sessionHistory: { value: [] as SessionMessage[] },
        pendingToolApproval: { value: null },
        sendRequest: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn(),
        clearSession: vi.fn(),
        openSession: vi.fn(),
        approvePendingToolApproval: vi.fn(() => true),
        rejectPendingToolApproval: vi.fn(() => true),
    };

    return {
        agentCallbacks: callbacksHolder,
        agentState: agent,
        dismissSessionTerminalStatusMock: vi.fn().mockResolvedValue(undefined),
        eventHandlers: handlers,
        listSessionsMock: vi.fn().mockResolvedValue([]),
        notifyMock: vi.fn(),
        useAgentMock: vi.fn((callbacks: Record<string, unknown>) => {
            callbacksHolder.current = callbacks;
            return agent;
        }),
    };
});

vi.mock('@composables/agent', () => ({
    useAgent: useAgentMock,
}));

vi.mock('@services/NotificationService', () => ({
    notify: notifyMock,
}));

vi.mock('@services/AgentService/session', async () => {
    const actual = await vi.importActual<typeof import('@services/AgentService/session')>(
        '@services/AgentService/session'
    );
    return {
        ...actual,
        dismissSessionTerminalStatus: dismissSessionTerminalStatusMock,
        listSessions: listSessionsMock,
    };
});

vi.mock('@services/EventService', async () => {
    const actual =
        await vi.importActual<typeof import('@services/EventService')>('@services/EventService');
    return {
        ...actual,
        eventService: {
            on: vi.fn(async (event: string, handler: (payload?: unknown) => unknown) => {
                eventHandlers.set(event, handler);
                return () => {
                    eventHandlers.delete(event);
                };
            }),
        },
    };
});

function createAttachment(id: string, overrides: Partial<Index> = {}): Index {
    return {
        id,
        type: 'file',
        path: `D:/attachments/${id}.txt`,
        originPath: `D:/attachments/${id}.txt`,
        name: `${id}.txt`,
        supportStatus: 'supported',
        ...overrides,
    };
}

function createSessionEntity(id: number, overrides: Partial<SessionEntity> = {}): SessionEntity {
    return {
        id,
        session_id: `session-${id}`,
        title: `Session ${id}`,
        model: 'gpt-5',
        provider_id: 1,
        last_message_preview: null,
        last_message_at: null,
        message_count: 0,
        status_badge_dismissed_turn_id: null,
        pending_terminal_status: null,
        pinned_at: null,
        archived_at: null,
        created_at: '2026-05-16T00:00:00.000Z',
        updated_at: '2026-05-16T00:00:00.000Z',
        ...overrides,
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('useSearchRequestFlow', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;

        agentState.isLoading.value = false;
        agentState.error.value = null;
        agentState.currentSessionId.value = null;
        agentState.sessionHistory.value = [];
        agentState.pendingToolApproval.value = null;

        listSessionsMock.mockResolvedValue([]);
        dismissSessionTerminalStatusMock.mockResolvedValue(undefined);
        agentState.sendRequest.mockResolvedValue(undefined);
        agentState.openSession.mockResolvedValue({
            sessionId: 7,
            title: 'Loaded Session',
            modelId: 'gpt-5',
            providerId: 9,
        });
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('notifies and aborts submission when attachments are unsupported', async () => {
        const modelOverride = ref({
            modelId: null,
            providerId: null,
        });
        const clearDraft = vi.fn();

        const mounted = await mountComposable(() =>
            useSearchRequestFlow({
                modelOverride,
                clearDraft,
                getSupportedAttachments: () => [],
                getUnsupportedAttachmentMessage: () => 'The active model does not support files.',
                getCurrentInputSnapshot: (query) =>
                    createInputHistorySnapshot({
                        text: query,
                        attachments: [],
                    }),
            })
        );

        await mounted.result.handleSubmit('hello world');

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'The active model does not support files.',
        });
        expect(agentState.sendRequest).not.toHaveBeenCalled();
        expect(clearDraft).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('queues a follow-up request while loading and replays it after completion', async () => {
        const supportedAttachment = createAttachment('queued-1');
        const queuedSnapshot = createInputHistorySnapshot({
            text: 'queued prompt',
            attachments: [supportedAttachment],
        });
        const modelOverride = ref({
            modelId: 'queued-model',
            providerId: 3,
        });
        const clearDraft = vi.fn();

        agentState.isLoading.value = true;

        const mounted = await mountComposable(() =>
            useSearchRequestFlow({
                modelOverride,
                clearDraft,
                getSupportedAttachments: () => [supportedAttachment],
                getUnsupportedAttachmentMessage: () => null,
                getCurrentInputSnapshot: () => queuedSnapshot,
            })
        );

        await mounted.result.handleSubmit('queued prompt');

        expect(mounted.result.pendingRequest.value).toEqual({
            query: 'queued prompt',
            attachments: [supportedAttachment],
            inputSnapshot: queuedSnapshot,
            modelId: 'queued-model',
            providerId: 3,
            desktopContextCapsuleId: null,
        });
        expect(mounted.result.isWaitingForCompletion.value).toBe(true);
        expect(agentState.sendRequest).not.toHaveBeenCalled();

        agentState.isLoading.value = false;
        await (agentCallbacks.current?.onComplete as (() => Promise<void>) | undefined)?.();

        expect(clearDraft).toHaveBeenCalledWith({
            preserveModelTag: true,
        });
        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'queued prompt',
            [supportedAttachment],
            queuedSnapshot,
            'queued-model',
            3,
            null
        );
        expect(mounted.result.pendingRequest.value).toBeNull();
        expect(mounted.result.isWaitingForCompletion.value).toBe(false);

        mounted.unmount();
    });

    it('deduplicates identical session-list loads and invalidates the cache after terminal events', async () => {
        const modelOverride = ref({
            modelId: null,
            providerId: null,
        });
        agentState.currentSessionId.value = 42;
        listSessionsMock.mockResolvedValue([createSessionEntity(42)]);

        const mounted = await mountComposable(() =>
            useSearchRequestFlow({
                modelOverride,
                clearDraft: vi.fn(),
                getSupportedAttachments: () => [],
                getUnsupportedAttachmentMessage: () => null,
                getCurrentInputSnapshot: (query) =>
                    createInputHistorySnapshot({
                        text: query,
                        attachments: [],
                    }),
            })
        );

        await Promise.all([
            mounted.result.ensureSessionListLoaded(),
            mounted.result.ensureSessionListLoaded(),
        ]);

        expect(listSessionsMock).toHaveBeenCalledTimes(1);
        expect(listSessionsMock).toHaveBeenCalledWith({
            query: '',
            limit: 40,
        });
        expect(mounted.result.sessionList.value).toEqual([createSessionEntity(42)]);

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 42,
            status: 'completed',
        });
        await flushAsyncWork();

        expect(dismissSessionTerminalStatusMock).toHaveBeenCalledWith(42);

        await mounted.result.ensureSessionListLoaded();

        expect(listSessionsMock).toHaveBeenCalledTimes(2);

        mounted.unmount();
    });

    it('opens a stored session after clearing local queue state and syncing the selected model', async () => {
        const queuedAttachment = createAttachment('queued-2');
        const modelOverride = ref({
            modelId: 'stale-model',
            providerId: 2,
        });
        const clearDraft = vi.fn();

        agentState.isLoading.value = true;

        const mounted = await mountComposable(() =>
            useSearchRequestFlow({
                modelOverride,
                clearDraft,
                getSupportedAttachments: () => [queuedAttachment],
                getUnsupportedAttachmentMessage: () => null,
                getCurrentInputSnapshot: (query) =>
                    createInputHistorySnapshot({
                        text: query,
                        attachments: [queuedAttachment],
                    }),
            })
        );

        await mounted.result.handleSubmit('queued before open');
        expect(mounted.result.pendingRequest.value?.query).toBe('queued before open');

        const loadedSession = await mounted.result.openSession(7);

        expect(agentState.openSession).toHaveBeenCalledWith(7);
        expect(clearDraft).toHaveBeenCalledWith({
            preserveModelTag: true,
        });
        expect(dismissSessionTerminalStatusMock).toHaveBeenCalledWith(7);
        expect(mounted.result.pendingRequest.value).toBeNull();
        expect(mounted.result.isWaitingForCompletion.value).toBe(false);
        expect(modelOverride.value).toEqual({
            modelId: 'gpt-5',
            providerId: 9,
        });
        expect(loadedSession).toEqual({
            sessionId: 7,
            title: 'Loaded Session',
            modelId: 'gpt-5',
            providerId: 9,
        });

        mounted.unmount();
    });

    it('regenerates from the nearest preceding user message and drops unsupported attachments', async () => {
        const supportedAttachment = createAttachment('supported-1');
        const unsupportedAttachment = createAttachment('unsupported-1', {
            supportStatus: 'unsupported-file',
        });
        const modelOverride = ref({
            modelId: 'regen-model',
            providerId: 11,
        });

        agentState.sessionHistory.value = [
            {
                id: 'user-1',
                role: 'user',
                content: 'Fallback text',
                parts: [],
                timestamp: 1,
                attachments: [supportedAttachment, unsupportedAttachment],
                inputSnapshot: createInputHistorySnapshot({
                    text: 'Regenerate me',
                    attachments: [supportedAttachment, unsupportedAttachment],
                }),
            },
            {
                id: 'assistant-1',
                role: 'assistant',
                content: 'First answer',
                parts: [],
                timestamp: 2,
            },
            {
                id: 'assistant-2',
                role: 'assistant',
                content: 'Retry target',
                parts: [],
                timestamp: 3,
                isError: true,
            },
        ];

        const mounted = await mountComposable(() =>
            useSearchRequestFlow({
                modelOverride,
                clearDraft: vi.fn(),
                getSupportedAttachments: () => [],
                getUnsupportedAttachmentMessage: () => null,
                getCurrentInputSnapshot: (query) =>
                    createInputHistorySnapshot({
                        text: query,
                        attachments: [],
                    }),
            })
        );

        await mounted.result.handleRegenerateMessage('assistant-2');

        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'Regenerate me',
            [supportedAttachment],
            createInputHistorySnapshot({
                text: 'Regenerate me',
                attachments: [supportedAttachment, unsupportedAttachment],
                excludeFromHistory: true,
            }),
            'regen-model',
            11,
            null
        );

        mounted.unmount();
    });
});
