import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgent } from '@/composables/agent/useAgent';
import type { SessionTaskSnapshot } from '@/services/AgentService';

const { findSessionByIdMock, notifyMock, sessionTaskCenterMock } = vi.hoisted(() => ({
    findSessionByIdMock: vi.fn(),
    notifyMock: vi.fn(),
    sessionTaskCenterMock: {
        attachSessionView: vi.fn(),
        approveTaskToolCall: vi.fn(() => true),
        cancelTask: vi.fn(() => true),
        rejectTaskToolCall: vi.fn(() => true),
        startTask: vi.fn(),
        subscribeTask: vi.fn(),
    },
}));

vi.mock('@database/queries/sessions', () => ({
    findSessionById: findSessionByIdMock,
}));

vi.mock('@services/NotificationService', () => ({
    notify: notifyMock,
}));

vi.mock('@/services/AgentService', async () => {
    const actual =
        await vi.importActual<typeof import('@/services/AgentService')>('@/services/AgentService');
    return {
        ...actual,
        sessionTaskCenter: sessionTaskCenterMock,
    };
});

function createTaskSnapshot(
    taskId: string,
    overrides: Partial<SessionTaskSnapshot> = {}
): SessionTaskSnapshot {
    const snapshot: SessionTaskSnapshot = {
        taskId,
        sessionId: 1,
        turnId: 1,
        status: 'running' as const,
        executionMode: 'foreground' as const,
        prompt: 'hello',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };

    return Object.assign(snapshot, overrides);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });

    return { promise, resolve };
}

describe('when the user sends a prompt', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findSessionByIdMock.mockResolvedValue({ id: 1, title: 'Active session' });
        sessionTaskCenterMock.attachSessionView.mockReturnValue(null);
        sessionTaskCenterMock.subscribeTask.mockImplementation((_taskId, listener) => {
            listener(createTaskSnapshot('task-1'));
            return () => undefined;
        });
    });

    it('user gets the failure reported in the app without a second desktop notification', async () => {
        sessionTaskCenterMock.startTask.mockResolvedValue({
            taskId: 'task-1',
            sessionId: 1,
            completion: Promise.reject(new Error('task failed')),
        });

        const mounted = await mountComposable(() => useAgent());

        await mounted.result.sendRequest('hello');

        expect(mounted.result.error.value?.message).toBe('task failed');
        expect(notifyMock).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user is told when the request could not even start', async () => {
        sessionTaskCenterMock.startTask.mockRejectedValue(new Error('startup failed'));

        const mounted = await mountComposable(() => useAgent());

        await mounted.result.sendRequest('hello');

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI - 请求失败',
            body: 'startup failed',
        });

        mounted.unmount();
    });

    it('user gets no orphan task subscription when the request is dropped before it starts', async () => {
        for (const dropRequest of ['clearSession', 'cancel'] as const) {
            vi.clearAllMocks();
            const startTask = deferred<{
                taskId: string;
                sessionId: number;
                completion: Promise<never>;
            }>();
            let startupSignal: AbortSignal | undefined;
            sessionTaskCenterMock.startTask.mockImplementation((options) => {
                startupSignal = options.signal;
                return startTask.promise;
            });

            const mounted = await mountComposable(() => useAgent());
            const sendPromise = mounted.result.sendRequest('hello');
            expect(startupSignal?.aborted).toBe(false);

            if (dropRequest === 'clearSession') {
                mounted.result.clearSession();
            } else {
                mounted.result.cancel();
            }

            // The startup must be aborted and the spinner cleared right away.
            expect(startupSignal?.aborted).toBe(true);
            expect(mounted.result.isLoading.value).toBe(false);

            startTask.resolve({
                taskId: 'task-1',
                sessionId: 1,
                completion: new Promise<never>(() => undefined),
            });
            await sendPromise;

            expect(sessionTaskCenterMock.subscribeTask).not.toHaveBeenCalled();

            mounted.unmount();
        }
    });
});

describe('when the user reopens a conversation that switched models', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findSessionByIdMock.mockResolvedValue({ id: 1, title: 'Active session' });
    });

    it('user sees the upgraded model selected for the reopened conversation', async () => {
        const switchedSnapshot = createTaskSnapshot('task-1', {
            currentModel: {
                modelDbId: 7,
                providerId: 9,
                providerName: 'Provider',
                modelId: 'upgraded-model',
                modelName: 'Upgraded Model',
            },
            modelSwitchCount: 1,
        });
        const onModelSelected = vi.fn();

        sessionTaskCenterMock.attachSessionView.mockReturnValue({
            taskId: 'task-1',
            snapshot: switchedSnapshot,
        });
        sessionTaskCenterMock.subscribeTask.mockImplementation((_taskId, listener) => {
            listener(switchedSnapshot);
            return () => undefined;
        });

        const mounted = await mountComposable(() => useAgent({ onModelSelected }));

        const loadedSession = await mounted.result.openSession(1);

        expect(loadedSession).toMatchObject({
            modelId: 'upgraded-model',
            providerId: 9,
        });
        expect(onModelSelected).toHaveBeenCalledWith({
            modelId: 'upgraded-model',
            providerId: 9,
        });

        mounted.unmount();
    });
});

describe('when the user answers a tool approval with nothing attached', () => {
    it('user gets the approval refused instead of crashing', async () => {
        const mounted = await mountComposable(() => useAgent());

        // With no task attached there is nothing to approve; returning false keeps the
        // dialog open rather than silently discarding the user's click.
        expect(mounted.result.approvePendingToolApproval('call-1')).toBe(false);
        expect(sessionTaskCenterMock.approveTaskToolCall).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the rejection refused instead of crashing', async () => {
        const mounted = await mountComposable(() => useAgent());

        expect(mounted.result.rejectPendingToolApproval('call-1')).toBe(false);
        expect(sessionTaskCenterMock.rejectTaskToolCall).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets the question answer refused instead of crashing', async () => {
        const mounted = await mountComposable(() => useAgent());

        // An answer typed into a panel whose task has gone must not be sent anywhere.
        expect(mounted.result.settleUserQuestion('call-1', null)).toBe(false);

        mounted.unmount();
    });
});
