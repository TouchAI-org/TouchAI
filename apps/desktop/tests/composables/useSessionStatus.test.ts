import { log } from '@services/ObservabilityService';
import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, watch } from 'vue';

import { useSessionStatus } from '@/composables/useSessionStatus';
import { AppEvent } from '@/services/EventService/types';

/**
 * The session list shows a running or waiting badge next to each session. The composable is the
 * only thing that decides which sessions carry one, so a mistake here either hides work in
 * progress or leaves a badge on a session that finished an hour ago.
 */
const { eventServiceMock, sessionTaskCenterMock } = vi.hoisted(() => ({
    eventServiceMock: {
        on: vi.fn(),
    },
    sessionTaskCenterMock: {
        getSessionStatus: vi.fn(),
    },
}));

vi.mock('@/services/EventService', () => ({ eventService: eventServiceMock }));
vi.mock('@/services/AgentService', () => ({ sessionTaskCenter: sessionTaskCenterMock }));

type StatusListener = (event: { sessionId: number; status: string }) => void;

let statusListener: StatusListener;

beforeEach(() => {
    vi.clearAllMocks();
    eventServiceMock.on.mockImplementation((_event: string, listener: StatusListener) => {
        statusListener = listener;
        return Promise.resolve(() => undefined);
    });
});

describe('user sees which sessions are busy', () => {
    it('user gets a badge when a session starts running', async () => {
        const { result, unmount } = await mountComposable(() => useSessionStatus());

        statusListener({ sessionId: 1, status: 'running' });

        expect(result.getSessionStatus(1)).toBe('running');
        unmount();
    });

    it('user gets a badge when a session waits for approval', async () => {
        const { result, unmount } = await mountComposable(() => useSessionStatus());

        statusListener({ sessionId: 2, status: 'waiting_approval' });

        expect(result.getSessionStatus(2)).toBe('waiting_approval');
        unmount();
    });

    it('user loses the badge when the session completes', async () => {
        const { result, unmount } = await mountComposable(() => useSessionStatus());
        statusListener({ sessionId: 1, status: 'running' });

        statusListener({ sessionId: 1, status: 'completed' });

        // A finished session must not keep a badge; the list would look stuck.
        expect(result.getSessionStatus(1)).toBeUndefined();
        unmount();
    });

    it('user loses the badge when the session fails', async () => {
        const { result, unmount } = await mountComposable(() => useSessionStatus());
        statusListener({ sessionId: 1, status: 'running' });

        statusListener({ sessionId: 1, status: 'failed' });

        expect(result.getSessionStatus(1)).toBeUndefined();
        unmount();
    });

    it('user keeps each session badge independent', async () => {
        const { result, unmount } = await mountComposable(() => useSessionStatus());

        statusListener({ sessionId: 1, status: 'running' });
        statusListener({ sessionId: 2, status: 'waiting_approval' });

        expect(result.getSessionStatus(1)).toBe('running');
        expect(result.getSessionStatus(2)).toBe('waiting_approval');
        unmount();
    });

    it('user gets the list re-rendered when a badge appears', async () => {
        const { result, unmount } = await mountComposable(() => useSessionStatus());
        // A watcher stands in for the session list: it only fires if the ref is reactive,
        // whether the implementation replaces the Map or mutates it in place.
        let renders = 0;
        const stop = watch(
            result.sessionStatuses,
            () => {
                renders += 1;
            },
            { deep: true }
        );

        statusListener({ sessionId: 1, status: 'running' });
        await nextTick();

        expect(renders).toBeGreaterThan(0);
        expect(result.getSessionStatus(1)).toBe('running');
        stop();
        unmount();
    });

    it('user gets only the busy sessions refreshed from the task centre', async () => {
        sessionTaskCenterMock.getSessionStatus.mockImplementation((sessionId: number) =>
            sessionId === 1
                ? { status: 'running' }
                : sessionId === 2
                  ? { status: 'completed' }
                  : undefined
        );
        const { result, unmount } = await mountComposable(() => useSessionStatus());

        result.refreshAllStatuses([1, 2, 3]);

        // 1 is busy; 2 finished and 3 is unknown, so neither carries a badge.
        expect(result.getSessionStatus(1)).toBe('running');
        expect(result.getSessionStatus(2)).toBeUndefined();
        expect(result.getSessionStatus(3)).toBeUndefined();
        unmount();
    });

    it('user gets the refresh to replace earlier badges rather than merge them', async () => {
        sessionTaskCenterMock.getSessionStatus.mockReturnValue({ status: 'completed' });
        const { result, unmount } = await mountComposable(() => useSessionStatus());
        statusListener({ sessionId: 1, status: 'running' });
        statusListener({ sessionId: 2, status: 'waiting_approval' });

        // Session 2 is not mentioned by the refresh at all.
        result.refreshAllStatuses([1]);

        // The refresh is authoritative: an omitted session loses its badge too.
        expect(result.getSessionStatus(1)).toBeUndefined();
        expect(result.getSessionStatus(2)).toBeUndefined();
        unmount();
    });

    it('user gets the status subscription opened once on mount', async () => {
        const { unmount } = await mountComposable(() => useSessionStatus());

        expect(eventServiceMock.on).toHaveBeenCalledWith(
            AppEvent.SESSION_TASK_STATUS_CHANGED,
            expect.any(Function)
        );
        expect(eventServiceMock.on).toHaveBeenCalledTimes(1);
        unmount();
    });

    it('user gets the subscription closed when the view goes away', async () => {
        const unlisten = vi.fn();
        eventServiceMock.on.mockResolvedValue(unlisten);
        const { unmount } = await mountComposable(() => useSessionStatus());

        unmount();
        await Promise.resolve();

        expect(unlisten).toHaveBeenCalled();
    });

    it('user gets the subscription closed even when it resolves after the view is gone', async () => {
        let resolveSubscription: (unlisten: () => void) => void = () => undefined;
        const pending = new Promise<() => void>((resolve) => {
            resolveSubscription = resolve;
        });
        eventServiceMock.on.mockReturnValue(pending);
        const unlisten = vi.fn();

        const { unmount } = await mountComposable(() => useSessionStatus());
        unmount();
        resolveSubscription(unlisten);
        await Promise.resolve();
        await Promise.resolve();

        // A late subscription must not leak a listener on a dead view.
        expect(unlisten).toHaveBeenCalled();
    });

    it('user gets no badge when the subscription fails to open', async () => {
        eventServiceMock.on.mockRejectedValue(new Error('no bridge'));
        const consoleError = vi.spyOn(log, 'error').mockImplementation(() => undefined);

        const { result, unmount } = await mountComposable(() => useSessionStatus());
        await Promise.resolve();

        // The view must still render with an empty map rather than throwing.
        expect(result.sessionStatuses.value.size).toBe(0);
        expect(consoleError).toHaveBeenCalled();
        consoleError.mockRestore();
        unmount();
    });
});
