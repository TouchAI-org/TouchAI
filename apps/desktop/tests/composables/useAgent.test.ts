import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgent } from '@/composables/agent/useAgent';

const { notifyMock, sessionTaskCenterMock } = vi.hoisted(() => ({
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

function createTaskSnapshot(taskId: string) {
    return {
        taskId,
        sessionId: 1,
        turnId: 1,
        status: 'running' as const,
        executionMode: 'foreground' as const,
        prompt: 'hello',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
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
