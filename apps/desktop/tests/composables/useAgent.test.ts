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
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });

    return {
        promise,
        resolve,
        reject,
    };
}

describe('useAgent', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findSessionByIdMock.mockResolvedValue({ id: 1, title: 'Active session' });
        sessionTaskCenterMock.attachSessionView.mockReturnValue(null);
        sessionTaskCenterMock.subscribeTask.mockImplementation((_taskId, listener) => {
            listener(createTaskSnapshot('task-1'));
            return () => undefined;
        });
    });

    it('does not send a duplicate OS notification when a started task later fails', async () => {
        sessionTaskCenterMock.startTask.mockResolvedValue({
            taskId: 'task-1',
            sessionId: 1,
            completion: Promise.reject(new Error('task failed')),
        });

        const mounted = await mountComposable(() => useAgent());

        await mounted.result.sendRequest('hello');

        expect(notifyMock).not.toHaveBeenCalled();
        expect(mounted.result.error.value?.message).toBe('task failed');

        mounted.unmount();
    });

    it('syncs the selected model when reopening an active session after a model switch', async () => {
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
        expect(onModelSelected).toHaveBeenCalledTimes(1);
        expect(onModelSelected).toHaveBeenCalledWith({
            modelId: 'upgraded-model',
            providerId: 9,
        });

        mounted.unmount();
    });

    it('still notifies when request startup fails before a task is created', async () => {
        sessionTaskCenterMock.startTask.mockRejectedValue(new Error('startup failed'));

        const mounted = await mountComposable(() => useAgent());

        await mounted.result.sendRequest('hello');

        expect(notifyMock).toHaveBeenCalledWith({
            title: 'TouchAI - 请求失败',
            body: 'startup failed',
        });

        mounted.unmount();
    });

    it('aborts pending task startup when the session is cleared before attach', async () => {
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

        mounted.result.clearSession();

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
    });

    it('invalidates pending task startup when cancelled before attach', async () => {
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

        mounted.result.cancel();

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
    });
});
