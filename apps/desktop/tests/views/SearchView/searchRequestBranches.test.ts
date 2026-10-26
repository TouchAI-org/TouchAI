import type { SessionEntity } from '@database/types';
import type { Index } from '@services/AgentService/infrastructure/attachments';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, type Ref, ref } from 'vue';

import { AppEvent } from '@/services/EventService/types';
import { createInputHistorySnapshot, type SessionMessage } from '@/types/session';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';
import type { SearchModelOverride } from '@/views/SearchView/types';

/**
 * Branch pass over the search request flow: the session-list cache keys, the
 * pending-request queue, the terminal-status event handling and the regenerate
 * path. The agent composable, the session service and the event bus are the
 * process boundary and are stubbed; the assertions are about what the page
 * observes (queued request, list contents, loading flag, what gets sent).
 */
const {
    agentCallbacks,
    agentState,
    dismissSessionTerminalStatusMock,
    eventHandlers,
    listSessionsMock,
    notifyMock,
    useAgentMock,
    eventOnMock,
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
        eventOnMock: vi.fn(async (event: string, handler: (payload?: unknown) => unknown) => {
            handlers.set(event, handler);
            return () => {
                handlers.delete(event);
            };
        }),
    };
});

vi.mock('@composables/agent', () => ({ useAgent: useAgentMock }));
vi.mock('@services/NotificationService', () => ({ notify: notifyMock }));
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
    return { ...actual, eventService: { on: eventOnMock } };
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

function createMessage(
    id: string,
    role: 'user' | 'assistant' | 'system' | 'error',
    overrides: Partial<SessionMessage> = {}
): SessionMessage {
    return {
        id,
        role,
        content: `${role} ${id}`,
        ...overrides,
    } as SessionMessage;
}

async function flushAsyncWork() {
    for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
        await nextTick();
    }
}

/** The agent callbacks arrive as an untyped bag; call one by name. */
function callAgentCallback(name: string, ...args: unknown[]): void {
    const callbacks = agentCallbacks.current as Record<
        string,
        ((...a: unknown[]) => unknown) | undefined
    >;
    callbacks?.[name]?.(...args);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

async function mountFlow(
    options: {
        modelOverride?: Ref<SearchModelOverride>;
        clearDraft?: (options?: { preserveModelTag?: boolean }) => void;
        attachments?: Index[];
        unsupportedMessage?: string | null;
    } = {}
) {
    const modelOverride: Ref<SearchModelOverride> =
        options.modelOverride ?? ref<SearchModelOverride>({ modelId: null, providerId: null });
    const clearDraft = options.clearDraft ?? vi.fn();
    const attachments = options.attachments ?? [];

    const mounted = await mountComposable(() =>
        useSearchRequestFlow({
            modelOverride,
            clearDraft,
            getSupportedAttachments: () => attachments,
            getUnsupportedAttachmentMessage: () => options.unsupportedMessage ?? null,
            getCurrentInputSnapshot: (query) =>
                createInputHistorySnapshot({ text: query, attachments }),
        })
    );

    return { ...mounted, modelOverride, clearDraft };
}

beforeEach(() => {
    vi.clearAllMocks();
    eventHandlers.clear();
    agentCallbacks.current = null;
    agentState.isLoading.value = false;
    agentState.currentSessionId.value = null;
    agentState.sessionHistory.value = [];
    agentState.sendRequest.mockResolvedValue(undefined);
    agentState.openSession.mockResolvedValue({
        sessionId: 7,
        title: 'Loaded',
        modelId: 'gpt-5',
        providerId: 9,
    });
    listSessionsMock.mockResolvedValue([]);
    dismissSessionTerminalStatusMock.mockResolvedValue(undefined);
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('when the history popup is closed while its list was loaded', () => {
    it('user gets the default list reused instead of cleared and refetched', async () => {
        const { result, unmount } = await mountFlow();
        listSessionsMock.mockResolvedValue([createSessionEntity(1)]);

        await result.refreshSessionList();
        expect(result.sessionList.value).toHaveLength(1);

        // Opening and closing with no filter must keep the already loaded default list.
        await result.setSessionHistoryPopupOpen(true);
        await result.setSessionHistoryPopupOpen(false);

        expect(result.sessionList.value).toHaveLength(1);
        expect(result.isSessionListLoading.value).toBe(false);

        unmount();
    });

    it('user gets the filtered list dropped when the popup closes', async () => {
        const { result, unmount } = await mountFlow();
        listSessionsMock.mockResolvedValue([createSessionEntity(2)]);

        await result.setSessionHistoryPopupOpen(true);
        await result.updateSessionSearchQuery('filtered');
        await flushAsyncWork();

        await result.setSessionHistoryPopupOpen(false);

        // A filtered result must not linger as the default list.
        expect(result.sessionListQuery.value).toBe('');
        expect(result.sessionList.value).toEqual([]);

        unmount();
    });

    it('user gets the search query applied to the next list request', async () => {
        const { result, unmount } = await mountFlow();
        await result.setSessionHistoryPopupOpen(true);

        await result.updateSessionSearchQuery('  deploy  ');
        await flushAsyncWork();

        expect(listSessionsMock).toHaveBeenLastCalledWith(
            expect.objectContaining({ query: '  deploy  ' })
        );

        unmount();
    });

    it('user gets no list request while the popup is closed', async () => {
        const { result, unmount } = await mountFlow();
        listSessionsMock.mockClear();

        await result.updateSessionSearchQuery('typing');

        expect(listSessionsMock).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when two list loads race', () => {
    it('user gets one request for the same filter asked twice at once', async () => {
        const pending = deferred<SessionEntity[]>();
        const { result, unmount } = await mountFlow();
        listSessionsMock.mockReturnValue(pending.promise);

        const first = result.refreshSessionList();
        const second = result.refreshSessionList();
        pending.resolve([createSessionEntity(3)]);
        await Promise.all([first, second]);
        await flushAsyncWork();

        expect(listSessionsMock).toHaveBeenCalledTimes(1);
        expect(result.sessionList.value).toHaveLength(1);

        unmount();
    });

    it('user gets the loading flag cleared even when the list request fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { result, unmount } = await mountFlow();
        listSessionsMock.mockRejectedValue(new Error('db offline'));

        await result.refreshSessionList();
        await flushAsyncWork();

        expect(result.isSessionListLoading.value).toBe(false);
        expect(result.sessionList.value).toEqual([]);

        unmount();
    });

    it('user gets a second request started for a different filter', async () => {
        const { result, unmount } = await mountFlow();
        await result.setSessionHistoryPopupOpen(true);

        await result.updateSessionSearchQuery('first');
        await flushAsyncWork();
        const callsAfterFirst = listSessionsMock.mock.calls.length;

        await result.updateSessionSearchQuery('second');
        await flushAsyncWork();

        expect(listSessionsMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);

        unmount();
    });

    it('user gets the already loaded filter not fetched again', async () => {
        const { result, unmount } = await mountFlow();
        listSessionsMock.mockResolvedValue([createSessionEntity(4)]);

        await result.ensureSessionListLoaded();
        listSessionsMock.mockClear();
        await result.ensureSessionListLoaded();

        // The resolved key still matches, so the popup opens without another query.
        expect(listSessionsMock).not.toHaveBeenCalled();

        unmount();
    });
});

describe('when a session reaches a terminal state', () => {
    it('user gets the active session badge dismissed and the list refreshed', async () => {
        const { result, unmount } = await mountFlow();
        agentState.currentSessionId.value = 5;
        await result.setSessionHistoryPopupOpen(true);

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!({
            sessionId: 5,
            status: 'completed',
        });
        await flushAsyncWork();

        expect(dismissSessionTerminalStatusMock).toHaveBeenCalledWith(5);
        expect(result.sessionList.value).toEqual([]);

        unmount();
    });

    it('user gets another session terminal state only refreshing the list', async () => {
        const { unmount } = await mountFlow();
        agentState.currentSessionId.value = 5;

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!({
            sessionId: 99,
            status: 'failed',
        });
        await flushAsyncWork();

        // A background session must not dismiss the badge of the open one.
        expect(dismissSessionTerminalStatusMock).not.toHaveBeenCalledWith(99);

        unmount();
    });

    it('user gets no work at all for a non-terminal status', async () => {
        const { unmount } = await mountFlow();
        agentState.currentSessionId.value = 5;

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!({
            sessionId: 5,
            status: 'running',
        });
        await flushAsyncWork();

        expect(dismissSessionTerminalStatusMock).not.toHaveBeenCalled();

        unmount();
    });

    it('user keeps the view usable when dismissing the badge fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        dismissSessionTerminalStatusMock.mockRejectedValue(new Error('not found'));
        const { result, unmount } = await mountFlow();
        agentState.currentSessionId.value = 5;

        await eventHandlers.get(AppEvent.SESSION_TASK_STATUS_CHANGED)!({
            sessionId: 5,
            status: 'completed',
        });
        await flushAsyncWork();

        expect(result.isSessionListLoading.value).toBe(false);

        unmount();
    });
});

describe('when the user cancels a running request', () => {
    it('user gets the queued prompt dropped and the request cancelled', async () => {
        const { result, unmount } = await mountFlow();
        agentState.isLoading.value = true;

        await result.handleSubmit('first prompt');
        expect(result.pendingRequest.value).not.toBeNull();

        result.cancelRequest();

        expect(result.pendingRequest.value).toBeNull();
        expect(agentState.cancel).toHaveBeenCalled();

        unmount();
    });

    it('user gets no cancel call when nothing is running', async () => {
        const { result, unmount } = await mountFlow();
        agentState.isLoading.value = false;

        result.cancelRequest();

        expect(agentState.cancel).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets false reported when there was no queued prompt to cancel', async () => {
        const { result, unmount } = await mountFlow();

        expect(result.cancelPendingRequest()).toBe(false);

        unmount();
    });

    it('user gets the queued prompt dropped once it is cancelled', async () => {
        const { result, unmount } = await mountFlow();
        agentState.isLoading.value = true;
        await result.handleSubmit('queued');

        expect(result.cancelPendingRequest()).toBe(true);
        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);

        unmount();
    });
});

describe('when a model is picked while a prompt is queued', () => {
    it('user gets the queued prompt sent with the newly picked model', async () => {
        const { result, unmount } = await mountFlow();
        agentState.isLoading.value = true;
        await result.handleSubmit('queued prompt');
        agentState.isLoading.value = false;

        // The user switches models while the turn is still finishing.
        callAgentCallback('onModelSelected', {
            modelId: 'picked-model',
            providerId: 12,
        });

        expect(result.pendingRequest.value?.modelId).toBe('picked-model');

        callAgentCallback('onComplete');
        await flushAsyncWork();

        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'queued prompt',
            [],
            expect.objectContaining({ text: 'queued prompt' }),
            'picked-model',
            12
        );

        unmount();
    });

    it('user gets no model picked reported when nothing is queued', async () => {
        const { result, unmount } = await mountFlow();

        callAgentCallback('onModelSelected', { modelId: 'solo', providerId: 2 });

        expect(result.pendingRequest.value).toBeNull();

        unmount();
    });
});

describe('when a queued prompt is released on completion', () => {
    it('user gets the queued prompt sent and the draft cleared', async () => {
        const { result, clearDraft, unmount } = await mountFlow();
        agentState.isLoading.value = true;
        await result.handleSubmit('queued prompt');

        callAgentCallback('onComplete');
        await flushAsyncWork();

        expect(clearDraft).toHaveBeenCalledWith({ preserveModelTag: true });
        expect(agentState.sendRequest).toHaveBeenCalled();
        expect(result.pendingRequest.value).toBeNull();

        unmount();
    });

    it('user gets nothing sent when completion arrives with no queue', async () => {
        const { unmount } = await mountFlow();
        agentState.sendRequest.mockClear();

        callAgentCallback('onComplete');
        await flushAsyncWork();

        expect(agentState.sendRequest).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the queued prompt dropped when the turn fails', async () => {
        const { result, unmount } = await mountFlow();
        agentState.isLoading.value = true;
        await result.handleSubmit('queued prompt');

        callAgentCallback('onError');
        await flushAsyncWork();

        expect(result.pendingRequest.value).toBeNull();
        expect(result.isWaitingForCompletion.value).toBe(false);

        unmount();
    });

    it('user gets the list refreshed when a turn starts', async () => {
        const { result, unmount } = await mountFlow();
        await result.setSessionHistoryPopupOpen(true);
        listSessionsMock.mockClear();

        callAgentCallback('onTurnStarted');
        await flushAsyncWork();

        expect(listSessionsMock).toHaveBeenCalled();

        unmount();
    });
});

describe('when the user reopens the last closed session', () => {
    it('user gets nothing reopened before any session was closed', async () => {
        const { result, unmount } = await mountFlow();

        await expect(result.reopenLastClosedSession()).resolves.toBeNull();
        expect(agentState.openSession).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the closed session reopened and remembered as open', async () => {
        const { result, unmount } = await mountFlow();
        agentState.currentSessionId.value = 3;

        result.startNewSession();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockResolvedValue({
            sessionId: 3,
            title: 'Back',
            modelId: 'gpt-5',
            providerId: 1,
        });

        const reopened = await result.reopenLastClosedSession();

        expect(reopened?.sessionId).toBe(3);

        unmount();
    });

    it('user gets no reopen attempt for the session already open', async () => {
        const { result, unmount } = await mountFlow();
        agentState.currentSessionId.value = 8;
        result.startNewSession();
        agentState.currentSessionId.value = 8;

        await expect(result.reopenLastClosedSession()).resolves.toBeNull();

        unmount();
    });

    it('user gets the remembered id forgotten when the session no longer exists', async () => {
        const { result, unmount } = await mountFlow();
        agentState.currentSessionId.value = 6;
        result.startNewSession();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockRejectedValue(new Error('Session 6 not found'));

        await expect(result.reopenLastClosedSession()).rejects.toThrow('Session 6 not found');
        // The stale id is dropped, so a later reopen does not retry a missing session.
        await expect(result.reopenLastClosedSession()).resolves.toBeNull();

        unmount();
    });

    it('user gets the error surfaced for a reopen that fails for another reason', async () => {
        const { result, unmount } = await mountFlow();
        agentState.currentSessionId.value = 6;
        result.startNewSession();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockRejectedValue(new Error('network down'));

        await expect(result.reopenLastClosedSession()).rejects.toThrow('network down');

        unmount();
    });
});

describe('when the user opens a session from the history list', () => {
    it('user gets the open session returned without a database round trip', async () => {
        const { result, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'current', providerId: 3 }),
        });
        agentState.currentSessionId.value = 11;

        const loaded = await result.openSession(11);

        expect(loaded).toEqual({
            sessionId: 11,
            title: '',
            modelId: 'current',
            providerId: 3,
        });
        expect(agentState.openSession).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the stored session loaded and its model applied to the draft', async () => {
        const { result, modelOverride, unmount } = await mountFlow();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockResolvedValue({
            sessionId: 12,
            title: 'Stored',
            modelId: 'stored-model',
            providerId: 4,
        });

        await result.openSession(12);

        expect(modelOverride.value).toEqual({ modelId: 'stored-model', providerId: 4 });
        expect(dismissSessionTerminalStatusMock).toHaveBeenCalledWith(12);

        unmount();
    });

    it('user still gets the session opened when the badge dismiss fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const { result, unmount } = await mountFlow();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockResolvedValue({
            sessionId: 13,
            title: 'Stored',
            modelId: 'gpt-5',
            providerId: 4,
        });
        dismissSessionTerminalStatusMock.mockRejectedValue(new Error('badge locked'));

        const loaded = await result.openSession(13);

        // A failed badge cleanup must not block the session from opening.
        expect(loaded.sessionId).toBe(13);

        unmount();
    });
});

describe('when the user regenerates a reply', () => {
    it('user gets the request resent from the preceding user message', async () => {
        const { result, unmount } = await mountFlow({
            modelOverride: ref({ modelId: 'gpt-5', providerId: 2 }),
        });
        agentState.sessionHistory.value = [
            createMessage('u1', 'user', { content: 'original prompt' }),
            createMessage('a1', 'assistant'),
        ];

        await result.handleRegenerateMessage('a1');
        await flushAsyncWork();

        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'original prompt',
            [],
            expect.objectContaining({ text: 'original prompt' }),
            'gpt-5',
            2
        );

        unmount();
    });

    it('user gets the earlier user prompt used when an error row trails the reply', async () => {
        const { result, unmount } = await mountFlow();
        agentState.sessionHistory.value = [
            createMessage('u1', 'user', { content: 'the real prompt' }),
            createMessage('a1', 'assistant'),
            createMessage('e1', 'error'),
        ];

        await result.handleRegenerateMessage('e1');
        await flushAsyncWork();

        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'the real prompt',
            [],
            expect.anything(),
            undefined,
            undefined
        );

        unmount();
    });

    it('user gets nothing regenerated for the first message in the list', async () => {
        const { result, unmount } = await mountFlow();
        agentState.sessionHistory.value = [createMessage('u1', 'user')];

        await result.handleRegenerateMessage('u1');

        expect(agentState.sendRequest).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets nothing regenerated when there is no user message before it', async () => {
        const { result, unmount } = await mountFlow();
        agentState.sessionHistory.value = [
            createMessage('s1', 'system'),
            createMessage('a1', 'assistant'),
        ];

        await result.handleRegenerateMessage('a1');

        expect(agentState.sendRequest).not.toHaveBeenCalled();

        unmount();
    });

    it('user gets the attachments of the original prompt carried into the retry', async () => {
        const attachment = createAttachment('keep-me');
        const { result, unmount } = await mountFlow();
        agentState.sessionHistory.value = [
            createMessage('u1', 'user', {
                content: 'prompt with file',
                attachments: [attachment],
            }),
            createMessage('a1', 'assistant'),
        ];

        await result.handleRegenerateMessage('a1');
        await flushAsyncWork();

        expect(agentState.sendRequest).toHaveBeenCalledWith(
            'prompt with file',
            [attachment],
            expect.objectContaining({ text: 'prompt with file' }),
            undefined,
            undefined
        );

        unmount();
    });

    it('user gets unsupported attachments left out of the retry', async () => {
        const supported = createAttachment('ok');
        const unsupported = createAttachment('bad', { supportStatus: 'unsupported-file' });
        const { result, unmount } = await mountFlow();
        agentState.sessionHistory.value = [
            createMessage('u1', 'user', {
                content: 'prompt',
                attachments: [supported, unsupported],
            }),
            createMessage('a1', 'assistant'),
        ];

        await result.handleRegenerateMessage('a1');
        await flushAsyncWork();

        const sentAttachments = agentState.sendRequest.mock.calls[0]![1] as Index[];
        expect(sentAttachments.map((item) => item.id)).toEqual(['ok']);

        unmount();
    });
});

describe('when the request flow is torn down', () => {
    it('user gets the session status listener released on unmount', async () => {
        const unlisten = vi.fn();
        eventOnMock.mockImplementationOnce(async () => unlisten);

        const { unmount } = await mountFlow();
        await flushAsyncWork();

        unmount();

        expect(unlisten).toHaveBeenCalled();
    });

    it('user gets a listener arriving after unmount released immediately', async () => {
        const unlisten = vi.fn();
        const listener = deferred<() => void>();
        eventOnMock.mockImplementationOnce(async () => listener.promise);

        const { unmount } = await mountFlow();
        unmount();

        // The subscription resolves after the composable is gone: it must clean up at once.
        listener.resolve(unlisten);
        await flushAsyncWork();

        expect(unlisten).toHaveBeenCalled();
    });

    it('user gets the view usable when the status subscription fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        eventOnMock.mockImplementationOnce(async () => {
            throw new Error('bus down');
        });

        const { result, unmount } = await mountFlow();
        await flushAsyncWork();

        expect(result.isSessionListLoading.value).toBe(false);

        unmount();
    });
});
