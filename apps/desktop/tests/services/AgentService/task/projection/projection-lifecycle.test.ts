import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import type { SessionMessage } from '@/types/session';

/**
 * The projection is what the user actually sees while a task runs: the streaming assistant
 * message, the live status, and the terminal state. A mistake here either loses the answer the
 * model produced or leaves a task looking like it is still running.
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

function assistantMessage(snapshot: SessionTaskSnapshot): SessionMessage | undefined {
    return snapshot.sessionHistory.find((message) => message.role === 'assistant');
}

beforeEach(() => {
    setLocale('en-US');
    let uuidIndex = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
        () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
    );
});

describe('user starts a task', () => {
    it('user gets their prompt kept in the history with its attachments', () => {
        const { snapshot, projection } = createProjection();

        projection.bootstrap([], 'Hello', [{ id: 'a1', name: 'notes.txt' } as never]);

        const userMessage = snapshot.sessionHistory[0]!;
        expect(userMessage).toMatchObject({ role: 'user', content: 'Hello' });
        expect(userMessage.attachments).toHaveLength(1);
    });

    it('user gets an assistant message ready to stream into', () => {
        const { snapshot, projection } = createProjection();

        projection.bootstrap([], 'Hello', []);

        expect(assistantMessage(snapshot)).toMatchObject({ role: 'assistant', isStreaming: true });
    });

    it('user gets the task marked running and the view notified', () => {
        const { snapshot, publish, projection } = createProjection();

        projection.bootstrap([], 'Hello', []);

        expect(snapshot.status).toBe('running');
        expect(publish).toHaveBeenCalled();
    });

    it('user gets the earlier history preserved', () => {
        const { snapshot, projection } = createProjection();
        const earlier: SessionMessage = {
            id: 'm1',
            role: 'user',
            content: 'Earlier',
            parts: [],
            timestamp: 1,
        };

        projection.bootstrap([earlier], 'Hello', []);

        expect(snapshot.sessionHistory[0]).toMatchObject({ content: 'Earlier' });
        expect(snapshot.sessionHistory).toHaveLength(3);
    });
});

describe('user watches the answer stream in', () => {
    it('user gets each content chunk appended to one text part', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({ content: 'Hel', done: false } as never);
        projection.handleChunk({ content: 'lo', done: false } as never);

        const message = assistantMessage(snapshot)!;
        expect(message.content).toBe('Hello');
        const textParts = message.parts.filter((part) => part.type === 'text');
        expect(textParts).toHaveLength(1);
        expect(textParts[0]).toMatchObject({ content: 'Hello' });
    });

    it('user gets the reasoning kept separate from the answer', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({ reasoning: 'thinking', done: false } as never);
        projection.handleChunk({ content: 'answer', done: false } as never);

        const message = assistantMessage(snapshot)!;
        expect(message.reasoning).toBe('thinking');
        expect(message.content).toBe('answer');
    });

    it('user gets a reasoning block closed when the answer starts', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({ reasoningState: 'start' } as never);
        projection.handleChunk({ reasoning: 'thinking', done: false } as never);
        projection.handleChunk({ content: 'answer', done: false } as never);

        const reasoningParts = assistantMessage(snapshot)!.parts.filter(
            (part) => part.type === 'reasoning'
        );
        expect(reasoningParts).toHaveLength(1);
        expect(reasoningParts[0]).toMatchObject({ content: 'thinking', isStreaming: false });
    });

    it('user gets an empty reasoning block dropped rather than left blank', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        // A start/end pair with no content is only a live placeholder.
        projection.handleChunk({ reasoningState: 'start' } as never);
        projection.handleChunk({ reasoningState: 'end' } as never);

        const reasoningParts = assistantMessage(snapshot)!.parts.filter(
            (part) => part.type === 'reasoning'
        );
        expect(reasoningParts).toHaveLength(0);
    });

    it('user gets nothing applied when no assistant message is active', () => {
        const { snapshot, projection } = createProjection();

        // Streaming before bootstrap must not throw or invent a message.
        expect(() => projection.handleChunk({ content: 'x', done: false } as never)).not.toThrow();
        expect(snapshot.sessionHistory).toHaveLength(0);
    });

    it('user gets the view notified for every chunk', () => {
        const { publish, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        publish.mockClear();

        projection.handleChunk({ content: 'a', done: false } as never);
        projection.handleChunk({ content: 'b', done: false } as never);

        expect(publish).toHaveBeenCalledTimes(2);
    });
});

describe('user watches a task end', () => {
    it('user gets the message marked finished when the task completes', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Done', done: false } as never);

        projection.markCompleted();

        expect(assistantMessage(snapshot)).toMatchObject({
            isStreaming: false,
            content: 'Done',
        });
        expect(snapshot.status).toBe('completed');
    });

    it('user keeps the partial answer when the task fails midway', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Partial answer', done: false } as never);

        projection.markFailed('provider exploded');

        // The partial answer is the only thing the user got; deleting it loses their work.
        const message = assistantMessage(snapshot)!;
        expect(message.content).toBe('Partial answer');
        expect(message.isStreaming).toBe(false);
        expect(snapshot.status).toBe('failed');
        expect(snapshot.error).toBe('provider exploded');
    });

    it('user gets the error attached when nothing was produced', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.markFailed('provider exploded');

        // The empty streaming message is dropped and one error status stands in its place, so
        // the user never sees an empty bubble beside the failure.
        const assistants = snapshot.sessionHistory.filter((m) => m.role === 'assistant');
        expect(assistants).toHaveLength(1);
        expect(assistants[0]!.content).toContain('provider exploded');
        expect(snapshot.sessionHistory).toHaveLength(2);
    });

    it('user gets a cancellation reported on the partial answer', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Partial', done: false } as never);

        projection.markCancelled();

        expect(snapshot.status).toBe('cancelled');
        expect(assistantMessage(snapshot)).toMatchObject({ content: 'Partial' });
    });

    it('user gets a standalone cancellation message when nothing was produced', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.markCancelled();

        const last = snapshot.sessionHistory[snapshot.sessionHistory.length - 1]!;
        expect(last).toMatchObject({ isCancelled: true });
    });

    it('user gets no cancellation bubble added to an empty history', () => {
        const { snapshot, projection } = createProjection();

        // Cancelling before bootstrap must not invent a conversation.
        projection.markCancelled();

        expect(snapshot.sessionHistory).toHaveLength(0);
        expect(snapshot.status).toBe('cancelled');
    });
});

describe('user gets task metadata synchronised', () => {
    it('user gets the session and model recorded when the task starts', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.syncTaskMetadata({
            type: 'task_started',
            taskId: 'task-1',
            sessionId: 42,
            turnId: 7,
            executionMode: 'foreground',
            model: { modelDbId: 1, providerId: 2, providerName: 'p', modelId: 'm', modelName: 'M' },
        } as never);

        expect(snapshot.sessionId).toBe(42);
        expect(snapshot.turnId).toBe(7);
        expect(snapshot.currentModel).toMatchObject({ modelId: 'm' });
    });

    it('user gets a stale error cleared when a new attempt starts', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        snapshot.error = 'old failure';

        projection.syncTaskMetadata({
            type: 'task_started',
            taskId: 'task-1',
            sessionId: 42,
            turnId: 7,
            executionMode: 'foreground',
            model: { modelDbId: 1, providerId: 2, providerName: 'p', modelId: 'm', modelName: 'M' },
        } as never);

        expect(snapshot.error).toBeNull();
    });

    it('user gets the prompt snapshot stored when it is ready', () => {
        const { snapshot, projection } = createProjection();

        projection.syncTaskMetadata({
            type: 'prompt_snapshot_ready',
            taskId: 'task-1',
            snapshot: { messages: [] },
        } as never);

        expect(snapshot.promptSnapshot).toEqual({ messages: [] });
    });

    it('user gets the last checkpoint stored', () => {
        const { snapshot, projection } = createProjection();

        projection.syncTaskMetadata({
            type: 'checkpoint_committed',
            taskId: 'task-1',
            checkpoint: { attempt: 1 },
        } as never);

        expect(snapshot.lastCheckpoint).toEqual({ attempt: 1 });
    });

    it('user gets a completion event ending the task', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.syncTaskMetadata({
            type: 'task_completed',
            taskId: 'task-1',
            turnId: 7,
            model: { modelDbId: 1, providerId: 2, providerName: 'p', modelId: 'm', modelName: 'M' },
            response: 'done',
            reasoning: '',
        } as never);

        expect(snapshot.status).toBe('completed');
        expect(snapshot.turnId).toBe(7);
    });

    it('user gets a failure event ending the task', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.syncTaskMetadata({
            type: 'task_failed',
            taskId: 'task-1',
            turnId: 7,
            error: 'boom',
        } as never);

        expect(snapshot.status).toBe('failed');
    });

    it('user gets a cancellation event ending the task', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.syncTaskMetadata({
            type: 'task_cancelled',
            taskId: 'task-1',
            turnId: 7,
        } as never);

        expect(snapshot.status).toBe('cancelled');
    });
});
