import type { SessionEntity } from '@database/types';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { createInputHistorySnapshot } from '@/types/session';
import { useSearchRequestFlow } from '@/views/SearchView/composables/useSearchRequest';

const { agentState, analyticsSpies, eventHandlers, listSessionsMock, useAgentMock } = vi.hoisted(
    () => {
        const handlers = new Map<string, (payload?: unknown) => unknown>();
        const agent = {
            isLoading: { value: false },
            error: { value: null },
            currentSessionId: { value: null as number | null },
            sessionHistory: { value: [] },
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
            agentState: agent,
            analyticsSpies: {
                beginSearchInteraction: vi.fn(),
                settleSearchInteraction: vi.fn().mockResolvedValue(undefined),
                selectSearchResult: vi.fn().mockResolvedValue(undefined),
                finishSearchInteraction: vi.fn().mockResolvedValue(undefined),
                trackSearchFeatureExposed: vi.fn().mockResolvedValue(undefined),
                trackSurfaceOpened: vi.fn().mockResolvedValue(undefined),
            },
            eventHandlers: handlers,
            listSessionsMock: vi.fn().mockResolvedValue([]),
            useAgentMock: vi.fn(() => agent),
        };
    }
);

vi.mock('@composables/agent', () => ({ useAgent: useAgentMock }));

vi.mock('@services/NotificationService', () => ({ notify: vi.fn() }));

vi.mock('@services/AgentService/session', async () => {
    const actual = await vi.importActual<typeof import('@services/AgentService/session')>(
        '@services/AgentService/session'
    );
    return {
        ...actual,
        dismissSessionTerminalStatus: vi.fn().mockResolvedValue(undefined),
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

vi.mock('@services/AnalyticsService/productInteractions', () => ({
    beginSearchInteraction: analyticsSpies.beginSearchInteraction,
    settleSearchInteraction: analyticsSpies.settleSearchInteraction,
    selectSearchResult: analyticsSpies.selectSearchResult,
    finishSearchInteraction: analyticsSpies.finishSearchInteraction,
    trackSearchFeatureExposed: analyticsSpies.trackSearchFeatureExposed,
    trackSurfaceOpened: analyticsSpies.trackSurfaceOpened,
}));

function createSessionEntity(id: number): SessionEntity {
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
    };
}

function createInteraction() {
    return {
        operation: { operationId: 'op', enabled: true, consentEpoch: 1 },
        interactionId: 'history-interaction-1',
        scope: 'history' as const,
        startedAtMs: 0,
        settled: false,
    };
}

async function mountFlow() {
    return mountComposable(() =>
        useSearchRequestFlow({
            modelOverride: ref({ modelId: null, providerId: null }),
            clearDraft: vi.fn(),
            getSupportedAttachments: () => [],
            getUnsupportedAttachmentMessage: () => null,
            getCurrentInputSnapshot: (query) =>
                createInputHistorySnapshot({ text: query, attachments: [] }),
        })
    );
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

describe('user searches conversation history', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventHandlers.clear();
        agentState.currentSessionId.value = null;
        agentState.openSession.mockResolvedValue({
            sessionId: 7,
            title: 'Loaded',
            modelId: 'gpt-5',
            providerId: 9,
        });
        listSessionsMock.mockResolvedValue([createSessionEntity(7)]);
        analyticsSpies.beginSearchInteraction.mockImplementation(async () => createInteraction());
        analyticsSpies.settleSearchInteraction.mockResolvedValue(undefined);
        analyticsSpies.selectSearchResult.mockResolvedValue(undefined);
        analyticsSpies.finishSearchInteraction.mockResolvedValue(undefined);
        analyticsSpies.trackSearchFeatureExposed.mockResolvedValue(undefined);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user gets one settled history search when the popup closes', async () => {
        const { result, unmount } = await mountFlow();

        await result.setSessionHistoryPopupOpen(true);
        await result.ensureSessionListLoaded();
        await flushAsyncWork();
        await result.setSessionHistoryPopupOpen(false);
        await flushAsyncWork();

        expect(analyticsSpies.beginSearchInteraction).toHaveBeenCalledWith('history');
        expect(analyticsSpies.trackSurfaceOpened).toHaveBeenCalledWith('history');
        expect(analyticsSpies.settleSearchInteraction).toHaveBeenCalledTimes(1);
        expect(analyticsSpies.settleSearchInteraction).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'history-interaction-1' }),
            { hasResults: true, resultCount: 1 }
        );
        expect(analyticsSpies.finishSearchInteraction).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets the opened conversation recorded on the same interaction', async () => {
        const { result, unmount } = await mountFlow();

        await result.setSessionHistoryPopupOpen(true);
        await result.ensureSessionListLoaded();
        await flushAsyncWork();
        await result.openSession(7);
        await flushAsyncWork();

        expect(analyticsSpies.selectSearchResult).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'history-interaction-1' }),
            { category: 'conversation', opened: true }
        );
        expect(analyticsSpies.settleSearchInteraction).toHaveBeenCalledTimes(1);
        expect(analyticsSpies.finishSearchInteraction).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets the same history handle kept across close until the selection is recorded', async () => {
        const { result, unmount } = await mountFlow();

        await result.setSessionHistoryPopupOpen(true);
        await result.ensureSessionListLoaded();
        await flushAsyncWork();
        result.markHistorySelectionPending();
        await result.setSessionHistoryPopupOpen(false);
        await flushAsyncWork();

        expect(analyticsSpies.finishSearchInteraction).not.toHaveBeenCalled();

        await result.openSession(7);
        await flushAsyncWork();

        expect(analyticsSpies.selectSearchResult).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'history-interaction-1' }),
            { category: 'conversation', opened: true }
        );
        expect(analyticsSpies.finishSearchInteraction).toHaveBeenCalledTimes(1);

        unmount();
    });

    it('user gets a not-opened result when opening the conversation fails', async () => {
        agentState.openSession.mockRejectedValue(new Error('missing'));
        const { result, unmount } = await mountFlow();

        await result.setSessionHistoryPopupOpen(true);
        await result.ensureSessionListLoaded();
        await flushAsyncWork();
        await expect(result.openSession(7)).rejects.toThrow('missing');
        await flushAsyncWork();

        expect(analyticsSpies.selectSearchResult).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: 'history-interaction-1' }),
            { category: 'conversation', opened: false }
        );
        expect(analyticsSpies.finishSearchInteraction).toHaveBeenCalledTimes(1);

        unmount();
    });
});
