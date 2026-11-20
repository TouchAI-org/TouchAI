import { createAgent } from '@touchai/agent-core';
import type {
    AgentHost,
    AgentPersistence,
    AgentScope,
    AgentToolScope,
} from '@touchai/agent-core/contracts';
import type { AiStreamChunk } from '@touchai/models/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentSessions } from '@/modules/agent';
import type {
    AgentSessionHost,
    StartSessionTaskOptions,
    TaskViewSnapshot,
} from '@/modules/agent/contracts';

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const dispose of disposals.splice(0)) await dispose();
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

function fixture(
    options: {
        decisions?: 'approval' | 'question';
        saveFails?: boolean;
        subscriptionFails?: boolean;
    } = {}
) {
    const persisted: string[] = [];
    const saveBarrier = deferred<void>();
    const calls = new Map<string, number>();
    const model = {
        key: 'private-model-key',
        connectionKey: 'private-profile-key',
        model: 'fixture',
        contextLimit: 8192,
        outputLimit: 512,
        supportsReasoning: false,
        supportsTools: true,
    };
    const persistence: AgentPersistence = {
        start: async () => ({ conversationKey: 'session:1', turnKey: 'turn:1' }),
        progress: async () => {},
        toolCalls: async () => 'private-message-key',
        toolResult: async () => {},
        toolRoundSource: async () => undefined,
        checkpoint: async () => {},
        retry: async () => {},
        validateSummary: async () => {},
        saveSummary: async () => 'part',
        finish: async (terminal) => {
            if (terminal.status === 'completed') {
                await saveBarrier.promise;
                if (options.saveFails) throw new Error('fixture storage unavailable');
            }
            persisted.push(terminal.status);
        },
    };
    const host: AgentHost = {
        prepareTurn: async () => ({
            model,
            messages: [{ role: 'user', content: 'request' }],
            tools: {
                declarations: [
                    {
                        name: 'builtin__fixture',
                        description: '',
                        input_schema: { type: 'object', properties: {} },
                    },
                ],
                execute: async (call, scope: AgentToolScope) => {
                    const accepted =
                        options.decisions === 'approval'
                            ? await scope.approve(call.id, {
                                  title: 'Fixture approval',
                                  description: '',
                                  command: 'fixture effect',
                                  riskLabel: '',
                                  reason: '',
                                  commandLabel: '',
                                  approveLabel: 'Approve',
                                  rejectLabel: 'Reject',
                                  enterHint: 'Enter',
                                  escHint: 'Esc',
                              })
                            : await scope.ask(call.id, [
                                  {
                                      question: 'Choose',
                                      header: 'Choice',
                                      options: [{ label: 'First' }, { label: 'Second' }],
                                  },
                              ]);
                    return {
                        result: accepted ? 'accepted' : 'rejected',
                        isError: !accepted,
                        sideEffect: 'none',
                    };
                },
            },
            stream: async function* (_request, scope: AgentScope): AsyncGenerator<AiStreamChunk> {
                const previous = calls.get(scope.taskId) ?? 0;
                calls.set(scope.taskId, previous + 1);
                if (options.decisions && previous < 2)
                    yield {
                        content: '',
                        done: true,
                        finishReason: 'tool_calls',
                        toolCalls: [
                            { id: 'reused-call', name: 'builtin__fixture', arguments: '{}' },
                        ],
                    };
                else yield { content: 'saved answer', done: true, finishReason: 'stop' };
            },
            release: () => {},
        }),
        persistence: () => persistence,
    };
    const core = createAgent(host);
    const issued: string[] = [];
    const sessionHost: AgentSessionHost = {
        execution: {
            start: (input: StartSessionTaskOptions) => {
                const task = core.start({
                    prompt: input.prompt,
                    conversationKey: input.sessionId ? `session:${input.sessionId}` : undefined,
                    signal: input.signal,
                });
                issued.push(task.taskId);
                return task;
            },
            subscribe: core.subscribe,
            cancel: core.cancel,
            reply: core.reply,
        },
        beforeStart: async () => {},
        loadHistory: async () => [
            {
                id: 'past',
                role: 'assistant',
                content: 'committed history',
                parts: [{ id: 'past-text', type: 'text', content: 'committed history' }],
                timestamp: 1,
            },
        ],
        modelSummary: () => ({
            modelDbId: 1,
            providerId: 1,
            providerName: 'Fixture',
            modelId: 'fixture',
            modelName: 'Fixture',
        }),
        subscribePresentation: () => {
            if (options.subscriptionFails) throw new Error('fixture presentation unavailable');
            return () => {};
        },
        messages: {
            tt: (text, values) => text.replace('{error}', String(values?.error ?? '')),
            errorText: (code) => code,
            retryText: (attempt) => `Retry ${attempt}`,
        },
        tools: {
            resolveSemantic: () => null,
            presentation: () => null,
            widgetToolName: 'builtin__show_widget',
        },
    };
    const sessions = createAgentSessions(sessionHost);
    disposals.push(async () => {
        await sessions.dispose();
        await core.dispose();
    });
    return { sessions, core, persisted, saveBarrier, issued };
}

function nextView(
    sessions: ReturnType<typeof createAgentSessions>,
    taskId: string,
    accept: (snapshot: TaskViewSnapshot) => boolean
): Promise<TaskViewSnapshot> {
    const current = sessions.getTaskSnapshot(taskId);
    if (current && accept(current)) return Promise.resolve(current);
    return new Promise((resolve) => {
        const unsubscribe = sessions.subscribeTask(taskId, (snapshot: TaskViewSnapshot) => {
            if (!accept(snapshot)) return;
            unsubscribe();
            resolve(snapshot);
        });
    });
}

describe('given a Desktop session facade observes the real Core task owner', () => {
    it('user can detach and reattach a view while completion waits for committed history and exposes no private keys', async () => {
        const { sessions, core, persisted, saveBarrier } = fixture();
        const started = await sessions.startForegroundTask({ sessionId: 1, prompt: 'request' });
        const output = await nextView(sessions, started.taskId, (view) =>
            view.sessionHistory.some((message) => message.content === 'saved answer')
        );
        const unsubscribe = sessions.subscribeTask(started.taskId, () => {});
        unsubscribe();
        expect(core.getTask(started.taskId)?.status).toBe('running');
        expect(persisted).toEqual([]);
        expect(sessions.attachSessionView(1)?.snapshot.sessionHistory).toEqual(
            output.sessionHistory
        );
        expect(JSON.stringify(output)).not.toContain('private-');
        saveBarrier.resolve();
        expect(await started.completion).toMatchObject({
            response: 'saved answer',
            model: { modelName: 'Fixture' },
        });
        expect(persisted).toEqual(['completed']);
        expect(sessions.getTaskSnapshot(started.taskId)?.status).toBe('completed');
        expect(sessions.attachSessionView(1)).toBeNull();
    });

    it('user can settle only the captured approval once and an older reply cannot authorize a reused call', async () => {
        const { sessions, saveBarrier } = fixture({ decisions: 'approval' });
        const started = await sessions.startTask({ prompt: 'request' });
        const first = (
            await nextView(sessions, started.taskId, (view) => !!view.pendingToolApproval)
        ).pendingToolApproval!;
        expect(sessions.approveTaskToolCall(started.taskId, first.callId)).toBe(false);
        expect(sessions.approveTaskToolCall(started.taskId, first.callId, first.decisionId)).toBe(
            true
        );
        expect(sessions.approveTaskToolCall(started.taskId, first.callId, first.decisionId)).toBe(
            false
        );
        const second = (
            await nextView(
                sessions,
                started.taskId,
                (view) =>
                    !!view.pendingToolApproval &&
                    view.pendingToolApproval.decisionId !== first.decisionId
            )
        ).pendingToolApproval!;
        expect(sessions.rejectTaskToolCall(started.taskId, first.callId, first.decisionId)).toBe(
            false
        );
        expect(sessions.getTaskSnapshot(started.taskId)?.pendingToolApproval?.decisionId).toBe(
            second.decisionId
        );
        expect(sessions.rejectTaskToolCall(started.taskId, second.callId, second.decisionId)).toBe(
            true
        );
        saveBarrier.resolve();
        expect((await started.completion).response).toBe('saved answer');
    });

    it('user cancellation releases a Core-owned question and cannot settle a late answer through a retained view', async () => {
        const { sessions, persisted } = fixture({ decisions: 'question' });
        const started = await sessions.startBackgroundTask({ prompt: 'request' });
        const question = (
            await nextView(sessions, started.taskId, (view) => !!view.pendingUserQuestion)
        ).pendingUserQuestion!;
        expect(sessions.cancelTask(started.taskId)).toBe(true);
        await expect(started.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(persisted).toEqual(['cancelled']);
        expect(sessions.getTaskSnapshot(started.taskId)).toMatchObject({
            status: 'cancelled',
            pendingUserQuestion: null,
        });
        expect(
            sessions.settleTaskUserQuestion(
                started.taskId,
                question.callId,
                null,
                question.decisionId
            )
        ).toBe(false);
    });

    it('user receives failed-save state rather than an apparent successful terminal projection', async () => {
        const { sessions, persisted, saveBarrier } = fixture({ saveFails: true });
        const started = await sessions.startTask({ prompt: 'request' });
        saveBarrier.resolve();
        await expect(started.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
        expect(persisted).toEqual([]);
        expect(sessions.getTaskSnapshot(started.taskId)).toMatchObject({
            status: 'failed',
            error: 'PERSISTENCE_FAILED',
        });
    });

    it('user does not retain a hidden task when its presentation subscription cannot be established', async () => {
        const { sessions, core, issued, saveBarrier } = fixture({ subscriptionFails: true });
        await expect(sessions.startTask({ prompt: 'request' })).rejects.toThrow(
            'fixture presentation unavailable'
        );
        saveBarrier.resolve();
        const taskId = issued[0]!;
        await new Promise<void>((resolve) => {
            const stop = core.subscribe(taskId, (event) => {
                if (event.type !== 'task_cancelled' && event.type !== 'task_completed') return;
                queueMicrotask(() => stop());
                resolve();
            });
        });
        expect(core.getTask(taskId)?.status).toBe('cancelled');
        expect(sessions.getTaskSnapshot(taskId)).toBeNull();
        expect(sessions.listActiveTasks()).toEqual([]);
    });
});
