/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import type { ExecuteRequestResult } from '@/services/AgentService/execution/runtime';

/**
 * The task center is the only owner of a running turn. These cover the paths a page uses
 * once a task exists: answering its approval prompts, binding a late-opening page to it,
 * listing what is running, and cancelling through the external signal.
 */
const runtimeState = vi.hoisted(() => ({
    run: vi.fn(),
    instances: [] as Array<{ options: Record<string, unknown> }>,
}));

function latestOptions(): Record<string, unknown> & {
    onTurnEvent?: (event: Record<string, unknown>) => void;
    onChunk?: (chunk: Record<string, unknown>) => void;
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

/** A task that binds to its session and then keeps running. */
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
});

describe('user opens a page for a session that is already running', () => {
    it('user sees the running task and its current snapshot', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(4));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 4 });

        const view = center.attachSessionView(4);

        expect(view?.taskId).toBe(started.taskId);
        expect(view?.snapshot.status).toBe('running');
    });

    it('user gets a copy so changing the page state cannot corrupt the task', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(4));

        const center = createCenter();
        await center.startTask({ prompt: 'Hi', sessionId: 4 });

        const view = center.attachSessionView(4);
        view!.snapshot.status = 'failed';

        // The stored snapshot is untouched by edits to the returned copy.
        expect(center.getTaskSnapshot(view!.taskId)?.status).toBe('running');
    });

    it('user gets nothing for a session with no running task', () => {
        const center = createCenter();

        expect(center.attachSessionView(99)).toBeNull();
    });

    it('user sees only the tasks that are still running', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = createCenter();
        await center.startTask({ prompt: 'first', sessionId: 1 });
        await center.startTask({ prompt: 'second', sessionId: 2 });

        const active = center.listActiveTasks();

        expect(active).toHaveLength(2);
        expect(active.every((snapshot) => snapshot.status === 'running')).toBe(true);
    });

    it('user sees the running task listed for its session', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(6));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 6 });

        expect(center.getSessionStatus(6)).toEqual({
            status: 'running',
            taskId: started.taskId,
        });
        expect(center.getSessionStatus(99)).toBeNull();
    });
});

describe('user answers a tool approval while the task runs', () => {
    it('user is told there is nothing to approve when the task is gone', () => {
        const center = createCenter();

        expect(center.approveTaskToolCall('missing')).toBe(false);
        expect(center.rejectTaskToolCall('missing')).toBe(false);
    });

    it('user gets no approval accepted when the task never asked for one', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(3));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 3 });

        // A page can click approve for a call that already moved on.
        expect(center.approveTaskToolCall(started.taskId, 'call-1')).toBe(false);
        expect(center.rejectTaskToolCall(started.taskId, 'call-1')).toBe(false);
    });

    it('user gets no question answer accepted for a call that is not waiting', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(3));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 3 });

        expect(center.settleTaskUserQuestion(started.taskId, 'call-1', [])).toBe(false);
    });

    it('user sees the task stop being cancelable once it is stopped', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(3));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 3 });

        expect(center.cancelTask(started.taskId)).toBe(true);
        // The runtime owns the terminal status; the center only signals it to stop.
        expect(latestOptions().signal?.aborted).toBe(true);
    });

    it('user sees the approval prompt cleared when they stop the task', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(3));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 3 });

        center.cancelTask(started.taskId);

        // Nothing is left pending, so the panel cannot show a dead prompt.
        expect(center.getTaskSnapshot(started.taskId)?.pendingToolApproval).toBeNull();
    });

    it('user gets the abort relayed when they cancel through the runtime signal', async () => {
        const controller = new AbortController();
        runtimeState.run.mockImplementation(staysRunningInSession(3));

        const center = createCenter();
        await center.startTask({ prompt: 'Hi', sessionId: 3, signal: controller.signal });

        // The external signal is forwarded to the task's own controller.
        controller.abort();

        expect(latestOptions().signal?.aborted).toBe(true);
    });
});

describe('user starts a task with an already-cancelled signal', () => {
    it('user sees the task start with cancellation already in effect', async () => {
        const controller = new AbortController();
        controller.abort();
        runtimeState.run.mockImplementation(staysRunningInSession(null));

        const center = createCenter();
        const started = await center.startTask({ prompt: 'Hi', signal: controller.signal });

        // An already-aborted caller cannot be un-cancelled by starting the task.
        expect(latestOptions().signal?.aborted).toBe(true);
        expect(center.getTaskSnapshot(started.taskId)).not.toBeNull();
    });
});

describe('user is told a task cannot start twice in one session', () => {
    it('user sees the conflict error name the session', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(8));

        const center = createCenter();
        await center.startTask({ prompt: 'first', sessionId: 8 });

        await expect(center.startTask({ prompt: 'second', sessionId: 8 })).rejects.toMatchObject({
            code: AiErrorCode.SESSION_ACTIVE_TASK_EXISTS,
        });
    });

    it('user can start another task in a different session meanwhile', async () => {
        // The runtime reports back whichever session the task was started for.
        runtimeState.run.mockImplementation(() => {
            const options = latestOptions() as {
                sessionId?: number | null;
                onTurnEvent?: (event: Record<string, unknown>) => void;
            };
            options.onTurnEvent?.({
                type: 'task_started',
                sessionId: options.sessionId ?? null,
                turnId: 1,
            });
            return new Promise<ExecuteRequestResult>(() => {});
        });

        const center = createCenter();
        const first = await center.startTask({ prompt: 'first', sessionId: 1 });
        const second = await center.startTask({ prompt: 'second', sessionId: 2 });

        // Both sessions keep their own running task.
        expect(center.getSessionStatus(1)?.taskId).toBe(first.taskId);
        expect(center.getSessionStatus(2)?.taskId).toBe(second.taskId);
        expect(center.listActiveTasks()).toHaveLength(2);
    });
});
