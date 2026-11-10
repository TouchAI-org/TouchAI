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
});

describe('user waits for a queued message to become the next turn', () => {
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

    it('user gets no phantom queue write when the session has nothing waiting', () => {
        const center = createCenter();

        // Without a hand-over there is no task to consume the message; accepting it here
        // would silently swallow the user's prompt.
        expect(center.enqueueSessionUserMessage(8, { prompt: 'orphan' }, 'queue')).toBeNull();
    });
});
