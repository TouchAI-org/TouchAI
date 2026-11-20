import { AgentError, type AgentEvent, type AgentResult } from '@touchai/agent-core/contracts';
import { emptyAiUsage } from '@touchai/models/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentSessions } from '@/modules/agent';
import type {
    AgentPendingDelivery,
    AgentSessionExecution,
    PendingMessageStore,
    PendingUserMessage,
    StartSessionTaskOptions,
} from '@/modules/agent/contracts';

type TaskResult = AgentResult;
const model = {
    modelDbId: 1,
    providerId: 1,
    providerName: 'Provider',
    modelId: 'model-1',
    modelName: 'Model',
};
type Request = StartSessionTaskOptions & {
    queue: AgentPendingDelivery;
    emit(event: Record<string, unknown>): void;
};
const executionState = {
    run: vi.fn<() => Promise<TaskResult>>(),
    instances: [] as Array<{ options: Request }>,
};
const historyState = { loadSessionHistory: vi.fn() };
let startup = Promise.resolve();
const registerStartupCapability = (_name: string, ready: Promise<void>) => {
    startup = ready;
};
const resetStartupCapabilities = () => {
    startup = Promise.resolve();
};
const latestOptions = () => executionState.instances.at(-1)!.options;
const completedTurn = (response: string): TaskResult => ({
    modelKey: 'model',
    turnKey: 'turn:1',
    response,
    reasoning: '',
    usage: emptyAiUsage(),
    calls: [],
});
let finishCurrentTask: (() => void) | null = null;
function finishableRun(sessionId: number | null) {
    return () =>
        new Promise<TaskResult>((resolve) => {
            const options = latestOptions();
            options.emit({ type: 'task_started', sessionId });
            finishCurrentTask = () => resolve(completedTurn('done'));
        });
}
function staysRunningInSession(sessionId: number | null) {
    return () => {
        latestOptions().emit({ type: 'task_started', sessionId });
        return new Promise<TaskResult>(() => {});
    };
}
const pendingMessageStore: PendingMessageStore = {
    enqueue: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
    reorder: vi.fn(),
    updateModel: vi.fn(),
    flush: vi.fn(async () => {}),
    load: vi.fn(async () => []),
};
const disposals: Array<() => Promise<void>> = [];
function createCenter() {
    const executions = new Map<
        string,
        {
            events: AgentEvent[];
            listeners: Set<(event: AgentEvent) => void>;
            controller: AbortController;
            finish(event: Record<string, unknown>): void;
        }
    >();
    const execution: AgentSessionExecution = {
        start(options, queue) {
            const taskId = crypto.randomUUID();
            const controller = new AbortController();
            options.signal?.addEventListener('abort', () => controller.abort(), { once: true });
            let resolve!: (value: TaskResult) => void;
            let reject!: (error: unknown) => void;
            let ended = false;
            const completion = new Promise<TaskResult>((accept, fail) => {
                resolve = accept;
                reject = fail;
            });
            const events: AgentEvent[] = [];
            const listeners = new Set<(event: AgentEvent) => void>();
            const publish = (event: AgentEvent) => {
                events.push(event);
                for (const listener of listeners) listener(event);
            };
            const emit = (value: Record<string, unknown>) => {
                if (value.type === 'user_messages_delivered') {
                    queue!.delivered(value.messages as never);
                    return;
                }
                if (value.type === 'task_started') {
                    publish({
                        type: 'task_started',
                        taskId,
                        conversationKey:
                            value.sessionId === null ? null : `session:${value.sessionId}`,
                        turnKey: 'turn:1',
                        modelKey: 'model',
                    });
                    return;
                }
                if (ended) return;
                if (value.type === 'task_completed') {
                    ended = true;
                    const result = completedTurn('done');
                    publish({ type: 'task_completed', taskId, result });
                    resolve(result);
                } else if (value.type === 'task_failed' || value.type === 'task_cancelled') {
                    ended = true;
                    const errorCode =
                        value.type === 'task_cancelled' ? 'REQUEST_CANCELLED' : 'PROVIDER_FAILED';
                    publish(
                        value.type === 'task_cancelled'
                            ? { type: 'task_cancelled', taskId, errorCode }
                            : { type: 'task_failed', taskId, errorCode }
                    );
                    reject(new AgentError(errorCode));
                }
            };
            executions.set(taskId, { events, listeners, controller, finish: emit });
            executionState.instances.push({
                options: { ...options, signal: controller.signal, queue: queue!, emit },
            });
            controller.signal.addEventListener(
                'abort',
                () => queueMicrotask(() => emit({ type: 'task_cancelled' })),
                { once: true }
            );
            void Promise.resolve(executionState.run()).then(
                () => emit({ type: 'task_completed' }),
                () => emit({ type: controller.signal.aborted ? 'task_cancelled' : 'task_failed' })
            );
            return { taskId, completion };
        },
        subscribe(id, listener) {
            const run = executions.get(id)!;
            run.listeners.add(listener);
            for (const event of run.events) listener(event);
            return () => {
                run.listeners.delete(listener);
            };
        },
        cancel(id) {
            const run = executions.get(id);
            if (!run) return false;
            run.controller.abort();
            return true;
        },
        reply: () => false,
    };
    const center = createAgentSessions({
        execution,
        pendingMessages: pendingMessageStore,
        beforeStart: () => startup,
        loadHistory: historyState.loadSessionHistory,
        modelSummary: () => model,
        subscribePresentation: () => () => {},
        messages: { tt: (key) => key, errorText: (code) => code, retryText: () => 'retry' },
        tools: {
            resolveSemantic: () => null,
            presentation: () => null,
            widgetToolName: 'builtin__show_widget',
        },
    });
    disposals.push(center.dispose);
    return center;
}
beforeEach(() => {
    executionState.run.mockReset();
    executionState.instances.length = 0;
    historyState.loadSessionHistory.mockReset();
    historyState.loadSessionHistory.mockResolvedValue([]);
    for (const value of Object.values(pendingMessageStore)) vi.mocked(value).mockClear();
    vi.mocked(pendingMessageStore.load).mockReset().mockResolvedValue([]);
    finishCurrentTask = null;
    resetStartupCapabilities();
});
afterEach(async () => {
    resetStartupCapabilities();
    for (const dispose of disposals.splice(0)) await dispose();
});

describe('user submits a message while a task runs', () => {
    it('user gets the queued message as a pending bubble on the task snapshot', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Follow up' },
            'queue'
        );

        expect(message).toMatchObject({ prompt: 'Follow up', delivery: 'queue' });
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([message]);
        expect(pendingMessageStore.enqueue).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ id: message!.id, prompt: 'Follow up' })
        );
    });

    it('user keeps the priority bubble until the projection reports it delivered', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Insert me' },
            'priority'
        );

        // The runtime may ask twice before the delivery event lands; it may claim
        // the message only once, and neither read removes the bubble early.
        expect(latestOptions().queue.claimPriority()).toEqual([message]);
        expect(latestOptions().queue.claimPriority()).toEqual([]);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toHaveLength(1);
    });

    it('user gets queued writes flushed before a priority delivery', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        await center.startTask({ prompt: 'Hi', sessionId: 1 });
        vi.mocked(pendingMessageStore.flush).mockClear();

        await latestOptions().queue.flush();

        expect(pendingMessageStore.flush).toHaveBeenCalledWith(1);
    });

    it('user cannot queue more than twenty messages on one run', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        for (let index = 0; index < 20; index += 1) {
            expect(
                center.enqueueTaskUserMessage(
                    started.taskId,
                    { prompt: `queued ${index}` },
                    'queue'
                )
            ).not.toBeNull();
        }

        expect(
            center.enqueueTaskUserMessage(started.taskId, { prompt: 'overflow' }, 'queue')
        ).toBeNull();
    });

    it('user cannot remove a steer while its delivery is in flight', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Insert me' },
            'priority'
        )!;

        expect(latestOptions().queue.claimPriority()).toEqual([message]);
        expect(center.removeTaskUserMessage(started.taskId, message.id)).toBe(false);
        expect(center.promoteTaskUserMessage(started.taskId, message.id)).toBe(false);
        expect(
            center.updateTaskUserMessage(started.taskId, message.id, { prompt: 'Changed' })
        ).toBe(false);

        latestOptions().queue.releasePriority([message.id]);
        expect(center.removeTaskUserMessage(started.taskId, message.id)).toBe(true);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([]);
    });

    it('user gets the bubble gone once the projection reports the delivery', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Insert me' },
            'priority'
        );
        const seen: unknown[] = [];
        center.subscribeTask(started.taskId, (snapshot) => seen.push(snapshot));

        latestOptions().emit({
            type: 'user_messages_delivered',
            taskId: started.taskId,
            messages: [{ id: message!.id, prompt: 'Insert me', attachments: [] }],
        });

        const snapshot = center.getTaskSnapshot(started.taskId);
        expect(snapshot?.pendingUserMessages).toEqual([]);
        expect(snapshot?.sessionHistory.filter((entry) => entry.id === message!.id)).toHaveLength(
            1
        );
        expect(seen.length).toBeGreaterThan(0);
    });

    it('user gets a queued message promoted to the next tool boundary', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Send me now' },
            'queue'
        );

        expect(center.promoteTaskUserMessage(started.taskId, message!.id)).toBe(true);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages[0]?.delivery).toBe(
            'priority'
        );
        expect(latestOptions().queue.claimPriority()).toEqual([
            expect.objectContaining({ id: message!.id, delivery: 'priority' }),
        ]);
        expect(center.promoteTaskUserMessage(started.taskId, message!.id)).toBe(false);
    });

    it('user cannot promote a queued message until its edit finishes', async () => {
        executionState.run.mockImplementation(staysRunningInSession(23));
        const center = createCenter();
        try {
            const started = await center.startTask({ prompt: 'first', sessionId: 23 });
            const message = center.enqueueTaskUserMessage(
                started.taskId,
                { prompt: 'editing' },
                'queue'
            )!;
            expect(center.setTaskUserMessageEditing(started.taskId, message.id, true)).toBe(true);

            expect(center.promoteTaskUserMessage(started.taskId, message.id)).toBe(false);
            expect(center.promoteSessionUserMessage(23, message.id)).toBe(false);
            expect(latestOptions().queue.hasImmediate()).toBe(false);
            expect(latestOptions().queue.claimPriority()).toEqual([]);
            expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([
                expect.objectContaining({ id: message.id, delivery: 'queue', editing: true }),
            ]);

            expect(center.setTaskUserMessageEditing(started.taskId, message.id, false)).toBe(true);
            expect(center.promoteTaskUserMessage(started.taskId, message.id)).toBe(true);
            expect(latestOptions().queue.claimPriority()).toEqual([
                expect.objectContaining({ id: message.id, delivery: 'priority' }),
            ]);
        } finally {
            center.dispose();
        }
    });

    it('user does not deliver an inherited priority message while its edit is parked', async () => {
        executionState.run.mockImplementation(staysRunningInSession(23));
        const center = createCenter();
        try {
            const message: PendingUserMessage = {
                id: 'parked-priority',
                prompt: 'editing',
                attachments: [],
                delivery: 'priority',
                immediate: true,
                editing: true,
                createdAt: 1,
            };
            const started = await center.startTask({
                prompt: 'first',
                sessionId: 23,
                pendingUserMessages: [message],
            });

            expect(latestOptions().queue.hasImmediate()).toBe(false);
            expect(latestOptions().queue.claimPriority()).toEqual([]);
            expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([message]);
        } finally {
            center.dispose();
        }
    });

    it('user gets their message flagged for immediate delivery when they click steer now', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Send me now' },
            'queue'
        );

        expect(center.promoteTaskUserMessage(started.taskId, message!.id)).toBe(true);

        // The executor needs this flag to cut the running answer instead of
        // waiting for the next tool call.
        expect(latestOptions().queue.hasImmediate()).toBe(true);
    });

    it('user does not interrupt the answer for a message that only waits for a tool call', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        center.enqueueTaskUserMessage(started.taskId, { prompt: 'Insert me' }, 'priority');

        expect(latestOptions().queue.hasImmediate()).toBe(false);
    });

    it('user gets a queued message turned solid immediately when they click steer now', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Insert me' },
            'queue'
        );
        const seen: string[] = [];
        center.subscribeTask(started.taskId, (snapshot) => {
            seen.push(snapshot.pendingUserMessages[0]?.delivery ?? 'none');
        });

        expect(center.promoteTaskUserMessage(started.taskId, message!.id)).toBe(true);

        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages[0]).toMatchObject({
            id: message!.id,
            delivery: 'priority',
        });
        // The subscriber must be told, otherwise the bubble stays dashed until
        // some unrelated snapshot happens to publish.
        await vi.waitFor(() => expect(seen[seen.length - 1]).toBe('priority'));
    });

    it('user gets pending messages removed or cleared from the task', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const first = center.enqueueTaskUserMessage(started.taskId, { prompt: 'one' }, 'queue');
        const second = center.enqueueTaskUserMessage(started.taskId, { prompt: 'two' }, 'queue');

        expect(center.removeTaskUserMessage(started.taskId, first!.id)).toBe(true);
        expect(center.removeTaskUserMessage(started.taskId, first!.id)).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([second]);
        expect(pendingMessageStore.remove).toHaveBeenCalledWith(1, first!.id);

        expect(center.clearTaskUserMessages(started.taskId)).toBe(true);
        expect(center.clearTaskUserMessages(started.taskId)).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([]);
    });

    it('user gets an edited queue updated in place without changing its slot', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const first = center.enqueueTaskUserMessage(started.taskId, { prompt: 'first' }, 'queue');
        const second = center.enqueueTaskUserMessage(started.taskId, { prompt: 'second' }, 'queue');

        expect(
            center.updateTaskUserMessage(started.taskId, first!.id, {
                prompt: 'first edited',
                attachments: [],
                inputSnapshot: {
                    text: 'first edited',
                    attachments: [],
                    skills: [],
                },
            })
        ).toBe(true);

        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([
            expect.objectContaining({
                id: first!.id,
                prompt: 'first edited',
                delivery: 'queue',
                createdAt: first!.createdAt,
            }),
            second,
        ]);
        expect(pendingMessageStore.remove).not.toHaveBeenCalledWith(1, first!.id);
        expect(pendingMessageStore.update).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ id: first!.id, prompt: 'first edited' })
        );
    });

    it('user cannot rewrite a queue after it has been promoted to a steer', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'send now' },
            'queue'
        );

        expect(center.promoteTaskUserMessage(started.taskId, message!.id)).toBe(true);
        expect(
            center.updateTaskUserMessage(started.taskId, message!.id, {
                prompt: 'too late',
            })
        ).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages[0]?.prompt).toBe(
            'send now'
        );
    });

    it('user gets queued messages reordered without moving a committed steer', async () => {
        executionState.run.mockImplementation(staysRunningInSession(10));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 10 });
        const steered = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'insert' },
            'priority'
        );
        const first = center.enqueueTaskUserMessage(started.taskId, { prompt: 'first' }, 'queue');
        const second = center.enqueueTaskUserMessage(started.taskId, { prompt: 'second' }, 'queue');
        const third = center.enqueueTaskUserMessage(started.taskId, { prompt: 'third' }, 'queue');

        expect(
            center.reorderTaskQueuedMessages(started.taskId, [third!.id, first!.id, second!.id])
        ).toBe(true);

        const snapshot = center.getTaskSnapshot(started.taskId);
        expect(snapshot?.pendingUserMessages.map((message) => message.prompt)).toEqual([
            'insert',
            'third',
            'first',
            'second',
        ]);
        expect(latestOptions().queue.claimPriority()).toEqual([steered]);

        expect(center.reorderTaskQueuedMessages(started.taskId, [steered!.id])).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual(
            snapshot?.pendingUserMessages
        );
    });
});

describe('user waits for a queued message to become the next turn', () => {
    it('user gets the reordered queue started first on the next turn', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(11))
            .mockImplementation(staysRunningInSession(11));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 11 });
        const queuedFirst = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'queued first' },
            'queue'
        );
        const queuedSecond = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'queued second' },
            'queue'
        );
        const queuedThird = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'queued third' },
            'queue'
        );

        expect(
            center.reorderTaskQueuedMessages(first.taskId, [
                queuedThird!.id,
                queuedFirst!.id,
                queuedSecond!.id,
            ])
        ).toBe(true);

        finishCurrentTask!();
        await first.completion;

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(11);
        const nextSnapshot = center.getTaskSnapshot(next!.taskId);
        expect(nextSnapshot?.sessionHistory[0]).toMatchObject({
            id: queuedThird!.id,
            content: 'queued third',
        });
        expect(nextSnapshot?.pendingUserMessages.map((message) => message.prompt)).toEqual([
            'queued first',
            'queued second',
        ]);
    });

    it('user gets the next queued message started after the run completes', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(3))
            .mockImplementation(staysRunningInSession(3));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 3 });
        const queued = center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');
        const alsoQueued = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'third' },
            'queue'
        );

        finishCurrentTask!();
        await first.completion;

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(3);
        expect(next?.status).toBe('running');
        const nextSnapshot = center.getTaskSnapshot(next!.taskId);
        // The same id keeps the dashed bubble turning into the solid one in place.
        expect(nextSnapshot?.sessionHistory[0]).toMatchObject({
            id: queued!.id,
            content: 'second',
        });
        expect(nextSnapshot?.pendingUserMessages.map((message) => message.id)).toEqual([
            alsoQueued!.id,
        ]);
        expect(center.getTaskSnapshot(first.taskId)?.pendingUserMessages).toEqual([]);
    });

    it('user gets a priority message that missed the tool boundary queued for the next turn', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(4))
            .mockImplementation(staysRunningInSession(4));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 4 });
        const inserted = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'insert' },
            'priority'
        );

        finishCurrentTask!();
        await first.completion;

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(4);
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: inserted!.id,
            content: 'insert',
        });
    });

    it('user gets an undelivered steer before earlier queues when the run ends', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(19))
            .mockImplementation(staysRunningInSession(19));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 19 });
        const queuedFirst = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'queued first' },
            'queue'
        );
        const queuedSecond = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'queued second' },
            'queue'
        );
        const steered = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'steer last' },
            'priority'
        );

        finishCurrentTask!();
        await first.completion;

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(19);
        const nextSnapshot = center.getTaskSnapshot(next!.taskId);
        expect(nextSnapshot?.sessionHistory[0]).toMatchObject({
            id: steered!.id,
            content: 'steer last',
        });
        expect(nextSnapshot?.pendingUserMessages.map((message) => message.id)).toEqual([
            queuedFirst!.id,
            queuedSecond!.id,
        ]);
        center.cancelTask(next!.taskId, { preservePending: false });
    });

    it('user gets a queued message skipped while it is being edited', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(13))
            .mockImplementation(staysRunningInSession(13));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 13 });
        const editing = center.enqueueTaskUserMessage(first.taskId, { prompt: 'editing' }, 'queue');
        const nextQueued = center.enqueueTaskUserMessage(first.taskId, { prompt: 'next' }, 'queue');

        expect(center.setTaskUserMessageEditing(first.taskId, editing!.id, true)).toBe(true);
        finishCurrentTask!();
        await first.completion;

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(13);
        const nextSnapshot = center.getTaskSnapshot(next!.taskId);
        expect(nextSnapshot?.sessionHistory[0]).toMatchObject({
            id: nextQueued!.id,
            content: 'next',
        });
        expect(nextSnapshot?.pendingUserMessages).toEqual([
            expect.objectContaining({
                id: editing!.id,
                prompt: 'editing',
                editing: true,
            }),
        ]);
        center.cancelTask(next!.taskId, { preservePending: false });
    });

    it('user gets an edited queued message started after the previous run ends', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(15))
            .mockImplementation(staysRunningInSession(15));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 15 });
        const editing = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'editing' },
            'queue'
        )!;

        expect(center.setTaskUserMessageEditing(first.taskId, editing.id, true)).toBe(true);
        finishCurrentTask!();
        await first.completion;

        expect(center.getTaskSnapshot(first.taskId)?.status).toBe('completed');
        expect(
            center.updateTaskUserMessage(first.taskId, editing.id, {
                prompt: 'edited after completion',
            })
        ).toBe(true);
        expect(center.clearUserMessageEditing(editing.id)).toBe(true);

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(15);
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: editing.id,
            content: 'edited after completion',
        });
        center.cancelTask(next!.taskId, { preservePending: false });
    });

    it('user gets a new queue started while an earlier message remains in edit', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(17))
            .mockImplementation(staysRunningInSession(17));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 17 });
        const editing = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'editing' },
            'queue'
        )!;
        expect(center.setTaskUserMessageEditing(first.taskId, editing.id, true)).toBe(true);

        finishCurrentTask!();
        await first.completion;
        expect(executionState.instances).toHaveLength(1);

        const late = center.enqueueSessionUserMessage(17, { prompt: 'late' }, 'queue');
        expect(late).toMatchObject({ prompt: 'late', delivery: 'queue' });

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(17);
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: late!.id,
            content: 'late',
        });
        expect(center.getTaskSnapshot(next!.taskId)?.pendingUserMessages).toEqual([
            expect.objectContaining({
                id: editing.id,
                prompt: 'editing',
                editing: true,
            }),
        ]);
        center.cancelTask(next!.taskId, { preservePending: false });
    });

    it('user gets a steer added in the hand-off window started before an edited queue', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(20))
            .mockImplementation(staysRunningInSession(20));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 20 });
        const editing = center.enqueueTaskUserMessage(
            first.taskId,
            { prompt: 'editing' },
            'queue'
        )!;
        expect(center.setTaskUserMessageEditing(first.taskId, editing.id, true)).toBe(true);

        finishCurrentTask!();
        await first.completion;
        expect(executionState.instances).toHaveLength(1);

        const steered = center.enqueueSessionUserMessage(
            20,
            { prompt: 'steer in hand-off' },
            'priority'
        );
        expect(steered).toMatchObject({ prompt: 'steer in hand-off', delivery: 'priority' });

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(20);
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: steered!.id,
            content: 'steer in hand-off',
        });
        expect(center.getTaskSnapshot(next!.taskId)?.pendingUserMessages).toEqual([
            expect.objectContaining({
                id: editing.id,
                prompt: 'editing',
                editing: true,
            }),
        ]);
        center.cancelTask(next!.taskId, { preservePending: false });
    });

    it('user gets an edited queue started after the finished task is released', async () => {
        vi.useFakeTimers();
        let center!: ReturnType<typeof createCenter>;
        let editing!: PendingUserMessage;
        try {
            executionState.run
                .mockImplementationOnce(finishableRun(18))
                .mockImplementation(staysRunningInSession(18));
            center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 18 });
            editing = center.enqueueTaskUserMessage(first.taskId, { prompt: 'editing' }, 'queue')!;
            expect(center.setTaskUserMessageEditing(first.taskId, editing.id, true)).toBe(true);

            finishCurrentTask!();
            await first.completion;
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
            expect(center.getTaskSnapshot(first.taskId)).toBeNull();
        } finally {
            vi.useRealTimers();
        }

        expect(center.setSessionUserMessageEditing(18, editing.id, false)).toBe(true);
        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(18);
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: editing.id,
            content: 'editing',
        });
        center.cancelTask(next!.taskId, { preservePending: false });
    });
});

describe('user cancels a run with pending messages', () => {
    it('user reorders messages while cancellation settles and the next turn follows the new order', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        try {
            const started = await center.startTask({ prompt: 'Active', sessionId: 1 });
            const first = center.enqueueTaskUserMessage(
                started.taskId,
                { prompt: 'First' },
                'queue'
            )!;
            const second = center.enqueueTaskUserMessage(
                started.taskId,
                { prompt: 'Second' },
                'queue'
            )!;

            center.cancelTask(started.taskId);
            expect(center.reorderTaskQueuedMessages(started.taskId, [second.id, first.id])).toBe(
                true
            );
            expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([
                second,
                first,
            ]);
            latestOptions().emit({
                type: 'task_cancelled',
                taskId: started.taskId,
                turnId: 1,
            });

            await vi.waitFor(() => expect(latestOptions().prompt).toBe('Second'));
            const next = center.getSessionStatus(1)!;
            expect(center.getTaskSnapshot(next.taskId)?.pendingUserMessages).toEqual([first]);
        } finally {
            center.dispose();
        }
    });

    it('user clicks send now after a failed run and the selected message starts ahead of the queue', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        try {
            const started = await center.startTask({ prompt: 'Active', sessionId: 1 });
            const first = center.enqueueTaskUserMessage(
                started.taskId,
                { prompt: 'First' },
                'queue'
            )!;
            const selected = center.enqueueTaskUserMessage(
                started.taskId,
                { prompt: 'Send now' },
                'queue'
            )!;
            latestOptions().emit({
                type: 'task_failed',
                taskId: started.taskId,
                turnId: 1,
                error: 'Connection failed',
            });
            expect(center.getSessionStatus(1)).toBeNull();
            await started.completion.catch(() => {});

            expect(center.promoteSessionUserMessage(1, selected.id)).toBe(true);

            await vi.waitFor(() => expect(latestOptions().prompt).toBe('Send now'));
            const next = center.getSessionStatus(1)!;
            expect(next.status).toBe('running');
            expect(center.getTaskSnapshot(next.taskId)?.pendingUserMessages).toEqual([first]);
        } finally {
            center.dispose();
        }
    });

    it('user keeps the queued messages when the run fails', async () => {
        let failCurrentTask!: () => void;
        executionState.run.mockImplementationOnce(
            () =>
                new Promise<TaskResult>((_resolve, reject) => {
                    const options = latestOptions();
                    options.emit({ type: 'task_started', sessionId: 21, turnId: 1 });
                    failCurrentTask = () => reject(new Error('provider failed'));
                })
        );
        const center = createCenter();
        const started = await center.startTask({ prompt: 'first', sessionId: 21 });
        const queued = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'keep me' },
            'queue'
        );

        failCurrentTask();
        await started.completion.catch(() => {});

        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([queued]);
        expect(pendingMessageStore.reorder).toHaveBeenCalledWith(21, [queued!.id]);
    });

    it('user changes models after a failed run and sends the retained queue with the new selection', async () => {
        executionState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        try {
            const started = await center.startTask({ prompt: 'Active', sessionId: 1 });
            const first = center.enqueueTaskUserMessage(
                started.taskId,
                { prompt: 'First', modelId: 'old-model', providerId: 1 },
                'queue'
            )!;
            const second = center.enqueueTaskUserMessage(
                started.taskId,
                { prompt: 'Second', modelId: 'old-model', providerId: 1 },
                'queue'
            )!;
            latestOptions().emit({
                type: 'task_failed',
                taskId: started.taskId,
                turnId: 1,
                error: 'Connection failed',
            });

            await started.completion.catch(() => {});
            expect(center.updateTaskUserMessageModel(started.taskId, 'new-model', 2)).toBe(true);
            expect(center.promoteSessionUserMessage(1, first.id)).toBe(true);

            await vi.waitFor(() => expect(latestOptions().prompt).toBe('First'));
            expect(latestOptions()).toMatchObject({ modelId: 'new-model', providerId: 2 });
            const next = center.getSessionStatus(1)!;
            expect(center.getTaskSnapshot(next.taskId)?.pendingUserMessages).toEqual([
                expect.objectContaining({
                    id: second.id,
                    modelId: 'new-model',
                    providerId: 2,
                }),
            ]);
        } finally {
            center.dispose();
        }
    });

    it('user keeps the queued messages and the next one starts after cancellation', async () => {
        executionState.run
            .mockImplementationOnce(() => {
                const options = latestOptions();
                options.emit({ type: 'task_started', sessionId: 5, turnId: 1 });
                return new Promise<TaskResult>((_resolve, reject) => {
                    options.signal?.addEventListener('abort', () => {
                        options.emit({
                            type: 'task_cancelled',
                            taskId: 'task',
                            turnId: 1,
                        });
                        reject(new Error('cancelled'));
                    });
                });
            })
            .mockImplementation(staysRunningInSession(5));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'first', sessionId: 5 });
        const queued = center.enqueueTaskUserMessage(started.taskId, { prompt: 'queued' }, 'queue');

        center.cancelTask(started.taskId);
        await started.completion.catch(() => {});

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(5);
        expect(next).not.toBeNull();
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: queued!.id,
            content: 'queued',
        });
        center.cancelTask(next!.taskId, { preservePending: false });
    });

    it('user keeps the queue when the runtime rejects cancellation without a terminal event', async () => {
        executionState.run
            .mockImplementationOnce(() => {
                const options = latestOptions();
                options.emit({ type: 'task_started', sessionId: 16, turnId: 1 });
                return new Promise<TaskResult>((_resolve, reject) => {
                    options.signal?.addEventListener('abort', () => {
                        reject(new AgentError('REQUEST_CANCELLED'));
                    });
                });
            })
            .mockImplementation(staysRunningInSession(16));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'first', sessionId: 16 });
        const queued = center.enqueueTaskUserMessage(started.taskId, { prompt: 'queued' }, 'queue');

        center.cancelTask(started.taskId);
        await started.completion.catch(() => {});

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
        const next = center.getSessionStatus(16);
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: queued!.id,
            content: 'queued',
        });
        center.cancelTask(next!.taskId, { preservePending: false });
    });
});

describe('user returns to a session with a durable queue', () => {
    it('user reopens an empty retired session then its durable queue is read again', async () => {
        vi.useFakeTimers();
        try {
            executionState.run.mockImplementationOnce(finishableRun(22));
            const center = createCenter();
            const started = await center.startTask({ prompt: 'First', sessionId: 22 });
            finishCurrentTask!();
            await started.completion;
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
            const restored: PendingUserMessage = {
                id: 'external',
                prompt: 'Restored',
                delivery: 'queue',
                attachments: [],
                createdAt: 1,
            };
            vi.mocked(pendingMessageStore.load).mockResolvedValueOnce([restored]);
            await expect(center.restoreSessionQueue(22)).resolves.toEqual([restored]);
            expect(pendingMessageStore.load).toHaveBeenCalledWith(22);
        } finally {
            vi.useRealTimers();
        }
    });

    it('user closes the owner during queue loading then the late load cannot restore or resume work', async () => {
        let resolveLoad!: (messages: PendingUserMessage[]) => void;
        vi.mocked(pendingMessageStore.load).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveLoad = resolve;
                })
        );
        const center = createCenter();
        const loading = center.restoreSessionQueue(22);
        await center.dispose();
        resolveLoad([
            { id: 'late', prompt: 'Late', delivery: 'queue', attachments: [], createdAt: 1 },
        ]);
        await expect(loading).resolves.toEqual([]);
        center.resumeSessionQueue(22);
        await Promise.resolve();
        expect(executionState.instances).toEqual([]);
        expect(
            center.enqueueSessionUserMessage(22, { prompt: 'Late follow up' }, 'queue')
        ).toBeNull();
    });
    it('user gets the stored pending messages restored before the session opens', async () => {
        const restored = {
            id: 'restored-1',
            prompt: 'restored prompt',
            delivery: 'queue' as const,
            attachments: [],
            createdAt: 1,
        };
        vi.mocked(pendingMessageStore.load).mockResolvedValueOnce([restored]);
        const center = createCenter();

        await expect(center.restoreSessionQueue(22)).resolves.toEqual([restored]);
        expect(pendingMessageStore.load).toHaveBeenCalledWith(22);
    });

    it('user gets an in-memory queue instead of reloading it again', async () => {
        const restored = {
            id: 'restored-1',
            prompt: 'restored prompt',
            delivery: 'queue' as const,
            attachments: [],
            createdAt: 1,
        };
        vi.mocked(pendingMessageStore.load).mockResolvedValueOnce([restored]);
        const center = createCenter();

        await center.restoreSessionQueue(22);
        await expect(center.restoreSessionQueue(22)).resolves.toEqual([restored]);
        expect(pendingMessageStore.load).toHaveBeenCalledTimes(1);
    });

    it('user gets the active task queue without touching storage', async () => {
        executionState.run.mockImplementation(staysRunningInSession(22));
        const center = createCenter();
        await center.startTask({ prompt: 'running', sessionId: 22 });

        await expect(center.restoreSessionQueue(22)).resolves.toEqual([]);
        expect(pendingMessageStore.load).not.toHaveBeenCalled();
    });

    it('user gets an empty queue when storage cannot be read', async () => {
        vi.mocked(pendingMessageStore.load).mockRejectedValueOnce(new Error('database busy'));
        const center = createCenter();

        await expect(center.restoreSessionQueue(22)).resolves.toEqual([]);
    });

    it('user gets no new task when there is nothing to resume', () => {
        const center = createCenter();

        center.resumeSessionQueue(22);

        expect(executionState.instances).toHaveLength(0);
    });

    it('user gets the restored head started when the session opens', async () => {
        const restored = {
            id: 'restored-1',
            prompt: 'resume me',
            delivery: 'queue' as const,
            attachments: [],
            createdAt: 1,
        };
        vi.mocked(pendingMessageStore.load).mockResolvedValueOnce([restored]);
        executionState.run.mockImplementation(staysRunningInSession(22));
        const center = createCenter();

        await center.restoreSessionQueue(22);
        center.resumeSessionQueue(22);

        await vi.waitFor(() => expect(executionState.instances).toHaveLength(1));
        expect(center.getSessionStatus(22)?.status).toBe('running');
        center.dispose();
    });

    it('user gets a restored queue removed one item at a time and then cleared', async () => {
        const first = {
            id: 'restored-1',
            prompt: 'first',
            delivery: 'queue' as const,
            attachments: [],
            createdAt: 1,
        };
        const second = {
            id: 'restored-2',
            prompt: 'second',
            delivery: 'queue' as const,
            attachments: [],
            createdAt: 2,
        };
        vi.mocked(pendingMessageStore.load).mockResolvedValueOnce([first, second]);
        const center = createCenter();

        await center.restoreSessionQueue(22);

        expect(center.removeSessionUserMessage(22, first.id)).toBe(true);
        expect(pendingMessageStore.remove).toHaveBeenCalledWith(22, first.id);
        expect(center.clearSessionUserMessages(22)).toBe(true);
        expect(pendingMessageStore.clear).toHaveBeenCalledWith(22);
    });
});

describe('user submits while a finished run hands over to its queue', () => {
    it('user queues during startup when history loading fails then the next task retains that input', async () => {
        let rejectHistory!: (error: Error) => void;
        historyState.loadSessionHistory.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectHistory = reject;
                })
        );
        const center = createCenter();
        const starting = center.startTask({ prompt: 'First', sessionId: 12 });
        await vi.waitFor(() => expect(rejectHistory).toBeTypeOf('function'));
        const pending = center.enqueueSessionUserMessage(12, { prompt: 'Follow up' }, 'queue');
        expect(pending).not.toBeNull();
        rejectHistory(new Error('database is locked'));
        await expect(starting).rejects.toThrow();
        executionState.run.mockImplementation(staysRunningInSession(12));
        const next = await center.startTask({ prompt: 'Next', sessionId: 12 });
        expect(center.getTaskSnapshot(next.taskId)?.pendingUserMessages).toEqual([pending]);
    });

    it('user clears a queue during history preparation then the reserved input never starts or returns', async () => {
        executionState.run.mockImplementationOnce(finishableRun(12));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'First', sessionId: 12 });
        center.enqueueTaskUserMessage(first.taskId, { prompt: 'Pending' }, 'queue');
        let releaseHistory!: (value: never[]) => void;
        historyState.loadSessionHistory.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseHistory = resolve;
                })
        );
        finishCurrentTask!();
        await first.completion;
        await vi.waitFor(() => expect(releaseHistory).toBeTypeOf('function'));
        expect(center.clearTaskUserMessages(first.taskId)).toBe(true);
        releaseHistory([]);
        await vi.waitFor(() => expect(center.getSessionStatus(12)).toBeNull());
        await expect(center.restoreSessionQueue(12)).resolves.toEqual([]);
        expect(executionState.instances).toHaveLength(1);
    });
    it('user changes models during handover and the current owner updates the remaining queue', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(23))
            .mockImplementationOnce(finishableRun(23))
            .mockImplementation(staysRunningInSession(23));
        const center = createCenter();
        let releaseHistory!: (history: never[]) => void;
        try {
            const first = await center.startTask({ prompt: 'First', sessionId: 23 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'Second' }, 'queue');
            const remaining = center.enqueueTaskUserMessage(
                first.taskId,
                { prompt: 'Third', modelId: 'old-model', providerId: 1 },
                'queue'
            )!;
            historyState.loadSessionHistory.mockImplementationOnce(
                () =>
                    new Promise<never[]>((resolve) => {
                        releaseHistory = resolve;
                    })
            );
            finishCurrentTask!();
            await first.completion;
            await vi.waitFor(() => expect(releaseHistory).toBeTypeOf('function'));

            expect(center.updateTaskUserMessageModel(first.taskId, 'new-model', 2)).toBe(true);

            releaseHistory([]);
            await vi.waitFor(() => expect(latestOptions().prompt).toBe('Second'));
            finishCurrentTask!();
            await vi.waitFor(() => expect(latestOptions().prompt).toBe('Third'));
            expect(latestOptions()).toMatchObject({
                pendingMessageId: remaining.id,
                modelId: 'new-model',
                providerId: 2,
            });
        } finally {
            releaseHistory?.([]);
            center.dispose();
        }
    });

    it('user saves an edit during history loading and the new owner sends the saved text', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(23))
            .mockImplementationOnce(finishableRun(23))
            .mockImplementation(staysRunningInSession(23));
        const center = createCenter();
        let releaseHistory!: (history: never[]) => void;
        try {
            const first = await center.startTask({ prompt: 'first', sessionId: 23 });
            const editing = center.enqueueTaskUserMessage(
                first.taskId,
                { prompt: 'original edit' },
                'queue'
            )!;
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'next turn' }, 'queue');
            expect(center.setTaskUserMessageEditing(first.taskId, editing.id, true)).toBe(true);
            historyState.loadSessionHistory.mockImplementationOnce(
                () =>
                    new Promise<never[]>((resolve) => {
                        releaseHistory = resolve;
                    })
            );

            finishCurrentTask!();
            await first.completion;
            await vi.waitFor(() => expect(releaseHistory).toBeTypeOf('function'));
            expect(center.getSessionStatus(23)).toBeNull();
            const newTaskId = first.taskId;

            expect(
                center.updateTaskUserMessage(first.taskId, editing.id, { prompt: 'saved edit' })
            ).toBe(true);
            expect(center.setTaskUserMessageEditing(first.taskId, editing.id, false)).toBe(true);
            expect(center.getTaskSnapshot(newTaskId)?.pendingUserMessages).toEqual([
                expect.objectContaining({
                    id: editing.id,
                    prompt: 'saved edit',
                    editing: undefined,
                }),
            ]);

            releaseHistory([]);
            await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
            finishCurrentTask!();
            await vi.waitFor(() => expect(executionState.instances).toHaveLength(3));
            const finalTaskId = center.getSessionStatus(23)!.taskId;
            expect(center.getTaskSnapshot(finalTaskId)?.sessionHistory[0]).toMatchObject({
                id: editing.id,
                content: 'saved edit',
            });
        } finally {
            releaseHistory?.([]);
            center.dispose();
        }
    });

    it('user keeps handover edits and removals when loading the next turn fails', async () => {
        executionState.run.mockImplementationOnce(finishableRun(24));
        const center = createCenter();
        let rejectHistory!: (error: Error) => void;
        try {
            const first = await center.startTask({ prompt: 'first', sessionId: 24 });
            const selected = center.enqueueTaskUserMessage(
                first.taskId,
                { prompt: 'next' },
                'queue'
            )!;
            const editing = center.enqueueTaskUserMessage(
                first.taskId,
                { prompt: 'original' },
                'queue'
            )!;
            const removed = center.enqueueTaskUserMessage(
                first.taskId,
                { prompt: 'remove me' },
                'queue'
            )!;
            expect(center.setTaskUserMessageEditing(first.taskId, editing.id, true)).toBe(true);
            historyState.loadSessionHistory.mockImplementationOnce(
                () =>
                    new Promise<never[]>((_resolve, reject) => {
                        rejectHistory = reject;
                    })
            );

            finishCurrentTask!();
            await first.completion;
            await vi.waitFor(() => expect(rejectHistory).toBeTypeOf('function'));
            expect(
                center.updateTaskUserMessage(first.taskId, editing.id, { prompt: 'saved' })
            ).toBe(true);
            expect(center.setTaskUserMessageEditing(first.taskId, editing.id, false)).toBe(true);
            expect(center.removeSessionUserMessage(24, removed.id)).toBe(true);
            const late = center.enqueueSessionUserMessage(24, { prompt: 'late' }, 'queue')!;

            rejectHistory(new Error('history unavailable'));
            await vi.waitFor(() => expect(center.getSessionStatus(24)).toBeNull());
            const expected = [
                expect.objectContaining({ id: selected.id, prompt: 'next' }),
                expect.objectContaining({ id: editing.id, prompt: 'saved', editing: undefined }),
                expect.objectContaining({ id: late.id, prompt: 'late' }),
            ];
            await vi.waitFor(async () =>
                expect(await center.restoreSessionQueue(24)).toEqual(expected)
            );
            expect(center.getTaskSnapshot(first.taskId)?.pendingUserMessages).toEqual(expected);
        } finally {
            center.dispose();
        }
    });

    it('user gets the message queued instead of racing a second task for the session', async () => {
        let releaseStartup!: () => void;
        try {
            executionState.run
                .mockImplementationOnce(finishableRun(6))
                .mockImplementation(staysRunningInSession(6));
            const center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 6 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'third' }, 'queue');

            // The hand-over task is starting but has not attached yet: the user submits here.
            registerStartupCapability(
                'model-metadata',
                new Promise<void>((resolve) => {
                    releaseStartup = resolve;
                })
            );
            finishCurrentTask!();
            await first.completion;
            await Promise.resolve();
            await Promise.resolve();

            expect(center.getSessionStatus(6)).toBeNull();
            const late = center.enqueueSessionUserMessage(6, { prompt: 'late' }, 'queue');
            expect(late).toMatchObject({ prompt: 'late', delivery: 'queue' });

            releaseStartup();
            await vi.waitFor(() => expect(center.getSessionStatus(6)?.status).toBe('running'));
            const nextId = center.getSessionStatus(6)!.taskId;
            expect(
                center.getTaskSnapshot(nextId)?.pendingUserMessages.map((entry) => entry.prompt)
            ).toEqual(['third', 'late']);
        } finally {
            releaseStartup?.();
            resetStartupCapabilities();
        }
    });

    it('user gets handover queues reordered before the next task attaches', async () => {
        let releaseStartup!: () => void;
        try {
            executionState.run
                .mockImplementationOnce(finishableRun(12))
                .mockImplementation(staysRunningInSession(12));
            const center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 12 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');
            const third = center.enqueueTaskUserMessage(first.taskId, { prompt: 'third' }, 'queue');

            registerStartupCapability(
                'model-metadata',
                new Promise<void>((resolve) => {
                    releaseStartup = resolve;
                })
            );
            finishCurrentTask!();
            await first.completion;
            await Promise.resolve();
            await Promise.resolve();

            expect(center.getSessionStatus(12)).toBeNull();
            const late = center.enqueueSessionUserMessage(12, { prompt: 'late' }, 'queue');
            expect(late).not.toBeNull();
            expect(center.reorderSessionQueuedMessages(12, [late!.id, third!.id])).toBe(true);

            releaseStartup();
            await vi.waitFor(() => expect(center.getSessionStatus(12)?.status).toBe('running'));
            const nextId = center.getSessionStatus(12)!.taskId;
            expect(
                center.getTaskSnapshot(nextId)?.pendingUserMessages.map((entry) => entry.prompt)
            ).toEqual(['late', 'third']);
        } finally {
            releaseStartup?.();
            resetStartupCapabilities();
        }
    });

    it('user gets a handover queue edited in place before the next task attaches', async () => {
        let releaseStartup!: () => void;
        try {
            executionState.run
                .mockImplementationOnce(finishableRun(13))
                .mockImplementation(staysRunningInSession(13));
            const center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 13 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');

            registerStartupCapability(
                'model-metadata',
                new Promise<void>((resolve) => {
                    releaseStartup = resolve;
                })
            );
            finishCurrentTask!();
            await first.completion;
            await Promise.resolve();
            await Promise.resolve();

            expect(center.getSessionStatus(13)).toBeNull();
            const late = center.enqueueSessionUserMessage(13, { prompt: 'late' }, 'queue');
            expect(late).not.toBeNull();
            expect(center.updateSessionUserMessage(13, late!.id, { prompt: 'late edited' })).toBe(
                true
            );

            releaseStartup();
            await vi.waitFor(() => expect(center.getSessionStatus(13)?.status).toBe('running'));
            const nextId = center.getSessionStatus(13)!.taskId;
            expect(
                center.getTaskSnapshot(nextId)?.pendingUserMessages.map((entry) => ({
                    id: entry.id,
                    prompt: entry.prompt,
                }))
            ).toEqual([{ id: late!.id, prompt: 'late edited' }]);
        } finally {
            releaseStartup?.();
            resetStartupCapabilities();
        }
    });

    it('user gets a failed handover run contained instead of an unhandled rejection', async () => {
        executionState.run
            .mockImplementationOnce(finishableRun(14))
            .mockRejectedValueOnce(new Error('handover failed'));
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        const center = createCenter();
        try {
            const first = await center.startTask({ prompt: 'first', sessionId: 14 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');
            finishCurrentTask!();
            await first.completion;
            await vi.waitFor(() => expect(executionState.instances).toHaveLength(2));
            await vi.waitFor(() => expect(center.getSessionStatus(14)).toBeNull());
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
            await center.dispose();
        }
    });

    it('user gets no phantom queue write when the session has nothing waiting', () => {
        const center = createCenter();

        // Without a hand-over there is no task to consume the message; accepting it here
        // would silently swallow the user's prompt.
        expect(center.enqueueSessionUserMessage(8, { prompt: 'orphan' }, 'queue')).toBeNull();
    });
});

describe('user manages a queue attached to a run that has ended', () => {
    it('user gets queue edits refused once the run can no longer deliver them', async () => {
        executionState.run.mockImplementationOnce(finishableRun(null));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'first' });
        const queued = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'waiting' },
            'queue'
        );

        finishCurrentTask!();
        await started.completion;
        await Promise.resolve();

        expect(center.getTaskSnapshot(started.taskId)?.status).toBe('completed');
        expect(
            center.enqueueTaskUserMessage(started.taskId, { prompt: 'too late' }, 'queue')
        ).toBeNull();
        expect(center.updateTaskUserMessage(started.taskId, queued!.id, { prompt: 'edited' })).toBe(
            false
        );
        expect(center.removeTaskUserMessage(started.taskId, queued!.id)).toBe(false);
        expect(center.promoteTaskUserMessage(started.taskId, queued!.id)).toBe(false);
        expect(center.reorderTaskQueuedMessages(started.taskId, [queued!.id])).toBe(false);

        // Model switches are safe to keep up to date while the final snapshot is still
        // visible; the message itself is not editable but will start the next turn.
        expect(center.updateTaskUserMessageModel(started.taskId, 'model-2', 2)).toBe(true);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages[0]).toMatchObject({
            id: queued!.id,
            modelId: 'model-2',
            providerId: 2,
        });

        center.dispose();
    });

    it('user gets session queue edits and ordering kept until the next task attaches', async () => {
        let releaseStartup!: () => void;
        try {
            executionState.run
                .mockImplementationOnce(finishableRun(14))
                .mockImplementation(staysRunningInSession(14));
            const center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 14 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');

            registerStartupCapability(
                'model-metadata',
                new Promise<void>((resolve) => {
                    releaseStartup = resolve;
                })
            );
            finishCurrentTask!();
            await first.completion;
            await Promise.resolve();
            await Promise.resolve();

            const lateOne = center.enqueueSessionUserMessage(14, { prompt: 'late one' }, 'queue');
            const lateTwo = center.enqueueSessionUserMessage(14, { prompt: 'late two' }, 'queue');
            expect(lateOne).not.toBeNull();
            expect(lateTwo).not.toBeNull();

            expect(center.updateSessionUserMessage(14, 'missing', { prompt: 'nope' })).toBe(false);
            expect(
                center.updateSessionUserMessage(14, lateOne!.id, { prompt: 'late one edited' })
            ).toBe(true);
            expect(center.removeSessionUserMessage(14, 'missing')).toBe(false);
            expect(center.removeSessionUserMessage(14, lateOne!.id)).toBe(true);
            expect(center.promoteSessionUserMessage(14, lateTwo!.id)).toBe(true);
            expect(center.promoteSessionUserMessage(14, lateTwo!.id)).toBe(false);
            expect(center.reorderSessionQueuedMessages(14, [lateTwo!.id])).toBe(false);
            expect(center.reorderSessionQueuedMessages(999, [lateTwo!.id])).toBe(false);

            const lateThree = center.enqueueSessionUserMessage(
                14,
                { prompt: 'late three' },
                'queue'
            );
            expect(center.reorderSessionQueuedMessages(14, [lateThree!.id])).toBe(true);
            expect(center.clearSessionUserMessages(14)).toBe(true);
            expect(center.clearSessionUserMessages(14)).toBe(false);
            expect(center.clearSessionUserMessages(999)).toBe(false);

            releaseStartup();
            await vi.waitFor(() => expect(center.getSessionStatus(14)).toBeNull());
            expect(executionState.instances).toHaveLength(1);
        } finally {
            releaseStartup?.();
            resetStartupCapabilities();
        }
    });

    it('user gets queued messages restored when the hand-over task fails to start', async () => {
        const failure = new Error('history unavailable');
        historyState.loadSessionHistory.mockResolvedValueOnce([]).mockRejectedValueOnce(failure);
        executionState.run.mockImplementationOnce(finishableRun(15));
        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 15 });
        center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');

        finishCurrentTask!();
        await first.completion;

        let late: PendingUserMessage | null = null;
        await vi.waitFor(
            () => {
                late = center.enqueueSessionUserMessage(15, { prompt: 'late' }, 'queue');
                expect(late).not.toBeNull();
            },
            { timeout: 1000, interval: 10 }
        );

        expect(late).toMatchObject({ prompt: 'late', delivery: 'queue' });
        center.dispose();
    });

    it('user gets no stale delivery request after the task is released', async () => {
        executionState.run.mockImplementation(staysRunningInSession(16));
        const center = createCenter();
        await center.startTask({ prompt: 'first', sessionId: 16 });
        const options = latestOptions();

        center.dispose();

        expect(options.queue.claimPriority()).toEqual([]);
        expect(options.queue.hasImmediate()).toBe(false);
    });
});
