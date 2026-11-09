import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

describe('given a conversation that compacts older context', () => {
    let snapshot: SessionTaskSnapshot;
    let projection: SessionTaskProjection;

    beforeEach(() => {
        snapshot = {
            taskId: 'context-task',
            sessionId: 1,
            turnId: null,
            status: 'running',
            executionMode: 'foreground',
            prompt: 'Continue',
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
        };
        projection = new SessionTaskProjection(snapshot, vi.fn());
        projection.bootstrap([], 'Continue', []);
    });

    function status(state: 'compacting' | 'compacted' | 'failed') {
        projection.handleChunk({
            content: '',
            done: false,
            contextCompaction: { id: 'summary-1', state },
        });
    }

    it('user sees compaction finish at its original timeline position without altering answer text', () => {
        projection.handleChunk({ content: 'Inspecting files.', done: false });
        status('compacting');
        expect(snapshot.sessionHistory[1]!.parts[1]).toMatchObject({
            type: 'context_compaction',
            state: 'compacting',
        });
        expect(snapshot.sessionHistory[1]!.isStreaming).toBe(true);
        status('compacted');
        status('compacted');
        expect(snapshot.sessionHistory[1]!.isStreaming).toBe(true);
        projection.handleChunk({ content: 'Checks passed.', done: true });
        projection.markCompleted();
        expect(snapshot.sessionHistory[1]!.isStreaming).toBe(false);
        expect(snapshot.sessionHistory[1]!.parts).toMatchObject([
            { type: 'text', content: 'Inspecting files.' },
            { type: 'context_compaction', id: 'summary-1', state: 'compacted' },
            { type: 'text', content: 'Checks passed.' },
        ]);
        expect(snapshot.sessionHistory[1]!.content).toBe('Inspecting files.Checks passed.');
    });

    it('user sees one divider when a retained timeline replays the same summary', () => {
        status('compacted');
        projection.markCompleted();
        projection.bootstrap(snapshot.sessionHistory, 'Continue again', []);
        status('compacted');
        expect(
            snapshot.sessionHistory
                .flatMap((message) => message.parts)
                .filter((part) => part.type === 'context_compaction')
        ).toHaveLength(1);
    });

    it('user loses the loading divider when summarization fails and can then retry', () => {
        status('compacting');
        status('failed');
        expect(snapshot.sessionHistory[1]!.parts).toEqual([]);
        status('compacting');
        status('compacted');
        expect(snapshot.sessionHistory[1]!.parts).toMatchObject([
            { type: 'context_compaction', state: 'compacted' },
        ]);
    });

    it.each(['cancelled', 'failed', 'completed'] as const)(
        'user sees no stale compaction spinner when the task becomes %s',
        (state) => {
            projection.handleChunk({ content: 'Work so far.', done: false });
            status('compacting');
            if (state === 'cancelled') projection.markCancelled();
            else if (state === 'failed') projection.markFailed('Offline');
            else projection.markCompleted();
            expect(snapshot.sessionHistory[1]!.parts).toMatchObject([
                { type: 'text', content: 'Work so far.' },
            ]);
        }
    );
});
