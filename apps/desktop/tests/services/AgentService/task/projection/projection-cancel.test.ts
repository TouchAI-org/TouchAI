/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import { selectToolCalls } from '@/utils/session';

/**
 * These cover the states the panel shows while a task is being retried, cancelled, or
 * carrying only tool activity: the paths where a mistake leaves the user staring at a
 * spinner or loses the work the model already produced.
 */
function createSnapshot(): SessionTaskSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
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
    };
}

function createProjection() {
    const snapshot = createSnapshot();
    const publish = vi.fn();
    return { snapshot, publish, projection: new SessionTaskProjection(snapshot, publish) };
}

function assistantMessage(snapshot: SessionTaskSnapshot) {
    return snapshot.sessionHistory.find((message) => message.role === 'assistant');
}

beforeEach(() => {
    setLocale('en-US');
    let uuidIndex = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
        () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
    );
});

describe('user watches a task being retried', () => {
    it('user sees the task kept running while the retry waits', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.syncTaskMetadata({
            type: 'retry_scheduled',
            taskId: 'task-1',
            attempt: 1,
            maxRetries: 3,
            reason: 'offline',
            checkpoint: { attempt: 1 },
        } as never);

        expect(snapshot.status).toBe('running');
        expect(snapshot.lastCheckpoint).toEqual({ attempt: 1 });
    });

    it('user sees the task marked completed when the retry finally succeeds', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Done', done: false } as never);

        projection.syncTaskMetadata({
            type: 'task_completed',
            taskId: 'task-1',
            turnId: 9,
            model: { modelDbId: 1, providerId: 2, providerName: 'p', modelId: 'm', modelName: 'M' },
            response: 'Done',
            reasoning: '',
        } as never);

        expect(snapshot.status).toBe('completed');
        expect(snapshot.turnId).toBe(9);
        expect(assistantMessage(snapshot)).toMatchObject({ isStreaming: false, content: 'Done' });
    });
});

describe('user watches a task that is only running tools', () => {
    it('user sees a running tool call marked cancelled when they stop the task', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'bash',
                namespacedName: 'builtin__bash',
                source: 'builtin',
                startedAt: 1,
                arguments: { command: 'dir' },
            },
        } as never);

        projection.markCancelled();

        const toolCall = selectToolCalls(assistantMessage(snapshot)!)[0];
        expect(toolCall).toMatchObject({
            id: 'call-1',
            status: 'cancelled',
            isError: false,
        });
        expect(toolCall?.result).toBeTruthy();
    });

    it('user sees a finished tool call left alone when they stop the task', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'bash',
                namespacedName: 'builtin__bash',
                source: 'builtin',
                startedAt: 1,
                arguments: { command: 'dir' },
            },
        } as never);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'file.txt',
                isError: false,
                durationMs: 10,
                finalStatus: 'completed',
            },
        } as never);

        projection.markCancelled();

        // Work that already finished keeps its real result, not a cancellation notice.
        expect(selectToolCalls(assistantMessage(snapshot)!)[0]).toMatchObject({
            status: 'completed',
            result: 'file.txt',
        });
    });

    it('user sees the tool activity kept as visible content when the task is cancelled', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'bash',
                namespacedName: 'builtin__bash',
                source: 'builtin',
                startedAt: 1,
                arguments: { command: 'dir' },
            },
        } as never);

        projection.markCancelled();

        // The reply is kept because a tool call is something the user can see.
        expect(assistantMessage(snapshot)).toBeDefined();
        expect(assistantMessage(snapshot)?.isStreaming).toBe(false);
    });

    it('user sees the reason the tool stopped kept on the call', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'bash',
                namespacedName: 'builtin__bash',
                source: 'builtin',
                startedAt: 1,
                arguments: { command: 'dir' },
            },
        } as never);

        projection.markCancelled();

        // The call shows why it stopped rather than an empty result.
        expect(selectToolCalls(assistantMessage(snapshot)!)[0]?.result).toContain('cancel');
    });
});

describe('user cancels a task that produced only a tool call', () => {
    it('user sees the cancellation note added beside the tool activity', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'bash',
                namespacedName: 'builtin__bash',
                source: 'builtin',
                startedAt: 1,
                arguments: { command: 'dir' },
            },
        } as never);

        projection.markCancelled();

        expect(snapshot.status).toBe('cancelled');
        expect(assistantMessage(snapshot)?.statusText).toBeTruthy();
    });

    it('user sees no empty reply left behind when nothing had streamed', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.markCancelled();

        // An empty streaming bubble would look like a broken answer, so it is replaced
        // by a plain cancellation notice.
        const streaming = snapshot.sessionHistory.filter(
            (message) => message.role === 'assistant' && message.isStreaming
        );
        expect(streaming).toHaveLength(0);
        const lastMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(lastMessage).toMatchObject({
            role: 'assistant',
            isCancelled: true,
        });
    });
});
