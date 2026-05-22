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
});
