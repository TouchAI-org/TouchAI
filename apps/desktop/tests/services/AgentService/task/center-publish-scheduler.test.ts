import { describe, expect, it, vi } from 'vitest';

import {
    cloneTaskViewSnapshot,
    createTaskPublishScheduler,
    shouldPublishTaskSnapshotImmediately,
} from '@/services/AgentService/task/center';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

describe('cloneTaskViewSnapshot', () => {
    it('drops runtime checkpoint and prompt snapshot from the published view', () => {
        const snapshot = createSnapshot({
            promptSnapshot: {
                id: 'prompt-1',
                createdAt: '2026-01-01T00:00:00.000Z',
                systemPrompt: 'system',
                executionMode: 'foreground',
                fragments: [],
                userPrompt: 'hello',
                attachments: [],
            },
            lastCheckpoint: {
                messages: [{ role: 'user', content: 'hello' }],
            } as SessionTaskSnapshot['lastCheckpoint'],
        });

        const view = cloneTaskViewSnapshot(snapshot);

        expect('promptSnapshot' in view).toBe(false);
        expect('lastCheckpoint' in view).toBe(false);
        expect(view.status).toBe('running');
        expect(view.taskId).toBe(snapshot.taskId);
    });

    it('deep clones displayed history so later projection mutations stay isolated', () => {
        const snapshot = createSnapshot({
            sessionHistory: [
                {
                    id: 'assistant-1',
                    role: 'assistant',
                    content: 'first',
                    parts: [],
                    timestamp: 1,
                },
            ],
        });

        const view = cloneTaskViewSnapshot(snapshot);
        snapshot.sessionHistory[0]!.content = 'mutated';

        expect(view.sessionHistory[0]!.content).toBe('first');
    });
});

function createSnapshot(overrides: Partial<SessionTaskSnapshot> = {}): SessionTaskSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'background',
        prompt: 'Prompt',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
        ...overrides,
    };
}

describe('shouldPublishTaskSnapshotImmediately', () => {
    it('flushes control states immediately and batches plain streaming', () => {
        expect(shouldPublishTaskSnapshotImmediately(createSnapshot())).toBe(false);
        expect(
            shouldPublishTaskSnapshotImmediately(createSnapshot({ status: 'waiting_approval' }))
        ).toBe(true);
        expect(shouldPublishTaskSnapshotImmediately(createSnapshot({ status: 'completed' }))).toBe(
            true
        );
        expect(shouldPublishTaskSnapshotImmediately(createSnapshot({ status: 'failed' }))).toBe(
            true
        );
        expect(
            shouldPublishTaskSnapshotImmediately(
                createSnapshot({
                    pendingToolApproval: {
                        callId: 'call-1',
                        sourceMessageId: 'assistant-1',
                        toolName: 'builtin__bash',
                        arguments: '{}',
                    },
                })
            )
        ).toBe(true);
        expect(
            shouldPublishTaskSnapshotImmediately(
                createSnapshot({
                    pendingUserQuestion: {
                        callId: 'question-1',
                        sourceMessageId: 'assistant-1',
                        createdAt: 1,
                        questions: [],
                    },
                })
            )
        ).toBe(true);
    });
});

describe('createTaskPublishScheduler', () => {
    it('coalesces streaming publishes within one microtask', async () => {
        const notify = vi.fn();
        const scheduler = createTaskPublishScheduler(notify);

        scheduler.schedule('task-1', createSnapshot());
        scheduler.schedule('task-1', createSnapshot());
        scheduler.schedule('task-1', createSnapshot());
        expect(notify).not.toHaveBeenCalled();

        await Promise.resolve();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledWith('task-1');
    });

    it('publishes control states synchronously without waiting for the microtask', () => {
        const notify = vi.fn();
        const scheduler = createTaskPublishScheduler(notify);

        scheduler.schedule('task-1', createSnapshot({ status: 'waiting_approval' }));

        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('does not double publish when a terminal state arrives before the pending flush', async () => {
        const notify = vi.fn();
        const scheduler = createTaskPublishScheduler(notify);

        scheduler.schedule('task-1', createSnapshot());
        scheduler.schedule('task-1', createSnapshot({ status: 'completed' }));
        expect(notify).toHaveBeenCalledTimes(1);

        await Promise.resolve();
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('flushes each dirty task once per microtask', async () => {
        const notify = vi.fn();
        const scheduler = createTaskPublishScheduler(notify);

        scheduler.schedule('task-1', createSnapshot({ taskId: 'task-1' }));
        scheduler.schedule('task-2', createSnapshot({ taskId: 'task-2' }));
        scheduler.schedule('task-1', createSnapshot({ taskId: 'task-1' }));

        await Promise.resolve();
        expect(notify).toHaveBeenCalledTimes(2);
        expect(notify.mock.calls.map(([taskId]) => taskId).sort()).toEqual(['task-1', 'task-2']);
    });
});
