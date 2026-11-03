import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaskResult } from '@/services/AgentService/execution/runtime';

/**
 * The approval/user-question wait is owned by the task runtime, not by the
 * projection. The center exposes the exact callbacks it hands the runtime, so
 * the tests drive the real registration/decision path through a stubbed runtime.
 *
 * The no-visible-assistant-message case is proven at the projection port in
 * `interactions.test.ts`; here the focus is attempt-scoped identity and
 * fail-closed decisions across a retry.
 */
const runtimeState = vi.hoisted(() => ({
    run: vi.fn(),
    instances: [] as Array<{ options: Record<string, unknown> }>,
}));

function latestOptions(): Record<string, unknown> & {
    onTurnEvent?: (event: Record<string, unknown>) => void;
    requestToolApproval?: (payload: Record<string, unknown>) => Promise<boolean>;
    requestUserQuestions?: (
        callId: string,
        questions: unknown[],
        attemptToken?: string
    ) => Promise<unknown[] | null>;
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

/** A runtime that binds to its session and then stays running. */
function staysRunningInSession(sessionId: number | null) {
    return () => {
        latestOptions().onTurnEvent?.({ type: 'task_started', sessionId, turnId: 1 });
        latestOptions().onTurnEvent?.({ type: 'attempt_started', attemptToken: 'attempt-1' });
        return new Promise<TaskResult>(() => {});
    };
}

describe('user approves a tool for a running task', () => {
    beforeEach(() => {
        runtimeState.run.mockReset();
        runtimeState.instances.length = 0;
        historyState.loadSessionHistory.mockReset();
        historyState.loadSessionHistory.mockResolvedValue([]);
    });

    it('user can wait and approve a tool while the task is running', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = new SessionTaskCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const wait = latestOptions().requestToolApproval?.({
            callId: 'call-1',
            attemptToken: 'attempt-1',
        }) as Promise<boolean>;
        expect(center.getTaskSnapshot(started.taskId)?.pendingApprovals[0]?.callId).toBe('call-1');

        const token = center.getTaskSnapshot(started.taskId)?.pendingApprovals[0]?.decisionId;
        expect(center.approveTaskToolCall(started.taskId, 'call-1', token)).toBe(true);
        await expect(wait).resolves.toBe(true);
    });

    it('user decision with an explicit callId but no identity is refused', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = new SessionTaskCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        const wait = latestOptions().requestToolApproval?.({
            callId: 'call-1',
            attemptToken: 'attempt-1',
        }) as Promise<boolean>;

        expect(center.approveTaskToolCall(started.taskId, 'call-1')).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingApprovals[0]?.callId).toBe('call-1');

        // The identity-free keyboard path still works by capturing the live wait.
        expect(center.approveTaskToolCall(started.taskId)).toBe(true);
        await expect(wait).resolves.toBe(true);
    });

    it('user cannot reuse a decision token from a previous attempt after a retry', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = new SessionTaskCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        latestOptions().onTurnEvent?.({ type: 'attempt_started', attemptToken: 'attempt-1' });
        const firstWait = latestOptions().requestToolApproval?.({
            callId: 'call-1',
            attemptToken: 'attempt-1',
        }) as Promise<boolean>;
        const staleToken = center.getTaskSnapshot(started.taskId)?.pendingApprovals[0]?.decisionId;
        expect(staleToken).toBeTruthy();

        // The runtime retries: a new attempt begins and releases the old wait.
        latestOptions().onTurnEvent?.({ type: 'attempt_started', attemptToken: 'attempt-2' });
        await expect(firstWait).resolves.toBe(false);

        // A late callback from the old attempt cannot register on the new one.
        await expect(
            latestOptions().requestToolApproval?.({
                callId: 'stale-call',
                attemptToken: 'attempt-1',
            }) as Promise<boolean>
        ).resolves.toBe(false);

        const secondWait = latestOptions().requestToolApproval?.({
            callId: 'call-1',
            attemptToken: 'attempt-2',
        }) as Promise<boolean>;
        const liveToken = center.getTaskSnapshot(started.taskId)?.pendingApprovals[0]?.decisionId;
        expect(liveToken).toBeTruthy();
        expect(liveToken).not.toBe(staleToken);

        expect(center.approveTaskToolCall(started.taskId, 'call-1', staleToken)).toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingApprovals[0]?.callId).toBe('call-1');

        expect(center.approveTaskToolCall(started.taskId, 'call-1', liveToken)).toBe(true);
        await expect(secondWait).resolves.toBe(true);
    });

    it('user decision after the task reached its end is refused instead of hanging', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = new SessionTaskCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        latestOptions().onTurnEvent?.({ type: 'task_completed', turnId: 1 });

        const wait = latestOptions().requestToolApproval?.({
            callId: 'call-1',
            attemptToken: 'attempt-1',
        }) as Promise<boolean>;
        await expect(wait).resolves.toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingApprovals).toEqual([]);
        expect(center.approveTaskToolCall(started.taskId, 'call-1')).toBe(false);
    });

    it('user answering a question after the task ended is refused instead of hanging', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = new SessionTaskCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        latestOptions().onTurnEvent?.({ type: 'task_cancelled', turnId: 1 });

        const wait = latestOptions().requestUserQuestions?.('q-1', [], 'attempt-1') as Promise<
            unknown[] | null
        >;
        await expect(wait).resolves.toBeNull();
        expect(center.settleTaskUserQuestion(started.taskId, 'q-1', [])).toBe(false);
    });

    it('user loses a pending card and cannot decide it once the attempt ends', async () => {
        runtimeState.run.mockImplementation(staysRunningInSession(1));

        const center = new SessionTaskCenter();
        const started = await center.startTask({ prompt: 'Hi', sessionId: 1 });

        latestOptions().onTurnEvent?.({ type: 'attempt_started', attemptToken: 'attempt-1' });
        const wait = latestOptions().requestToolApproval?.({
            callId: 'call-1',
            attemptToken: 'attempt-1',
        }) as Promise<boolean>;
        const token = center.getTaskSnapshot(started.taskId)?.pendingApprovals[0]?.decisionId;
        expect(token).toBeTruthy();

        // The attempt fails; the runtime closes its window before the retry delay.
        latestOptions().onTurnEvent?.({ type: 'attempt_finished' });
        await expect(wait).resolves.toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingApprovals).toEqual([]);
        expect(center.approveTaskToolCall(started.taskId, 'call-1', token)).toBe(false);

        // A late callback from the finished attempt cannot register during the gap.
        await expect(
            latestOptions().requestToolApproval?.({
                callId: 'late-call',
                attemptToken: 'attempt-1',
            }) as Promise<boolean>
        ).resolves.toBe(false);
        expect(center.getTaskSnapshot(started.taskId)?.pendingApprovals).toEqual([]);
    });
});
