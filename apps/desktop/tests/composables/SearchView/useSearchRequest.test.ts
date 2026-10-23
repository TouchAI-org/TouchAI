import type { SessionEntity } from '@database/types';
import type { Index } from '@services/AgentService/infrastructure/attachments';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ref } from 'vue';
import { ref } from 'vue';

import { AppEvent } from '@/services/EventService/types';
import { createInputHistorySnapshot, type SessionMessage } from '@/types/session';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';
import type { SearchModelOverride } from '@/views/SearchView/types';

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
        pendingUserQuestion: { value: null },
        sendRequest: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn(),
        clearSession: vi.fn(),
        openSession: vi.fn(),
        approvePendingToolApproval: vi.fn(() => true),
        rejectPendingToolApproval: vi.fn(() => true),
        settleUserQuestion: vi.fn(),
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

interface FlowOptions {
    modelOverride?: Ref<SearchModelOverride>;
    clearDraft?: (options?: { preserveModelTag?: boolean }) => void;
    attachments?: Index[];
    unsupportedMessage?: string | null;
}

async function mountFlow(options: FlowOptions = {}) {
    const modelOverride =
        options.modelOverride ??
        ref<SearchModelOverride>({
            modelId: null,
            providerId: null,
        });
    const clearDraft = options.clearDraft ?? vi.fn();
    const attachments = options.attachments ?? [];
    const unsupportedMessage = options.unsupportedMessage ?? null;

    const mounted = await mountComposable(() =>
        useSearchRequestFlow({
            modelOverride,
            clearDraft,
            getSupportedAttachments: () => attachments,
            getUnsupportedAttachmentMessage: () => unsupportedMessage,
            getCurrentInputSnapshot: (query) =>
                createInputHistorySnapshot({
                    text: query,
                    attachments,
                }),
        })
    );

    return { ...mounted, modelOverride, clearDraft };
}

describe('when the user sends a prompt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;

        agentState.isLoading.value = false;
        agentState.currentSessionId.value = null;
        agentState.sessionHistory.value = [];
        listSessionsMock.mockResolvedValue([]);
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

    it('user is told the attachments cannot be used and the prompt stays unsent', async () => {
        const { result, clearDraft, unmount } = await mountFlow({
            unsupportedMessage: 'The active model does not support files.',
        });

        await result.handleSubmit('hello world');

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI',
            body: 'The active model does not support files.',
        });
        expect(agentState.sendRequest).not.toHaveBeenCalled();
        expect(clearDraft).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the draft cleared and the prompt sent with the selected model', async () => {
        const attachment = createAttachment('doc-1');
        const { result, clearDraft, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'gpt-5', providerId: 4 }),
            attachments: [attachment],
        });

        await result.handleSubmit('hello world');

        expect(clearDraft).toHaveBeenCalledWith({ preserveModelTag: true });
        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'hello world',
            [attachment],
            expect.objectContaining({ text: 'hello world' }),
            'gpt-5',
            4
        );

        unmount();
    });
});

describe('when the user sends a second prompt while a request is running', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;
        agentState.isLoading.value = true;
        agentState.currentSessionId.value = null;
        agentState.sessionHistory.value = [];
        listSessionsMock.mockResolvedValue([]);
        agentState.sendRequest.mockResolvedValue(undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the follow-up queued instead of interrupting the running request', async () => {
        const attachment = createAttachment('queued-1');
        const { result, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'queued-model', providerId: 3 }),
            attachments: [attachment],
        });

        await result.handleSubmit('queued prompt');

        expect(result.isWaitingForCompletion.value).toBe(true);
        expect(result.pendingRequest.value).toEqual({
            query: 'queued prompt',
            attachments: [attachment],
            inputSnapshot: expect.objectContaining({ text: 'queued prompt' }),
            modelId: 'queued-model',
            providerId: 3,
        });
        expect(agentState.sendRequest).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the queued prompt sent automatically once the running request completes', async () => {
        const attachment = createAttachment('queued-1');
        const { result, clearDraft, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'queued-model', providerId: 3 }),
            attachments: [attachment],
        });

        await result.handleSubmit('queued prompt');

        agentState.isLoading.value = false;
        await (agentCallbacks.current?.onComplete as (() => Promise<void>) | undefined)?.();

        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'queued prompt',
            [attachment],
            expect.objectContaining({ text: 'queued prompt' }),
            'queued-model',
            3
        );
        expect(clearDraft).toHaveBeenCalledWith({ preserveModelTag: true });
        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);

        unmount();
    });

    it('user can drop the queued prompt without cancelling the request that is already running', async () => {
        const { result, unmount } = await mountFlow();

        await result.handleSubmit('queued prompt');
        expect(result.cancelPendingRequest()).toBe(true);

        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);
        expect(agentState.cancel).not.toHaveBeenCalled();
        expect(result.cancelPendingRequest()).toBe(false);

        unmount();
    });

    it('user gets a failed request drop the queued prompt instead of leaving it stuck', async () => {
        const { result, unmount } = await mountFlow();

        await result.handleSubmit('queued prompt');
        expect(result.isWaitingForCompletion.value).toBe(true);

        await (agentCallbacks.current?.onError as (() => void) | undefined)?.();

        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);

        unmount();
    });
});

describe('when the user cancels a running request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;
        agentState.isLoading.value = true;
        agentState.currentSessionId.value = null;
        listSessionsMock.mockResolvedValue([]);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user gets the running request cancelled and any queued prompt dropped', async () => {
        const { result, unmount } = await mountFlow();

        await result.handleSubmit('queued prompt');
        result.cancelRequest();

        expect(agentState.cancel).toHaveBeenCalled();
        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);

        unmount();
    });

    it('user gets nothing cancelled when no request is running', async () => {
        agentState.isLoading.value = false;
        const { result, unmount } = await mountFlow();

        result.cancelRequest();

        expect(agentState.cancel).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when the user browses the session history list', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;
        agentState.isLoading.value = false;
        agentState.currentSessionId.value = 42;
        agentState.sessionHistory.value = [];
        listSessionsMock.mockResolvedValue([createSessionEntity(42)]);
        dismissSessionTerminalStatusMock.mockResolvedValue(undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the loaded sessions after a single query even when two loads race', async () => {
        const { result, unmount } = await mountFlow();

        await Promise.all([result.ensureSessionListLoaded(), result.ensureSessionListLoaded()]);

        expect(listSessionsMock).toHaveBeenCalledTimes(1);
        expect(result.sessionList.value).toEqual([createSessionEntity(42)]);
        expect(result.isSessionListLoading.value).toBe(false);

        unmount();
    });

    it('user gets a fresh history list after a task reaches a terminal status', async () => {
        const { result, unmount } = await mountFlow();

        await result.ensureSessionListLoaded();
        expect(listSessionsMock).toHaveBeenCalledTimes(1);

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)?.({
            sessionId: 42,
            status: 'completed',
        });
        await flushAsyncWork();

        await result.ensureSessionListLoaded();

        expect(listSessionsMock).toHaveBeenCalledTimes(2);
        expect(dismissSessionTerminalStatusMock).toHaveBeenCalledWith(42);

        unmount();
    });

    it('user gets the history list filtered by the typed query', async () => {
        const { result, unmount } = await mountFlow();

        await result.setSessionHistoryPopupOpen(true);
        await result.updateSessionSearchQuery('deploy');

        expect(listSessionsMock).toHaveBeenLastCalledWith({ query: 'deploy', limit: 40 });

        unmount();
    });

    it('user gets an empty history list instead of a stale one when loading fails', async () => {
        listSessionsMock.mockRejectedValueOnce(new Error('database unavailable'));
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const { result, unmount } = await mountFlow();

        await result.ensureSessionListLoaded();

        expect(result.sessionList.value).toEqual([]);
        expect(result.isSessionListLoading.value).toBe(false);

        unmount();
    });

    it('user gets the search filter cleared when the history popup closes', async () => {
        const { result, unmount } = await mountFlow();

        await result.setSessionHistoryPopupOpen(true);
        await result.updateSessionSearchQuery('deploy');
        await result.setSessionHistoryPopupOpen(false);

        expect(result.sessionListQuery.value).toBe('');
        expect(result.sessionList.value).toEqual([]);

        unmount();
    });
});

describe('when the user opens a stored conversation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;
        agentState.sessionHistory.value = [];
        listSessionsMock.mockResolvedValue([]);
        dismissSessionTerminalStatusMock.mockResolvedValue(undefined);
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

    it('user gets the conversation model applied and any queued prompt dropped', async () => {
        agentState.isLoading.value = true;
        const queuedAttachment = createAttachment('queued-2');
        const { result, clearDraft, modelOverride, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'stale-model', providerId: 2 }),
            attachments: [queuedAttachment],
        });

        await result.handleSubmit('queued before open');
        expect(result.pendingRequest.value?.query).toBe('queued before open');

        const loadedSession = await result.openSession(7);

        expect(clearDraft).toHaveBeenCalledWith({ preserveModelTag: true });
        expect(dismissSessionTerminalStatusMock).toHaveBeenCalledWith(7);
        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);
        expect(modelOverride.value).toEqual({ modelId: 'gpt-5', providerId: 9 });
        expect(loadedSession).toEqual({
            sessionId: 7,
            title: 'Loaded Session',
            modelId: 'gpt-5',
            providerId: 9,
        });

        unmount();
    });

    it('user keeps the queued prompt and the current model when the conversation cannot be loaded', async () => {
        agentState.isLoading.value = true;
        agentState.openSession.mockRejectedValueOnce(new Error('session not found'));
        const { result, clearDraft, modelOverride, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'stale-model', providerId: 2 }),
            attachments: [createAttachment('queued-failed-open')],
        });

        await result.handleSubmit('queued before failed open');

        await expect(result.openSession(7)).rejects.toThrow('session not found');

        expect(clearDraft).not.toHaveBeenCalledWith({ preserveModelTag: true });
        expect(result.pendingRequest.value?.query).toBe('queued before failed open');
        expect(result.isWaitingForCompletion.value).toBe(true);
        expect(modelOverride.value).toEqual({ modelId: 'stale-model', providerId: 2 });

        unmount();
    });

    it('user gets no reload and no draft reset when opening the conversation already on screen', async () => {
        agentState.currentSessionId.value = 7;
        const { result, clearDraft, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'current-model', providerId: 12 }),
        });

        const loadedSession = await result.openSession(7);

        expect(agentState.openSession).not.toHaveBeenCalled();
        expect(clearDraft).not.toHaveBeenCalled();
        expect(loadedSession).toEqual({
            sessionId: 7,
            title: '',
            modelId: 'current-model',
            providerId: 12,
        });

        unmount();
    });
});

describe('when the user reopens the last closed conversation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;
        agentState.isLoading.value = false;
        agentState.sessionHistory.value = [];
        listSessionsMock.mockResolvedValue([]);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user gets the most recently closed conversation back', async () => {
        agentState.currentSessionId.value = 23;
        const { result, unmount } = await mountFlow();

        result.clearSession();
        expect(agentState.clearSession).toHaveBeenCalled();

        agentState.currentSessionId.value = null;
        agentState.openSession.mockImplementationOnce(async () => {
            agentState.currentSessionId.value = 23;
            return {
                sessionId: 23,
                title: 'Reopened Session',
                modelId: 'gpt-5',
                providerId: 9,
            };
        });

        const reopenedSession = await result.reopenLastClosedSession();

        expect(agentState.openSession).toHaveBeenCalledWith(23);
        expect(reopenedSession).toEqual({
            sessionId: 23,
            title: 'Reopened Session',
            modelId: 'gpt-5',
            providerId: 9,
        });

        unmount();
    });

    it('user gets nothing reopened once the conversation was already restored', async () => {
        agentState.currentSessionId.value = 23;
        const { result, unmount } = await mountFlow();

        result.clearSession();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockImplementationOnce(async () => {
            agentState.currentSessionId.value = 23;
            return {
                sessionId: 23,
                title: 'Reopened Session',
                modelId: 'gpt-5',
                providerId: 9,
            };
        });

        await result.reopenLastClosedSession();
        const secondReopenAttempt = await result.reopenLastClosedSession();

        expect(secondReopenAttempt).toBeNull();
        expect(agentState.openSession).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets nothing reopened when no conversation was closed yet', async () => {
        const { result, clearDraft, unmount } = await mountFlow();

        const reopenedSession = await result.reopenLastClosedSession();

        expect(agentState.openSession).not.toHaveBeenCalled();
        expect(clearDraft).not.toHaveBeenCalled();
        expect(reopenedSession).toBeNull();

        unmount();
    });

    it('user can retry reopening after a transient failure', async () => {
        agentState.currentSessionId.value = 23;
        const { result, unmount } = await mountFlow();

        result.clearSession();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockRejectedValueOnce(new Error('database unavailable'));

        await expect(result.reopenLastClosedSession()).rejects.toThrow('database unavailable');

        agentState.openSession.mockResolvedValueOnce({
            sessionId: 23,
            title: 'Reopened Session',
            modelId: 'gpt-5',
            providerId: 9,
        });

        await result.reopenLastClosedSession();

        expect(agentState.openSession).toHaveBeenLastCalledWith(23);

        unmount();
    });

    it('user gets nothing reopened when the stored conversation was deleted', async () => {
        agentState.currentSessionId.value = 23;
        const { result, unmount } = await mountFlow();

        result.clearSession();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockRejectedValueOnce(new Error('Session 23 not found'));

        await expect(result.reopenLastClosedSession()).rejects.toThrow('Session 23 not found');

        const secondReopenAttempt = await result.reopenLastClosedSession();

        expect(secondReopenAttempt).toBeNull();
        expect(agentState.openSession).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets nothing reopened when the closed conversation is already on screen', async () => {
        agentState.currentSessionId.value = 23;
        const { result, clearDraft, unmount } = await mountFlow();

        result.clearSession();
        const reopenedSession = await result.reopenLastClosedSession();

        expect(agentState.openSession).not.toHaveBeenCalled();
        expect(clearDraft).not.toHaveBeenCalled();
        expect(reopenedSession).toBeNull();

        unmount();
    });
});

describe('when the user asks for a different answer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentCallbacks.current = null;
        agentState.isLoading.value = false;
        agentState.currentSessionId.value = 1;
        listSessionsMock.mockResolvedValue([]);
        agentState.sendRequest.mockResolvedValue(undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user gets the nearest previous prompt resent with only the attachments the model supports', async () => {
        const supportedAttachment = createAttachment('supported-1');
        const unsupportedAttachment = createAttachment('unsupported-1', {
            supportStatus: 'unsupported-file',
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

        const { result, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'regen-model', providerId: 11 }),
        });

        await result.handleRegenerateMessage('assistant-2');

        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'Regenerate me',
            [supportedAttachment],
            createInputHistorySnapshot({
                text: 'Regenerate me',
                attachments: [supportedAttachment, unsupportedAttachment],
                excludeFromHistory: true,
            }),
            'regen-model',
            11
        );

        unmount();
    });

    it('user gets nothing resent when the first message in the conversation is targeted', async () => {
        agentState.sessionHistory.value = [
            {
                id: 'user-1',
                role: 'user',
                content: 'Only message',
                parts: [],
                timestamp: 1,
            },
        ];

        const { result, unmount } = await mountFlow();

        await result.handleRegenerateMessage('user-1');

        expect(agentState.sendRequest).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets nothing resent when there is no earlier prompt to resend', async () => {
        agentState.sessionHistory.value = [
            {
                id: 'assistant-0',
                role: 'assistant',
                content: 'Greeting',
                parts: [],
                timestamp: 1,
            },
            {
                id: 'assistant-1',
                role: 'assistant',
                content: 'Retry target',
                parts: [],
                timestamp: 2,
                isError: true,
            },
        ];

        const { result, unmount } = await mountFlow();

        await result.handleRegenerateMessage('assistant-1');

        expect(agentState.sendRequest).not.toHaveBeenCalled();

        unmount();
    });
});
