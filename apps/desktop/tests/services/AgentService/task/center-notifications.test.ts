import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskResult } from '@/services/AgentService/execution/runtime';

/**
 * A running task streams many snapshots per second. The center coalesces those
 * notifications into one per tick, but approval, terminal and error states must
 * reach subscribers immediately so the UI never shows a stale pending state.
 */
const runtimeState = vi.hoisted(() => ({
    run: vi.fn(),
    instances: [] as Array<{ options: Record<string, unknown> }>,
}));

function latestOptions(): Record<string, unknown> & {
    onTurnEvent?: (event: Record<string, unknown>) => void;
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

function staysRunningInSession(sessionId: number | null) {
    return () => {
        latestOptions().onTurnEvent?.({ type: 'task_started', sessionId, turnId: 1 });
        return new Promise<TaskResult>(() => {});
    };
}

describe('user watches a streaming task', () => {
    beforeEach(() => {
        runtimeState.run.mockReset();
        runtimeState.instances.length = 0;
        historyState.loadSessionHistory.mockReset();
        historyState.loadSessionHistory.mockResolvedValue([]);
    });

    it('user gets coalesced streaming updates but terminal updates immediately', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = new SessionTaskCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const seen: string[] = [];
        center.subscribeTask(started.taskId, (snapshot) => seen.push(snapshot.status));
        expect(seen).toEqual(['running']);

        // Three streaming (running) snapshots in one tick collapse into one notification.
        latestOptions().onTurnEvent?.({ type: 'checkpoint_committed', taskId: started.taskId });
        latestOptions().onTurnEvent?.({ type: 'checkpoint_committed', taskId: started.taskId });
        latestOptions().onTurnEvent?.({ type: 'checkpoint_committed', taskId: started.taskId });
        expect(seen).toEqual(['running']);

        // The coalescer flushes on a timer tick, so a single macrotask must elapse.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(seen).toEqual(['running', 'running']);

        // A terminal update flushes immediately, not on the next tick.
        latestOptions().onTurnEvent?.({
            type: 'task_completed',
            taskId: started.taskId,
            turnId: 1,
        });
        expect(seen[seen.length - 1]).toBe('completed');
    });
});
