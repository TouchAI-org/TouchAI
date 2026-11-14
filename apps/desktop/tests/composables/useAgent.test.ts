import { mountComposable } from '@tests/utils/composables';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgent } from '@/composables/agent/useAgent';
import type { PendingUserMessage, SessionTaskSnapshot } from '@/services/AgentService';

const { eventServiceOnMock, findSessionByIdMock, notifyMock, sessionTaskCenterMock } = vi.hoisted(
    () => ({
        eventServiceOnMock: vi.fn(),
        findSessionByIdMock: vi.fn(),
        notifyMock: vi.fn(),
        sessionTaskCenterMock: {
            attachSessionView: vi.fn(),
            approveTaskToolCall: vi.fn(() => true),
            cancelTask: vi.fn(() => true),
            clearSessionUserMessages: vi.fn(() => false),
            clearTaskUserMessages: vi.fn(() => false),
            enqueueSessionUserMessage: vi.fn<() => PendingUserMessage | null>(() => null),
            enqueueTaskUserMessage: vi.fn<() => PendingUserMessage | null>(() => null),
            promoteSessionUserMessage: vi.fn(() => false),
            promoteTaskUserMessage: vi.fn(() => false),
            rejectTaskToolCall: vi.fn(() => true),
            removeSessionUserMessage: vi.fn(() => false),
            removeTaskUserMessage: vi.fn(() => false),
            reorderSessionQueuedMessages: vi.fn(() => true),
            reorderTaskQueuedMessages: vi.fn(() => true),
            startTask: vi.fn(),
            subscribeTask: vi.fn(),
            updateSessionUserMessage: vi.fn(() => false),
            updateTaskUserMessage: vi.fn(() => false),
            updateTaskUserMessageModel: vi.fn(() => false),
        },
    })
);

vi.mock('@database/queries/sessions', () => ({
    findSessionById: findSessionByIdMock,
}));

vi.mock('@services/NotificationService', () => ({
    notify: notifyMock,
}));

vi.mock('@/services/EventService', () => ({
    eventService: {
        on: eventServiceOnMock,
    },
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
        sessionHistory: [],
        pendingUserMessages: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
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
        eventServiceOnMock.mockResolvedValue(() => undefined);
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
    it('user gets the answer refused rather than sent to a task that is gone', async () => {
        const mounted = await mountComposable(() => useAgent());

        // No task is attached, so every answer path has to decline instead of reaching the
        // backend; the dialog stays open and the user is not told the click was accepted.
        expect(mounted.result.approvePendingToolApproval('call-1')).toBe(false);
        expect(mounted.result.rejectPendingToolApproval('call-1')).toBe(false);
        expect(mounted.result.settleUserQuestion('call-1', null)).toBe(false);
        expect(sessionTaskCenterMock.approveTaskToolCall).not.toHaveBeenCalled();
        expect(sessionTaskCenterMock.rejectTaskToolCall).not.toHaveBeenCalled();

        mounted.unmount();
    });
});

describe('when the user drags queued messages into a new order', () => {
    it('user gets the active task queue reordered instead of only the visible list', async () => {
        vi.clearAllMocks();
        sessionTaskCenterMock.attachSessionView.mockReturnValue({
            taskId: 'task-1',
            snapshot: createTaskSnapshot('task-1'),
        });
        sessionTaskCenterMock.subscribeTask.mockImplementation((_taskId, listener) => {
            listener(createTaskSnapshot('task-1'));
            return () => undefined;
        });
        sessionTaskCenterMock.reorderTaskQueuedMessages.mockReturnValue(true);

        const mounted = await mountComposable(() => useAgent());
        await mounted.result.openSession(1);

        expect(mounted.result.reorderPendingUserMessages(['queued-2', 'queued-1'])).toBe(true);
        expect(sessionTaskCenterMock.reorderTaskQueuedMessages).toHaveBeenCalledWith('task-1', [
            'queued-2',
            'queued-1',
        ]);

        mounted.unmount();
    });
});

describe('when the user manages messages waiting behind a run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        eventServiceOnMock.mockResolvedValue(() => undefined);
        findSessionByIdMock.mockResolvedValue({ id: 1, title: 'Active session' });
        sessionTaskCenterMock.attachSessionView.mockReturnValue({
            taskId: 'task-1',
            snapshot: createTaskSnapshot('task-1'),
        });
        sessionTaskCenterMock.subscribeTask.mockImplementation((_taskId, listener) => {
            listener(createTaskSnapshot('task-1'));
            return () => undefined;
        });
    });

    it('user gets every queue command applied to the task they are watching', async () => {
        const pending = {
            id: 'message-1',
            prompt: 'queued',
            attachments: [],
            delivery: 'queue' as const,
            createdAt: 1,
        };
        sessionTaskCenterMock.enqueueTaskUserMessage.mockReturnValue(pending);
        sessionTaskCenterMock.removeTaskUserMessage.mockReturnValue(true);
        sessionTaskCenterMock.updateTaskUserMessage.mockReturnValue(true);
        sessionTaskCenterMock.promoteTaskUserMessage.mockReturnValue(true);
        sessionTaskCenterMock.reorderTaskQueuedMessages.mockReturnValue(true);
        sessionTaskCenterMock.clearTaskUserMessages.mockReturnValue(true);
        sessionTaskCenterMock.updateTaskUserMessageModel.mockReturnValue(true);

        const mounted = await mountComposable(() => useAgent());
        await mounted.result.openSession(1);

        expect(mounted.result.enqueueUserMessage({ prompt: 'queued' }, 'queue')).toBe(pending);
        expect(mounted.result.removePendingUserMessage('message-1')).toBe(true);
        expect(mounted.result.updatePendingUserMessage('message-1', { prompt: 'edited' })).toBe(
            true
        );
        expect(mounted.result.promotePendingUserMessage('message-1')).toBe(true);
        expect(mounted.result.reorderPendingUserMessages(['message-2', 'message-1'])).toBe(true);
        expect(mounted.result.clearPendingUserMessages()).toBe(true);
        expect(mounted.result.updatePendingUserMessagesModel('model-2', 2)).toBe(true);

        expect(sessionTaskCenterMock.enqueueTaskUserMessage).toHaveBeenCalledWith(
            'task-1',
            { prompt: 'queued' },
            'queue'
        );
        expect(sessionTaskCenterMock.updateTaskUserMessage).toHaveBeenCalledWith(
            'task-1',
            'message-1',
            { prompt: 'edited' }
        );
        expect(sessionTaskCenterMock.reorderTaskQueuedMessages).toHaveBeenCalledWith('task-1', [
            'message-2',
            'message-1',
        ]);
        expect(sessionTaskCenterMock.updateTaskUserMessageModel).toHaveBeenCalledWith(
            'task-1',
            'model-2',
            2
        );

        mounted.unmount();
    });

    it('user gets queue commands handed to the session while the next task starts', async () => {
        const pending = {
            id: 'message-2',
            prompt: 'late',
            attachments: [],
            delivery: 'queue' as const,
            createdAt: 2,
        };
        sessionTaskCenterMock.enqueueTaskUserMessage.mockReturnValue(null);
        sessionTaskCenterMock.enqueueSessionUserMessage.mockReturnValue(pending);
        sessionTaskCenterMock.removeTaskUserMessage.mockReturnValue(false);
        sessionTaskCenterMock.removeSessionUserMessage.mockReturnValue(true);
        sessionTaskCenterMock.updateTaskUserMessage.mockReturnValue(false);
        sessionTaskCenterMock.updateSessionUserMessage.mockReturnValue(true);
        sessionTaskCenterMock.promoteTaskUserMessage.mockReturnValue(false);
        sessionTaskCenterMock.promoteSessionUserMessage.mockReturnValue(true);
        sessionTaskCenterMock.reorderTaskQueuedMessages.mockReturnValue(false);
        sessionTaskCenterMock.reorderSessionQueuedMessages.mockReturnValue(true);
        sessionTaskCenterMock.clearTaskUserMessages.mockReturnValue(false);
        sessionTaskCenterMock.clearSessionUserMessages.mockReturnValue(true);

        const mounted = await mountComposable(() => useAgent());
        await mounted.result.openSession(1);

        expect(mounted.result.enqueueUserMessage({ prompt: 'late' }, 'queue')).toBe(pending);
        expect(mounted.result.removePendingUserMessage('message-2')).toBe(true);
        expect(
            mounted.result.updatePendingUserMessage('message-2', { prompt: 'late edited' })
        ).toBe(true);
        expect(mounted.result.promotePendingUserMessage('message-2')).toBe(true);
        expect(mounted.result.reorderPendingUserMessages(['message-3', 'message-2'])).toBe(true);
        expect(mounted.result.clearPendingUserMessages()).toBe(true);

        expect(sessionTaskCenterMock.enqueueSessionUserMessage).toHaveBeenCalledWith(
            1,
            { prompt: 'late' },
            'queue'
        );
        expect(sessionTaskCenterMock.reorderSessionQueuedMessages).toHaveBeenCalledWith(1, [
            'message-3',
            'message-2',
        ]);

        mounted.unmount();
    });

    it('user gets no phantom queue command when no task or session is open', async () => {
        const mounted = await mountComposable(() => useAgent());

        expect(mounted.result.enqueueUserMessage({ prompt: 'orphan' }, 'queue')).toBeNull();
        expect(mounted.result.removePendingUserMessage('message-1')).toBe(false);
        expect(mounted.result.updatePendingUserMessage('message-1', { prompt: 'edit' })).toBe(
            false
        );
        expect(mounted.result.promotePendingUserMessage('message-1')).toBe(false);
        expect(mounted.result.reorderPendingUserMessages(['message-1'])).toBe(false);
        expect(mounted.result.clearPendingUserMessages()).toBe(false);
        expect(mounted.result.updatePendingUserMessagesModel('model-2', 2)).toBe(false);
        expect(sessionTaskCenterMock.enqueueSessionUserMessage).not.toHaveBeenCalled();
        expect(sessionTaskCenterMock.removeSessionUserMessage).not.toHaveBeenCalled();

        mounted.unmount();
    });

    it('user gets attached when a queued task starts while they keep the same session open', async () => {
        const queuedSnapshot = createTaskSnapshot('task-2');
        sessionTaskCenterMock.attachSessionView
            .mockReturnValueOnce({
                taskId: 'task-1',
                snapshot: createTaskSnapshot('task-1'),
            })
            .mockReturnValueOnce({
                taskId: 'task-2',
                snapshot: queuedSnapshot,
            });

        const mounted = await mountComposable(() => useAgent());
        await mounted.result.openSession(1);
        await Promise.resolve();

        const listener = eventServiceOnMock.mock.calls[0]?.[1] as
            | ((event: { sessionId: number | null; status: string; taskId: string }) => void)
            | undefined;
        listener?.({ sessionId: 1, status: 'running', taskId: 'task-2' });

        expect(sessionTaskCenterMock.subscribeTask).toHaveBeenLastCalledWith(
            'task-2',
            expect.any(Function)
        );

        mounted.unmount();
    });

    it('user keeps the current task when a different session starts running', async () => {
        const mounted = await mountComposable(() => useAgent());
        await mounted.result.openSession(1);
        await Promise.resolve();

        const attachCalls = sessionTaskCenterMock.attachSessionView.mock.calls.length;
        const listener = eventServiceOnMock.mock.calls[0]?.[1] as
            | ((event: { sessionId: number | null; status: string; taskId: string }) => void)
            | undefined;
        listener?.({ sessionId: 2, status: 'running', taskId: 'task-2' });

        expect(sessionTaskCenterMock.attachSessionView).toHaveBeenCalledTimes(attachCalls);

        mounted.unmount();
    });
});
