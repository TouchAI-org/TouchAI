/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import { selectToolCalls } from '@/utils/session';

/**
 * Complements the other projection tests with the per-event arms the panel renders while a
 * tool round runs: result streaming, structured payloads, rejections, model switches, and
 * widget create/remove events.
 *
 * Why these matter: each one is a distinct thing the user watches appear (or not) in the
 * conversation, and a missed arm leaves a tool stuck on "running" forever.
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

/** Start a tool call the way the executor reports it before the tool runs. */
function startCall(
    projection: SessionTaskProjection,
    overrides: Record<string, unknown> = {}
): void {
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
            ...overrides,
        },
    } as never);
}

beforeEach(() => {
    setLocale('en-US');
    let uuidIndex = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
        () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
    );
});

describe('user watches a tool result stream in', () => {
    it('user sees the partial output appear while the tool is still running', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        startCall(projection);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: { type: 'result_delta', callId: 'call-1', result: 'partial output' },
        } as never);

        expect(selectToolCalls(assistantMessage(snapshot)!)[0]).toMatchObject({
            result: 'partial output',
        });
    });

    it('user sees the tool still running while only partial output has arrived', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        startCall(projection);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: { type: 'result_delta', callId: 'call-1', result: 'partial' },
        } as never);

        // A streamed delta is not a finished call.
        expect(selectToolCalls(assistantMessage(snapshot)!)[0]?.status).toBe('executing');
    });

    it('user sees the finished result replace the partial one', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        startCall(projection);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: { type: 'result_delta', callId: 'call-1', result: 'partial' },
        } as never);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'final output',
                isError: false,
                durationMs: 42,
                finalStatus: 'completed',
            },
        } as never);

        expect(selectToolCalls(assistantMessage(snapshot)!)[0]).toMatchObject({
            result: 'final output',
            status: 'completed',
            durationMs: 42,
        });
    });
});

describe('user sees extra data a tool produced', () => {
    it('user sees the search sources attached to the call', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        startCall(projection, { toolName: 'web_search', namespacedName: 'builtin__web_search' });

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'found 2',
                isError: false,
                durationMs: 10,
                finalStatus: 'completed',
                structuredPayload: {
                    kind: 'web_search_sources',
                    sources: [{ id: 's1', title: 'Docs', url: 'https://example.test' }],
                },
            },
        } as never);

        expect(selectToolCalls(assistantMessage(snapshot)!)[0]?.structuredPayload).toMatchObject({
            kind: 'web_search_sources',
        });
    });

    it('user sees the wording a built-in tool chose for the call', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        startCall(projection);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'done',
                isError: false,
                durationMs: 10,
                finalStatus: 'completed',
                builtinConversationSemantic: { action: 'run', target: 'dir' },
            },
        } as never);

        expect(
            selectToolCalls(assistantMessage(snapshot)!)[0]?.builtinConversationSemantic
        ).toEqual({
            action: 'run',
            target: 'dir',
        });
    });

    it('user sees a rejected call marked rejected rather than failed', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        startCall(projection);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'you said no',
                isError: false,
                durationMs: 5,
                finalStatus: 'rejected',
            },
        } as never);

        // A rejection is the user's decision, not a tool malfunction.
        expect(selectToolCalls(assistantMessage(snapshot)!)[0]).toMatchObject({
            status: 'rejected',
            result: 'you said no',
        });
    });

    it('user sees a failed call marked as an error', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        startCall(projection);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'command not found',
                isError: true,
                durationMs: 8,
                finalStatus: 'error',
            },
        } as never);

        expect(selectToolCalls(assistantMessage(snapshot)!)[0]).toMatchObject({
            status: 'error',
            isError: true,
            result: 'command not found',
        });
    });
});

describe('user watches the agent move to a stronger model', () => {
    it('user sees the panel report the model it moved to', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'model_switched',
                fromModel: {
                    providerId: 1,
                    providerName: 'P',
                    modelId: 'small',
                    modelName: 'Small',
                },
                toModel: { providerId: 1, providerName: 'P', modelId: 'large', modelName: 'Large' },
                restart: false,
            },
        } as never);

        expect(snapshot.currentModel).toMatchObject({ modelId: 'large' });
        expect(snapshot.modelSwitchCount).toBe(1);
    });

    it('user sees the switch count grow with each switch', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        const switched = (modelId: string) => ({
            content: '',
            done: false,
            toolEvent: {
                type: 'model_switched',
                fromModel: { providerId: 1, providerName: 'P', modelId: 'a', modelName: 'A' },
                toModel: { providerId: 1, providerName: 'P', modelId, modelName: modelId },
                restart: false,
            },
        });

        projection.handleChunk(switched('mid') as never);
        projection.handleChunk(switched('large') as never);

        expect(snapshot.modelSwitchCount).toBe(2);
        expect(snapshot.currentModel).toMatchObject({ modelId: 'large' });
    });
});

describe('user watches a widget appear and disappear', () => {
    it('user sees a generated widget added to the reply', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'widget_upsert',
                callId: 'call-1',
                widgetId: 'w1',
                title: 'Sales',
                description: 'by region',
                html: '<div>chart</div>',
                mode: 'render',
                phase: 'ready',
            },
        } as never);

        const widgets = assistantMessage(snapshot)?.widgets ?? [];
        expect(widgets[0]).toMatchObject({ widgetId: 'w1', title: 'Sales' });
    });

    it('user sees a removed widget disappear from the reply', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'widget_upsert',
                callId: 'call-1',
                widgetId: 'w1',
                title: 'Sales',
                html: '<div>chart</div>',
                mode: 'render',
                phase: 'ready',
            },
        } as never);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: { type: 'widget_remove', widgetId: 'w1' },
        } as never);

        expect(assistantMessage(snapshot)?.widgets ?? []).toHaveLength(0);
    });
});

describe('user watches the tool loop report its iterations', () => {
    it('user sees each round announced and closed', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: { type: 'iteration_start', iteration: 0 },
        } as never);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: { type: 'iteration_end', iteration: 0 },
        } as never);

        // The panel stays on the same reply; only its status follows the round.
        expect(snapshot.status).toBe('running');
        expect(assistantMessage(snapshot)).toBeDefined();
    });

    it('user keeps the reply usable after a round that produced nothing', () => {
        const { snapshot, projection } = createProjection();
        projection.bootstrap([], 'Hello', []);

        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: { type: 'iteration_start', iteration: 0 },
        } as never);
        projection.handleChunk({ content: 'Answer', done: false } as never);

        expect(assistantMessage(snapshot)?.content).toBe('Answer');
    });
});
