import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type { ExecuteRequestResult } from '@/services/AgentService/execution/runtime';

/**
 * The task center owns the lifecycle of a running conversation: which task a session
 * points at, what a late-arriving page sees, what happens when a turn ends. Those are all
 * observable through its public methods, so the runtime is the only thing stubbed here.
 *
 * The runtime reports progress through `onTurnEvent`, and the center derives status from
 * those events rather than from the promise result, so the stub must emit them the way the
 * real runtime does.
 */
const runtimeState = vi.hoisted(() => ({
    run: vi.fn(),
    instances: [] as Array<{ options: Record<string, unknown> }>,
}));

/** The options the most recently constructed runtime received. */
function latestOptions(): Record<string, unknown> & {
    onTurnEvent?: (event: Record<string, unknown>) => void;
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
            // Store the options under the same key the helpers read, so a stub can drive the
            // turn events the real runtime would emit.
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
    ({
        model: { id: 'model-1', name: 'Model' },
        response,
        reasoning: '',
        turn: null,
    }) as unknown as ExecuteRequestResult;

/** A running task that has already bound to its session, as the real runtime reports. */
function staysRunningInSession(sessionId: number | null) {
    return () => {
        latestOptions().onTurnEvent?.({ type: 'task_started', sessionId, turnId: 1 });
        return new Promise<ExecuteRequestResult>(() => {});
    };
}

/** Run a task that binds to its session, then finishes with the given response. */
function completesInSession(sessionId: number | null, response = 'done') {
    return async () => {
        const options = latestOptions();
        options.onTurnEvent?.({ type: 'task_started', sessionId, turnId: 1 });
        options.onTurnEvent?.({ type: 'task_completed' });
        return completedTurn(response);
    };
}

/** The task center is process-wide, so every test builds its own isolated instance. */
function createCenter() {
    return new SessionTaskCenter();
}

describe('user starts a conversation task', () => {
    beforeEach(() => {
        runtimeState.run.mockReset();
        runtimeState.instances.length = 0;
        historyState.loadSessionHistory.mockReset();
        historyState.loadSessionHistory.mockResolvedValue([]);
    });

    it('user gets a running task that is already bound to the session', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(7));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 7 });

        expect(started.sessionId).toBe(7);
        expect(center.getSessionStatus(7)).toEqual({ status: 'running', taskId: started.taskId });
    });

    it('user sees the earlier messages loaded into the task before it runs', async () => {
        historyState.loadSessionHistory.mockResolvedValue([
            { id: 'msg-1', role: 'user', content: 'earlier', parts: [], timestamp: 1 },
        ]);
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 3 });

        const contents = center
            .getTaskSnapshot(started.taskId)
            ?.sessionHistory.map((message) => message.content);
        // The earlier history comes first; the new prompt is appended to it.
        expect(contents?.slice(0, 1)).toEqual(['earlier']);
    });

    it('user keeps a sessionless task out of the session index', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(null));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi' });

        expect(started.sessionId).toBeNull();
        expect(center.attachSessionView(7)).toBeNull();
    });

    it('user is told a session already has a running task instead of silently racing it', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(5));

        const center = createCenter();
        await center.startTask({ prompt: 'first', sessionId: 5 });

        await expect(center.startTask({ prompt: 'second', sessionId: 5 })).rejects.toMatchObject({
            code: AiErrorCode.SESSION_ACTIVE_TASK_EXISTS,
        });
    });

    it('user can start a new task in a session once the previous one finished', async () => {
        const center = createCenter();

        // First task runs to completion, releasing the session.
        runtimeState.run.mockImplementation(completesInSession(9));
        const first = await center.startTask({ prompt: 'first', sessionId: 9 });
        await first.completion;

        // Second task is still running, so the session points at it.
        runtimeState.run.mockImplementation(staysRunningInSession(9));
        const second = await center.startTask({ prompt: 'second', sessionId: 9 });

        expect(second.taskId).not.toBe(first.taskId);
        expect(center.getSessionStatus(9)?.taskId).toBe(second.taskId);
    });

    it('user gets no task at all when loading the earlier messages fails', async () => {
        historyState.loadSessionHistory.mockRejectedValue(new Error('database is locked'));

        const center = createCenter();

        await expect(center.startTask({ prompt: 'Hi', sessionId: 4 })).rejects.toThrow(
            'database is locked'
        );
        expect(center.getSessionStatus(4)).toBeNull();
        expect(center.listActiveTasks()).toEqual([]);
    });

    it('user sees a background task marked as such', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(null));

        const center = createCenter();
        const started = await center.startBackgroundTask({ prompt: 'Hi' });

        expect(center.getTaskSnapshot(started.taskId)?.executionMode).toBe('background');
    });

    it('user sees a foreground task marked as such', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(null));

        const center = createCenter();
        const started = await center.startForegroundTask({ prompt: 'Hi' });

        expect(center.getTaskSnapshot(started.taskId)?.executionMode).toBe('foreground');
    });
});

describe('user watches a task reach its end', () => {
    beforeEach(() => {
        runtimeState.run.mockReset();
        runtimeState.instances.length = 0;
        historyState.loadSessionHistory.mockReset();
        historyState.loadSessionHistory.mockResolvedValue([]);
    });

    it('user sees the task completed after the answer arrives', async () => {
        runtimeState.run.mockImplementation(completesInSession(1, 'All done'));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        await started.completion;

        expect(center.getTaskSnapshot(started.taskId)?.status).toBe('completed');
    });

    it('user sees the task failed with the message when the provider errors', async () => {
        runtimeState.run.mockRejectedValue(new AiError(AiErrorCode.STREAM_ERROR, {}));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        await expect(started.completion).rejects.toBeInstanceOf(AiError);
        expect(center.getTaskSnapshot(started.taskId)?.status).toBe('failed');
    });

    it('user sees the task cancelled rather than failed when they cancel it', async () => {
        // The runtime watches the signal the center hands it, so the stub must do the same.
        runtimeState.run.mockImplementation(() => {
            const signal = latestOptions().signal;
            return new Promise((_resolve, reject) => {
                signal?.addEventListener('abort', () => {
                    reject(new AiError(AiErrorCode.REQUEST_CANCELLED, {}));
                });
            });
        });

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        expect(center.cancelTask(started.taskId)).toBe(true);

        await expect(started.completion).rejects.toBeInstanceOf(AiError);
        expect(center.getTaskSnapshot(started.taskId)?.status).toBe('cancelled');
    });

    it('user stops seeing a finished task in the active list', async () => {
        runtimeState.run.mockImplementation(completesInSession(1));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        await started.completion;

        expect(center.listActiveTasks()).toEqual([]);
    });

    it('user keeps seeing the task snapshot briefly after it finishes', async () => {
        runtimeState.run.mockImplementation(completesInSession(1));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });
        await started.completion;

        // A page that opens late must still be able to read the final state.
        expect(center.getTaskSnapshot(started.taskId)?.status).toBe('completed');
    });

    it('user cannot cancel a task that is already gone', () => {
        const center = createCenter();

        expect(center.cancelTask('missing-task')).toBe(false);
    });
});

describe('user subscribes to a running task', () => {
    beforeEach(() => {
        runtimeState.run.mockReset();
        runtimeState.instances.length = 0;
        historyState.loadSessionHistory.mockReset();
        historyState.loadSessionHistory.mockResolvedValue([]);
    });

    it('user gets the current snapshot immediately on subscribing', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const seen: string[] = [];
        center.subscribeTask(started.taskId, (snapshot) => seen.push(snapshot.status));

        expect(seen).toEqual(['running']);
    });

    it('user stops receiving updates after unsubscribing', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const seen: string[] = [];
        const unsubscribe = center.subscribeTask(started.taskId, (snapshot) =>
            seen.push(snapshot.status)
        );
        unsubscribe();
        center.cancelTask(started.taskId);

        expect(seen).toEqual(['running']);
    });

    it('user is told the task does not exist when subscribing to an unknown one', () => {
        const center = createCenter();

        expect(() => center.subscribeTask('nope', () => {})).toThrow(AiError);
    });

    it('user can unsubscribe a listener without it ever having subscribed', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        expect(() => center.unsubscribeTask(started.taskId, () => {})).not.toThrow();
        expect(() => center.unsubscribeTask('missing', () => {})).not.toThrow();
    });

    it('user still sees updates when one subscriber throws during a broadcast', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const seen: string[] = [];
        let throws = false;
        // The immediate snapshot on subscribe is delivered straight through, so the
        // subscriber only starts failing once it has been accepted.
        center.subscribeTask(started.taskId, () => {
            if (throws) {
                throw new Error('subscriber blew up');
            }
        });
        center.subscribeTask(started.taskId, (snapshot) => seen.push(snapshot.status));

        throws = true;
        center.cancelTask(started.taskId);

        // The throwing subscriber must not stop the other one from receiving updates.
        expect(seen.length).toBeGreaterThan(1);
    });
});

describe('user answers an approval request', () => {
    beforeEach(() => {
        runtimeState.run.mockReset();
        runtimeState.instances.length = 0;
        historyState.loadSessionHistory.mockReset();
        historyState.loadSessionHistory.mockResolvedValue([]);
    });

    it('user cannot approve or reject a call on a task that is gone', () => {
        const center = createCenter();

        expect(center.approveTaskToolCall('missing')).toBe(false);
        expect(center.rejectTaskToolCall('missing')).toBe(false);
        expect(center.settleTaskUserQuestion('missing', 'call-1', null)).toBe(false);
    });
});
