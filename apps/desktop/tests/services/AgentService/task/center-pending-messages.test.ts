import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExecuteRequestResult } from '@/services/AgentService/execution/runtime';
import type { PendingUserMessage } from '@/services/AgentService/task/types';
import {
    registerStartupCapability,
    resetStartupCapabilities,
} from '@/services/StartupService/capabilities';

/**
 * Messages submitted during a run belong to the task center, not to the page.
 * These cover what the user can observe: the pending list on the snapshot, the
 * priority hand-off at a tool boundary, the fallback to the next turn, and the
 * fact that cancelling really discards them.
 */
const runtimeState = vi.hoisted(() => ({
    run: vi.fn(),
    instances: [] as Array<{ options: Record<string, unknown> }>,
}));

function latestOptions(): Record<string, unknown> & {
    onTurnEvent?: (event: Record<string, unknown>) => void;
    takePriorityUserMessages?: () => PendingUserMessage[];
    hasImmediatePriorityUserMessages?: () => boolean;
    signal?: AbortSignal;
} {
    const entries = runtimeState.instances;
    return (entries[entries.length - 1]?.options ?? {}) as never;
}

const historyState = vi.hoisted(() => ({ loadSessionHistory: vi.fn() }));

vi.mock('@/services/AgentService/execution/runtime', async () => {
    const actual = await vi.importActual<
        typeof import('@/services/AgentService/execution/runtime')
    >('@/services/AgentService/execution/runtime');

    class StubConversationRuntime {
        constructor(_executor: unknown, options: never) {
            runtimeState.instances.push({ options });
        }

        run() {
            return runtimeState.run();
        }
    }

    return { ...actual, AiConversationRuntime: StubConversationRuntime };
});

vi.mock('@/services/AgentService/session/history', () => ({
    loadSessionHistory: historyState.loadSessionHistory,
}));

const { SessionTaskCenter } = await import('@/services/AgentService/task/center');

const completedTurn = (response: string): ExecuteRequestResult =>
    ({ model: { id: 'model-1', name: 'Model' }, response, reasoning: '', turn: null }) as never;

let finishCurrentTask: (() => void) | null = null;

/** A task that binds to its session and finishes only when the test says so. */
function finishableRun(sessionId: number | null) {
    return () =>
        new Promise<ExecuteRequestResult>((resolve) => {
            const options = latestOptions();
            options.onTurnEvent?.({ type: 'task_started', sessionId, turnId: 1 });
            finishCurrentTask = () => {
                options.onTurnEvent?.({
                    type: 'task_completed',
                    taskId: 'task',
                    turnId: 1,
                    model: {
                        modelDbId: 1,
                        providerId: 1,
                        providerName: 'p',
                        modelId: 'm',
                        modelName: 'M',
                    },
                    response: 'done',
                    reasoning: '',
                });
                resolve(completedTurn('done'));
            };
        });
}

/** A task that binds to its session and never finishes on its own. */
function staysRunningInSession(sessionId: number | null) {
    return () => {
        latestOptions().onTurnEvent?.({ type: 'task_started', sessionId, turnId: 1 });
        return new Promise<ExecuteRequestResult>(() => {});
    };
}

function createCenter() {
    return new SessionTaskCenter();
}

beforeEach(() => {
    runtimeState.run.mockReset();
    runtimeState.instances.length = 0;
    historyState.loadSessionHistory.mockReset();
    historyState.loadSessionHistory.mockResolvedValue([]);
    finishCurrentTask = null;
});

describe('user submits a message while a task runs', () => {
    it('user gets the queued message as a pending bubble on the task snapshot', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Follow up' },
            'queue'
        );

        expect(message).toMatchObject({ prompt: 'Follow up', delivery: 'queue' });
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([message]);
    });

    it('user keeps the priority bubble until the projection reports it delivered', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Insert me' },
            'priority'
        );

        // The runtime may ask twice before the delivery event lands; neither read may
        // remove the bubble early, or the user sees it vanish and reappear.
        expect(latestOptions().takePriorityUserMessages?.()).toEqual([message]);
        expect(latestOptions().takePriorityUserMessages?.()).toEqual([message]);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toHaveLength(1);
    });

    it('user gets the bubble gone once the projection reports the delivery', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const message = center.enqueueTaskUserMessage(
            started.taskId,
            { prompt: 'Insert me' },
            'priority'
        );
        const seen: unknown[] = [];
        center.subscribeTask(started.taskId, (snapshot) => seen.push(snapshot));

        latestOptions().onTurnEvent?.({
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
        runtimeState.run.mockImplementation(staysRunningInSession(1));
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
        expect(latestOptions().takePriorityUserMessages?.()).toEqual([
            expect.objectContaining({ id: message!.id, delivery: 'priority' }),
        ]);
        expect(center.promoteTaskUserMessage(started.taskId, message!.id)).toBe(false);
    });

    it('user gets their message flagged for immediate delivery when they click steer now', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
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
        expect(latestOptions().hasImmediatePriorityUserMessages?.()).toBe(true);
    });

    it('user does not interrupt the answer for a message that only waits for a tool call', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        center.enqueueTaskUserMessage(started.taskId, { prompt: 'Insert me' }, 'priority');

        expect(latestOptions().hasImmediatePriorityUserMessages?.()).toBe(false);
    });

    it('user gets a queued message turned solid immediately when they click steer now', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
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
        expect(seen[seen.length - 1]).toBe('priority');
    });

    it('user gets pending messages removed or cleared from the task', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        const first = center.enqueueTaskUserMessage(started.taskId, { prompt: 'one' }, 'queue');
        const second = center.enqueueTaskUserMessage(started.taskId, { prompt: 'two' }, 'queue');

        expect(center.removeTaskUserMessage(started.taskId, first!.id)).toBe(true);
        expect(center.removeTaskUserMessage(started.taskId, first!.id)).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([second]);

        expect(center.clearTaskUserMessages(started.taskId)).toBe(true);
        expect(center.clearTaskUserMessages(started.taskId)).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([]);
    });

    it('user gets an edited queue updated in place without changing its slot', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
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
    });

    it('user cannot rewrite a queue after it has been promoted to a steer', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));
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
        runtimeState.run.mockImplementation(staysRunningInSession(10));
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
        expect(latestOptions().takePriorityUserMessages?.()).toEqual([steered]);

        expect(center.reorderTaskQueuedMessages(started.taskId, [steered!.id])).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual(
            snapshot?.pendingUserMessages
        );
    });
});

describe('user waits for a queued message to become the next turn', () => {
    it('user gets the reordered queue started first on the next turn', async () => {
        runtimeState.run
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

        await vi.waitFor(() => expect(runtimeState.instances).toHaveLength(2));
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
        runtimeState.run
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

        await vi.waitFor(() => expect(runtimeState.instances).toHaveLength(2));
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
        runtimeState.run
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

        await vi.waitFor(() => expect(runtimeState.instances).toHaveLength(2));
        const next = center.getSessionStatus(4);
        expect(center.getTaskSnapshot(next!.taskId)?.sessionHistory[0]).toMatchObject({
            id: inserted!.id,
            content: 'insert',
        });
    });
});

describe('user cancels a run with pending messages', () => {
    it('user gets the pending messages discarded and no next turn started', async () => {
        runtimeState.run.mockImplementation(() => {
            const options = latestOptions();
            options.onTurnEvent?.({ type: 'task_started', sessionId: 5, turnId: 1 });
            return new Promise<ExecuteRequestResult>((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(new Error('cancelled')));
            });
        });
        const center = createCenter();
        const started = await center.startTask({ prompt: 'first', sessionId: 5 });
        center.enqueueTaskUserMessage(started.taskId, { prompt: 'queued' }, 'queue');

        center.cancelTask(started.taskId);
        await started.completion.catch(() => {});

        expect(center.getTaskSnapshot(started.taskId)?.pendingUserMessages).toEqual([]);
        runtimeState.run.mockImplementation(staysRunningInSession(5));
        const restarted = await center.startTask({ prompt: 'again', sessionId: 5 });
        expect(center.getTaskSnapshot(restarted.taskId)?.pendingUserMessages).toEqual([]);
    });
});

describe('user submits while a finished run hands over to its queue', () => {
    it('user gets the message queued instead of racing a second task for the session', async () => {
        let releaseStartup!: () => void;
        try {
            runtimeState.run
                .mockImplementationOnce(finishableRun(6))
                .mockImplementation(staysRunningInSession(6));
            const center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 6 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'third' }, 'queue');

            finishCurrentTask!();
            await first.completion;

            // The hand-over task is starting but has not attached yet: the user submits here.
            registerStartupCapability(
                'model-metadata',
                new Promise<void>((resolve) => {
                    releaseStartup = resolve;
                })
            );
            await Promise.resolve();
            await Promise.resolve();

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
            runtimeState.run
                .mockImplementationOnce(finishableRun(12))
                .mockImplementation(staysRunningInSession(12));
            const center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 12 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');
            const third = center.enqueueTaskUserMessage(first.taskId, { prompt: 'third' }, 'queue');

            finishCurrentTask!();
            await first.completion;

            registerStartupCapability(
                'model-metadata',
                new Promise<void>((resolve) => {
                    releaseStartup = resolve;
                })
            );
            await Promise.resolve();
            await Promise.resolve();

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
            runtimeState.run
                .mockImplementationOnce(finishableRun(13))
                .mockImplementation(staysRunningInSession(13));
            const center = createCenter();
            const first = await center.startTask({ prompt: 'first', sessionId: 13 });
            center.enqueueTaskUserMessage(first.taskId, { prompt: 'second' }, 'queue');

            finishCurrentTask!();
            await first.completion;

            registerStartupCapability(
                'model-metadata',
                new Promise<void>((resolve) => {
                    releaseStartup = resolve;
                })
            );
            await Promise.resolve();
            await Promise.resolve();

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

    it('user gets no phantom queue write when the session has nothing waiting', () => {
        const center = createCenter();

        // Without a hand-over there is no task to consume the message; accepting it here
        // would silently swallow the user's prompt.
        expect(center.enqueueSessionUserMessage(8, { prompt: 'orphan' }, 'queue')).toBeNull();
    });
});
