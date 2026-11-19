import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionMessage } from '@/app/api/agent/history';
import type { TaskViewSnapshot } from '@/modules/agent/contracts';
import { NotificationCoalescer } from '@/modules/agent/projection/notifications';
import { cloneTaskViewSnapshot } from '@/modules/agent/projection/view';

describe('given read-only task views are published to a caller', () => {
    it('user sees only display fields in the published view', () => {
        const snapshot = createSnapshot();
        const view = cloneTaskViewSnapshot(snapshot);

        expect('promptSnapshot' in view).toBe(false);
        expect('lastCheckpoint' in view).toBe(false);
        expect(view.status).toBe('running');
        expect(view.taskId).toBe(snapshot.taskId);
    });

    it('user retains the published history when later live output changes', () => {
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

function createSnapshot(overrides: Partial<TaskViewSnapshot> = {}): TaskViewSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'background',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
        ...overrides,
    };
}

afterEach(() => vi.useRealTimers());

describe('given task snapshots change inside one rendering tick', () => {
    it('user receives one streaming update for repeated changes and immediate control updates', async () => {
        vi.useFakeTimers();
        const seen: string[] = [];
        const notifications = new NotificationCoalescer((taskId) => seen.push(taskId));
        notifications.schedule('first');
        notifications.schedule('first');
        notifications.schedule('first');
        expect(seen).toEqual([]);
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual(['first']);
        notifications.schedule('second');
        notifications.flushNow('second');
        expect(seen).toEqual(['first', 'second']);
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual(['first', 'second']);
        notifications.dispose();
    });

    it('user receives one update for each changing task without a cancelled or disposed late update', async () => {
        vi.useFakeTimers();
        const seen: string[] = [];
        const notifications = new NotificationCoalescer((taskId) => seen.push(taskId));
        notifications.schedule('first');
        notifications.schedule('second');
        notifications.schedule('first');
        notifications.schedule('cancelled');
        notifications.cancel('cancelled');
        await vi.advanceTimersByTimeAsync(0);
        expect(seen).toEqual(['first', 'second']);
        notifications.schedule('disposed');
        notifications.dispose();
        await vi.runAllTimersAsync();
        expect(seen).toEqual(['first', 'second']);
    });
});

describe('given consecutive published views share unchanged messages', () => {
    it('user retains unchanged messages and isolated snapshots when another message changes', () => {
        const unchanged = createMessage('m1', 'first');
        const changed = createMessage('m2', 'before');
        const snapshot = createSnapshot({ sessionHistory: [unchanged, changed] });
        const first = cloneTaskViewSnapshot(snapshot);

        // 模拟投影就地追加流式内容。
        changed.content = 'before and after';
        const second = cloneTaskViewSnapshot(snapshot, first);

        expect(second.sessionHistory[0]).toBe(first.sessionHistory[0]);
        expect(second.sessionHistory[1]).not.toBe(first.sessionHistory[1]);
        expect(second.sessionHistory[1]!.content).toBe('before and after');

        // 发布后的快照与投影后续就地修改隔离。
        changed.content = 'mutated later';
        expect(first.sessionHistory[1]!.content).toBe('before');
        expect(second.sessionHistory[1]!.content).toBe('before and after');
    });

    it('user sees removed and appended messages without changing a previous view', () => {
        const firstMessage = createMessage('m1', 'a');
        const removed = createMessage('m2', 'b');
        const first = cloneTaskViewSnapshot(
            createSnapshot({ sessionHistory: [firstMessage, removed] })
        );

        const appended = createMessage('m3', 'c');
        const second = cloneTaskViewSnapshot(
            createSnapshot({ sessionHistory: [firstMessage, appended] }),
            first
        );

        expect(second.sessionHistory.map((message) => message.id)).toEqual(['m1', 'm3']);
        expect(second.sessionHistory[0]).toBe(first.sessionHistory[0]);
        expect(second.sessionHistory[1]).not.toBe(first.sessionHistory[1]);
    });

    it('user retains the published pending decisions when a live decision is added', () => {
        const snapshot = createSnapshot({
            pendingApprovals: [
                {
                    callId: 'call-1',
                } as never,
            ],
        });

        const view = cloneTaskViewSnapshot(snapshot);
        snapshot.pendingApprovals.push({
            callId: 'call-2',
        } as never);

        expect(view.pendingApprovals).toHaveLength(1);
    });
});

function createMessage(id: string, content: string): SessionMessage {
    return { id, role: 'assistant', content, parts: [], timestamp: 1 };
}
