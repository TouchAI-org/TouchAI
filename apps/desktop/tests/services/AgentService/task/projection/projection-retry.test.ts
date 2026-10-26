import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

/**
 * A retry either resumes from the last checkpoint or restarts the turn. Getting the scope wrong
 * either loses output the user already saw or shows the same text twice.
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

function retryEvent(overrides: Record<string, unknown> = {}) {
    return {
        type: 'request_retry',
        attempt: 2,
        maxRetries: 3,
        reason: 'network',
        retryScope: 'restart',
        resumeFromIteration: 0,
        discardVisibleOutputSinceCheckpoint: false,
        discardToolActivitySinceCheckpoint: false,
        ...overrides,
    };
}

beforeEach(() => {
    setLocale('en-US');
    let uuidIndex = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
        () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
    );
});

describe('user sees a retry after a failure', () => {
    it('user gets the retry reported with its attempt number', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Partial', done: false } as never);

        projection.handleChunk({ toolEvent: retryEvent() } as never);

        const retryNotice = snapshot.sessionHistory.find((m) => m.isRetrying);
        expect(retryNotice).toBeTruthy();
        expect(retryNotice!.content).toContain('2');
    });

    it('user gets the task back to running so the spinner keeps going', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({ toolEvent: retryEvent() } as never);

        expect(snapshot.status).toBe('running');
    });

    it('user keeps the partial answer when a restart does not discard it', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Partial', done: false } as never);

        projection.handleChunk({ toolEvent: retryEvent({ retryScope: 'restart' }) } as never);

        const assistant = snapshot.sessionHistory.find((m) => m.role === 'assistant')!;
        expect(assistant.content).toBe('Partial');
    });

    it('user gets a checkpoint retry resumed rather than restarted', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'First step', done: false } as never);
        // A committed checkpoint records what the user has seen so far.
        projection.syncTaskMetadata({
            type: 'checkpoint_committed',
            taskId: 'task-1',
            checkpoint: { attempt: 1, iteration: 1 },
        } as never);

        projection.handleChunk({
            toolEvent: retryEvent({ retryScope: 'checkpoint', resumeFromIteration: 1 }),
        } as never);

        expect(snapshot.status).toBe('running');
        const last = snapshot.sessionHistory[snapshot.sessionHistory.length - 1]!;
        expect(last).toMatchObject({ isRetrying: true });
    });

    it('user gets the output rolled back when the retry says it was discarded', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Before checkpoint', done: false } as never);
        projection.syncTaskMetadata({
            type: 'checkpoint_committed',
            taskId: 'task-1',
            checkpoint: { attempt: 1, iteration: 1 },
        } as never);
        projection.handleChunk({ content: ' after checkpoint', done: false } as never);

        projection.handleChunk({
            toolEvent: retryEvent({
                retryScope: 'checkpoint',
                resumeFromIteration: 1,
                discardVisibleOutputSinceCheckpoint: true,
            }),
        } as never);

        // The discarded output must not survive, or the user reads it twice.
        const assistant = snapshot.sessionHistory.find((m) => m.role === 'assistant')!;
        expect(assistant.content).toBe('Before checkpoint');
    });

    it('user keeps the output when the retry does not discard it', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Kept output', done: false } as never);
        projection.syncTaskMetadata({
            type: 'checkpoint_committed',
            taskId: 'task-1',
            checkpoint: { attempt: 1, iteration: 1 },
        } as never);

        projection.handleChunk({
            toolEvent: retryEvent({ retryScope: 'checkpoint', resumeFromIteration: 1 }),
        } as never);

        const assistant = snapshot.sessionHistory.find((m) => m.role === 'assistant')!;
        expect(assistant.content).toContain('Kept output');
    });

    it('user gets the answer started fresh after a restart retry', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Old attempt', done: false } as never);

        projection.handleChunk({ toolEvent: retryEvent({ retryScope: 'restart' }) } as never);
        projection.handleChunk({ content: 'New attempt', done: false } as never);

        const assistants = snapshot.sessionHistory.filter((m) => m.role === 'assistant');
        const latest = assistants[assistants.length - 1]!;
        // The retried answer must not be appended to the abandoned one.
        expect(latest.content).toBe('New attempt');
    });

    it('user gets the view notified when the retry is reported', () => {
        const { publish, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        publish.mockClear();

        projection.handleChunk({ toolEvent: retryEvent() } as never);

        expect(publish).toHaveBeenCalled();
    });
});

describe('user sees a failed attempt with partial output', () => {
    it('user keeps the reasoning the model produced before the failure', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ reasoning: 'thinking hard', done: false } as never);

        projection.markFailed('provider exploded');

        const assistant = snapshot.sessionHistory.find((m) => m.role === 'assistant')!;
        expect(assistant.reasoning).toBe('thinking hard');
    });

    it('user gets the partial answer marked finished so no spinner is left', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Partial', done: false } as never);

        projection.markFailed('provider exploded');

        const assistant = snapshot.sessionHistory.find((m) => m.role === 'assistant')!;
        expect(assistant.isStreaming).toBe(false);
    });

    it('user gets the failure reason shown next to the partial answer', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({ content: 'Partial', done: false } as never);

        projection.markFailed('provider exploded');

        // The failure text is attached as the message status rather than rewritten into the
        // answer, so the user keeps the model's words and reads the reason beside them.
        const assistant = snapshot.sessionHistory.find((m) => m.role === 'assistant')!;
        expect(assistant.statusText).toContain('provider exploded');
        expect(assistant.content).toBe('Partial');
    });
});
