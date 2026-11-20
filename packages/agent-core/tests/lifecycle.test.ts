import { createAgent } from '@touchai/agent-core';
import { AiError, AiErrorCode } from '@touchai/models/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred, fixtureHost, memoryPersistence, text, tools } from './fixtures';

afterEach(() => vi.useRealTimers());

describe('given instance-owned tasks and turn-frozen execution bindings', () => {
    it('user sees independent task results and cleanup when two hosts run concurrently', async () => {
        const left = fixtureHost({
            stream: async function* () {
                yield* text('left');
            },
        });
        const right = fixtureHost({
            stream: async function* () {
                yield* text('right');
            },
        });
        const first = createAgent(left.host);
        const second = createAgent(right.host);
        const a = first.start({ prompt: 'left request', conversationKey: 'same-local-key' });
        const b = second.start({ prompt: 'right request', conversationKey: 'same-local-key' });
        expect((await a.completion).response).toBe('left');
        expect((await b.completion).response).toBe('right');
        expect(first.getTask(a.taskId)?.status).toBe('completed');
        expect(second.getTask(a.taskId)).toBeNull();
        expect(left.leases).toEqual(['model-one']);
        expect(right.leases).toEqual(['model-one']);
        await first.dispose();
        await second.dispose();
    });

    it('user observes reasoning boundaries, ordered output and usage without a tool execution event becoming a model message', async () => {
        const fixture = fixtureHost({
            stream: async function* () {
                yield { content: '', reasoning: 'consider', reasoningState: 'start', done: false };
                yield { content: '', reasoningState: 'end', done: false };
                yield { content: 'answer', textState: 'start', done: false };
                yield {
                    content: '',
                    textState: 'end',
                    done: true,
                    finishReason: 'stop',
                    usage: {
                        inputTokens: 3,
                        outputTokens: 4,
                        cacheReadTokens: 1,
                        cacheWriteTokens: 0,
                        reasoningTokens: 2,
                    },
                    usageReported: true,
                };
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'question' });
        const result = await task.completion;
        expect(result.response).toBe('answer');
        expect(result.reasoning).toBe('consider');
        expect(fixture.store.terminals[0]?.outputParts.map((part) => part.type)).toEqual([
            'reasoning',
            'text',
        ]);
        expect(result.usage.outputTokens).toBe(4);
        expect(result.usage.reasoningTokens).toBe(2);
        expect(Object.keys(agent.getTask(task.taskId)!)).not.toEqual(
            expect.arrayContaining(['checkpoint', 'prompt', 'messages', 'apiKey'])
        );
        await agent.dispose();
    });

    it('user keeps advertised declarations and execution paired across an unlimited loop and applies edits only to a subsequent turn', async () => {
        let configuration = 'original';
        const fixture = fixtureHost({
            prepare: () => {
                const value = configuration;
                return {
                    tools: {
                        declarations: [
                            {
                                name: 'builtin__read',
                                description: value,
                                input_schema: { type: 'object', properties: {} },
                            },
                        ],
                        execute: async () => ({
                            result: value,
                            isError: false,
                            sideEffect: 'completed',
                        }),
                    },
                };
            },
            stream: async function* (request) {
                const round = request.messages.filter((message) => message.role === 'tool').length;
                if (round < 25) {
                    configuration = 'edited';
                    yield* tools();
                } else yield* text('finished');
            },
        });
        const agent = createAgent(fixture.host);
        await agent.start({ prompt: 'long task' }).completion;
        expect(fixture.requests.map((request) => request.tools?.[0]?.description)).toEqual(
            Array(26).fill('original')
        );
        expect(fixture.store.results.map((result) => result.result)).toEqual(
            Array(25).fill('original')
        );
        await agent.start({ prompt: 'next task' }).completion;
        expect(fixture.requests.at(-1)?.tools?.[0]?.description).toBe('edited');
        await agent.dispose();
    });

    it('user cannot start a second authoritative task in an occupied conversation', async () => {
        const waiting = deferred<void>();
        const release = deferred<void>();
        const fixture = fixtureHost({
            stream: async function* () {
                waiting.resolve();
                await release.promise;
                yield* text('finished');
            },
        });
        const agent = createAgent(fixture.host);
        const first = agent.start({ prompt: 'one', conversationKey: 'conversation' });
        await waiting.promise;
        expect(() => agent.start({ prompt: 'two', conversationKey: 'conversation' })).toThrow(
            'SESSION_ACTIVE_TASK_EXISTS'
        );
        release.resolve();
        await first.completion;
        expect(
            (await agent.start({ prompt: 'after', conversationKey: 'conversation' }).completion)
                .response
        ).toBe('finished');
        await agent.dispose();
    });

    it('user cannot start a second task in a newly committed conversation and can use it after completion', async () => {
        const entered = deferred<void>();
        const finished = deferred<void>();
        const fixture = fixtureHost({
            persistence: {
                ...memoryPersistence().persistence,
                start: async () => ({ conversationKey: 'new-conversation' }),
            },
            stream: async function* () {
                entered.resolve();
                await finished.promise;
                yield* text('finished');
            },
        });
        const agent = createAgent(fixture.host);
        const first = agent.start({ prompt: 'new conversation' });
        await entered.promise;
        try {
            expect(agent.getTask(first.taskId)?.conversationKey).toBe('new-conversation');
            expect(() =>
                agent.start({ prompt: 'conflicting request', conversationKey: 'new-conversation' })
            ).toThrow('SESSION_ACTIVE_TASK_EXISTS');
        } finally {
            finished.resolve();
            await first.completion;
        }
        expect(
            (
                await agent.start({ prompt: 'next request', conversationKey: 'new-conversation' })
                    .completion
            ).response
        ).toBe('finished');
        await agent.dispose();
    });

    it('user retries a newly committed session and keeps its model cache route for follow-ups without sharing another session', async () => {
        vi.useFakeTimers();
        let failed = false;
        const store = memoryPersistence();
        const fixture = fixtureHost({
            stream: async function* () {
                if (!failed) {
                    failed = true;
                    throw new AiError(AiErrorCode.RATE_LIMIT);
                }
                yield* text('stable session answer');
            },
        });
        const agent = createAgent({
            ...fixture.host,
            persistence: (request) => ({
                ...store.persistence,
                start: async () => ({
                    conversationKey: request.conversationKey ?? 'committed-session',
                }),
            }),
        });
        try {
            const task = agent.start({ prompt: 'new session' });
            await vi.runAllTimersAsync();
            await task.completion;
            await agent.start({ prompt: 'follow-up', conversationKey: 'committed-session' })
                .completion;
            await agent.start({ prompt: 'another session', conversationKey: 'other-session' })
                .completion;
            const keys = fixture.requests.map((request) => request.promptCacheKey);
            expect(keys[0]).toEqual(expect.any(String));
            expect(keys.slice(0, 3)).toEqual([keys[0], keys[0], keys[0]]);
            expect(keys[3]).not.toBe(keys[0]);
        } finally {
            await agent.dispose();
        }
    });

    it('user can cancel an uncooperative provider without retaining its task or accepting late output', async () => {
        vi.useFakeTimers();
        const entered = deferred<void>();
        const late = deferred<void>();
        const fixture = fixtureHost({
            stream: async function* () {
                entered.resolve();
                await late.promise;
                yield* text('late provider output');
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'question' });
        const content: string[] = [];
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'stream') content.push(event.chunk.content);
        });
        await entered.promise;
        agent.cancel(task.taskId);
        try {
            await vi.advanceTimersByTimeAsync(1);
            expect(agent.getTask(task.taskId)?.status).toBe('cancelled');
            expect(fixture.leases).toEqual(['model-one']);
        } finally {
            late.resolve();
            await task.completion.catch(() => undefined);
            await agent.dispose();
        }
        expect(content).toEqual([]);
        expect(fixture.store.terminals.map((terminal) => terminal.status)).toEqual(['cancelled']);
    });

    it('user keeps checkpoint provenance outside the provider transport', async () => {
        const fixture = fixtureHost({
            prepare: () => ({
                messages: [
                    {
                        role: 'user',
                        content: 'request',
                        origin: { key: 'opaque-message', order: 1, fingerprint: 'history-proof' },
                        summary: {
                            id: 'summary',
                            text: 'historical data',
                            firstKeptMessageKey: 'opaque-message',
                            systemMessageKeys: [],
                        },
                        summaryPartKey: 'opaque-summary',
                    },
                ],
            }),
            stream: async function* () {
                yield* text('answer');
            },
        });
        const agent = createAgent(fixture.host);
        await agent.start({ prompt: 'request' }).completion;
        expect(fixture.requests[0]?.messages).toEqual([{ role: 'user', content: 'request' }]);
        expect(Object.keys(fixture.requests[0]!)).not.toContain('connectionKey');
        await agent.dispose();
    });

    it('user stops only the active task through its scoped tool callback while task signals survive tool rounds', async () => {
        const taskSignals: AbortSignal[] = [];
        const effectSignals: AbortSignal[] = [];
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (request.messages.filter((message) => message.role === 'tool').length < 2)
                    yield* tools();
                else yield* text('must not finish after stop');
            },
            execute: async (_call, scope) => {
                taskSignals.push(scope.taskSignal);
                effectSignals.push(scope.signal);
                if (taskSignals.length === 2) scope.cancelTask();
                return { result: 'completed effect', isError: false, sideEffect: 'completed' };
            },
        });
        const unrelated = fixtureHost({
            stream: async function* () {
                yield* text('unrelated answer');
            },
        });
        const first = createAgent(fixture.host);
        const second = createAgent(unrelated.host);
        try {
            await expect(first.start({ prompt: 'two effects' }).completion).rejects.toMatchObject({
                code: 'REQUEST_CANCELLED',
            });
            expect(taskSignals[0]).toBe(taskSignals[1]);
            expect(taskSignals[0]?.aborted).toBe(true);
            expect(effectSignals[0]).not.toBe(effectSignals[1]);
            expect((await second.start({ prompt: 'independent task' }).completion).response).toBe(
                'unrelated answer'
            );
        } finally {
            await first.dispose();
            await second.dispose();
        }
    });
});

describe('given checkpoint and terminal persistence barriers', () => {
    it('user retains the existing bounded retry when a normalized API error carries a retryable HTTP status', async () => {
        vi.useFakeTimers();
        let unavailable = true;
        const fixture = fixtureHost({
            stream: async function* () {
                if (unavailable) {
                    unavailable = false;
                    throw new AiError(
                        AiErrorCode.API_ERROR,
                        { statusCode: 429 },
                        'fixture rate limit'
                    );
                }
                yield* text('after retry');
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'authorized request' });
        try {
            await vi.runAllTimersAsync();
            expect((await task.completion).response).toBe('after retry');
            expect(fixture.store.terminals.map((terminal) => terminal.status)).toEqual([
                'completed',
            ]);
        } finally {
            await agent.dispose();
        }
    });

    it('user does not see durable completion while its save is pending', async () => {
        const entered = deferred<void>();
        const saved = deferred<void>();
        const store = memoryPersistence();
        const fixture = fixtureHost({
            stream: async function* () {
                yield* text('answer');
            },
            persistence: {
                ...store.persistence,
                finish: async (terminal, scope) => {
                    entered.resolve();
                    await saved.promise;
                    await store.persistence.finish(terminal, scope);
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'question' });
        await entered.promise;
        expect(agent.getTask(task.taskId)?.status).toBe('running');
        expect(store.terminals).toEqual([]);
        saved.resolve();
        await task.completion;
        expect(agent.getTask(task.taskId)?.status).toBe('completed');
        await agent.dispose();
    });

    it('user sees a failed-save outcome rather than successful completion or automatic replay', async () => {
        const fixture = fixtureHost({
            stream: async function* () {
                yield* text('answer');
            },
            persistence: {
                ...memoryPersistence().persistence,
                finish: async () => {
                    throw new Error('fixture storage failure');
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'question' });
        await expect(task.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
        expect(agent.getTask(task.taskId)?.status).toBe('failed');
        expect(fixture.requests.map((request) => request.messages.at(-1)?.content)).toEqual([
            'question',
        ]);
        await agent.dispose();
    });

    it('user does not publish an uncommitted checkpoint after completed tools fail their save', async () => {
        const fixture = fixtureHost({
            stream: async function* () {
                yield* tools();
            },
            persistence: {
                ...memoryPersistence().persistence,
                checkpoint: async () => {
                    throw new Error('fixture checkpoint failure');
                },
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'perform an effect' });
        const observed: string[] = [];
        agent.subscribe(task.taskId, (event) => observed.push(event.type));
        await expect(task.completion).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' });
        expect(observed).not.toContain('checkpoint_committed');
        expect(fixture.requests).toHaveLength(1);
        await agent.dispose();
    });

    it('user keeps sibling effect outcomes when one concurrent tool fails and never blindly retries the round', async () => {
        const bothStarted = deferred<void>();
        let started = 0;
        const fixture = fixtureHost({
            stream: async function* () {
                yield* tools(['builtin__read', 'mcp__1__write']);
            },
            execute: async (call) => {
                if (++started === 2) bothStarted.resolve();
                await bothStarted.promise;
                if (call.name === 'mcp__1__write')
                    throw new Error('remote connection lost after sending effect');
                return { result: 'sibling completed', isError: false, sideEffect: 'completed' };
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'perform effects' });
        await expect(task.completion).rejects.toMatchObject({ code: 'SIDE_EFFECT_UNCERTAIN' });
        expect(
            fixture.store.results.map((result) => [result.call.name, result.sideEffect])
        ).toEqual([
            ['builtin__read', 'completed'],
            ['mcp__1__write', 'unknown'],
        ]);
        expect(fixture.requests).toHaveLength(1);
        expect(fixture.store.terminals[0]?.status).toBe('failed');
        await agent.dispose();
    });

    it('user resumes the last committed exchange after a model failure without executing its completed tool again', async () => {
        vi.useFakeTimers();
        let failed = false;
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (!request.messages.some((message) => message.role === 'tool')) yield* tools();
                else if (!failed) {
                    failed = true;
                    throw new AiError(AiErrorCode.RATE_LIMIT);
                } else yield* text('after retry');
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'perform effect' });
        await vi.runAllTimersAsync();
        expect((await task.completion).response).toBe('workingafter retry');
        expect(fixture.store.results.map((result) => result.result)).toEqual(['read result']);
        expect(
            fixture.requests
                .at(-1)
                ?.messages.filter((message) => message.role === 'tool')
                .map((message) => message.content)
        ).toEqual(['read result']);
        await agent.dispose();
    });
});
