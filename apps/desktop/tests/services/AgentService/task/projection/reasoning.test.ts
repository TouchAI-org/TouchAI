import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

describe('user watches reasoning and the answer arrive interleaved', () => {
    let snapshot: SessionTaskSnapshot;
    let projection: SessionTaskProjection;

    beforeEach(() => {
        snapshot = {
            taskId: 'reasoning-task',
            sessionId: 1,
            turnId: null,
            status: 'running',
            executionMode: 'foreground',
            prompt: 'Hello',
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
        projection.bootstrap([], 'Hello', []);
    });

    it('user sees reasoning and text kept in arrival order with only adjacent deltas merged', () => {
        for (const chunk of [
            { reasoning: 'First ', content: '' },
            { reasoning: 'thought', content: '' },
            { content: 'First answer' },
            { reasoning: 'Second thought', content: '' },
            { content: 'Final answer' },
        ])
            projection.handleChunk({ ...chunk, done: false });

        const message = snapshot.sessionHistory[snapshot.sessionHistory.length - 1]!;
        expect(message.parts).toMatchObject([
            { type: 'reasoning', content: 'First thought', isStreaming: false },
            { type: 'text', content: 'First answer' },
            { type: 'reasoning', content: 'Second thought', isStreaming: false },
            { type: 'text', content: 'Final answer' },
        ]);
        expect(message.reasoning).toBe('First thoughtSecond thought');
        expect(message.content).toBe('First answerFinal answer');
        expect(new Set(message.parts.map((part) => part.id)).size).toBe(4);
    });

    it('user sees the thinking state end as soon as tool arguments arrive', () => {
        projection.handleChunk({ content: '', reasoning: 'Need a tool', done: false });
        projection.handleChunk({
            content: '',
            done: false,
            toolCallDeltas: [
                {
                    index: 0,
                    callId: 'call-1',
                    name: 'builtin__bash',
                    argumentsBuffer: '',
                    isComplete: false,
                },
            ],
        });
        expect(snapshot.sessionHistory[snapshot.sessionHistory.length - 1]!.parts[0]).toMatchObject(
            {
                type: 'reasoning',
                content: 'Need a tool',
                isStreaming: false,
            }
        );
        projection.handleChunk({ content: '', reasoning: 'After the tool', done: false });
        expect(snapshot.sessionHistory[snapshot.sessionHistory.length - 1]!.parts).toMatchObject([
            { type: 'reasoning', content: 'Need a tool', isStreaming: false },
            { type: 'reasoning', content: 'After the tool', isStreaming: true },
        ]);
    });

    it('user sees a reasoning-only response finish without a lingering thinking indicator', () => {
        projection.handleChunk({ content: '', reasoning: 'Finished thinking', done: false });
        projection.handleChunk({ content: '', done: true });
        expect(snapshot.sessionHistory[snapshot.sessionHistory.length - 1]!.parts).toMatchObject([
            { type: 'reasoning', content: 'Finished thinking', isStreaming: false },
        ]);
    });

    it('user sees explicit reasoning rounds kept separate without intervening answer text', () => {
        projection.handleChunk({ content: '', done: false, reasoningState: 'start' });
        const id = snapshot.sessionHistory[1]!.parts[0]!.id;
        expect(snapshot.sessionHistory[1]!.parts[0]).toMatchObject({
            type: 'reasoning',
            content: '',
            isStreaming: true,
        });
        projection.handleChunk({ content: '', reasoning: 'One', done: false });
        projection.handleChunk({ content: '', done: false, reasoningState: 'end' });
        projection.handleChunk({ content: '', done: false, reasoningState: 'start' });
        projection.handleChunk({ content: '', reasoning: 'Two', done: false });
        expect(snapshot.sessionHistory[1]!.parts).toMatchObject([
            { id, type: 'reasoning', content: 'One', isStreaming: false },
            { type: 'reasoning', content: 'Two', isStreaming: true },
        ]);
    });

    it('user does not see an ended reasoning segment extended by a later done chunk', () => {
        const clock = vi.spyOn(Date, 'now');
        clock.mockReturnValue(1000);
        projection.handleChunk({ content: '', reasoning: 'Finished thinking', done: false });
        clock.mockReturnValue(3000);
        projection.handleChunk({ content: '', done: false, reasoningState: 'end' });
        clock.mockReturnValue(9000);
        projection.handleChunk({ content: '', done: true });
        expect(snapshot.sessionHistory[1]!.parts[0]).toMatchObject({
            startedAt: 1000,
            endedAt: 3000,
        });
        clock.mockRestore();
    });

    it('user sees empty reasoning placeholders discarded when the provider ends them', () => {
        projection.handleChunk({ content: '', done: false, reasoningState: 'start' });
        projection.handleChunk({ content: '', done: false, reasoningState: 'end' });
        expect(snapshot.sessionHistory[1]!.parts).toEqual([]);
    });

    it('user sees reasoning, text, tool, reasoning, answer order preserved', () => {
        projection.handleChunk({ content: '', reasoning: 'Plan', done: false });
        projection.handleChunk({ content: 'Checking', done: false });
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'Read',
                namespacedName: 'builtin__read',
                source: 'builtin',
                arguments: {},
            },
        });
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'Result',
                durationMs: 12,
                isError: false,
                finalStatus: 'completed',
            },
        });
        projection.handleChunk({ content: '', reasoning: 'Review', done: false });
        projection.handleChunk({ content: 'Answer', done: true });
        expect(snapshot.sessionHistory[1]!.parts).toMatchObject([
            { type: 'reasoning', content: 'Plan', isStreaming: false },
            { type: 'text', content: 'Checking' },
            { type: 'tool_call', toolCall: expect.objectContaining({ id: 'call-1' }) },
            { type: 'reasoning', content: 'Review', isStreaming: false },
            { type: 'text', content: 'Answer' },
        ]);
    });

    it.each(['completed', 'cancelled', 'failed'] as const)(
        'user sees active reasoning settled when the task is %s',
        (status) => {
            projection.handleChunk({ content: '', reasoning: 'Partial thought', done: false });
            if (status === 'completed') projection.markCompleted();
            else if (status === 'cancelled') projection.markCancelled();
            else projection.markFailed('Offline');
            expect(snapshot.status).toBe(status);
            expect(snapshot.sessionHistory[1]!.isStreaming).toBe(false);
            expect(snapshot.sessionHistory[1]!.parts).toMatchObject([
                { type: 'reasoning', content: 'Partial thought', isStreaming: false },
            ]);
        }
    );
});
