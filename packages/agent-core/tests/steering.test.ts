import { createAgent } from '@touchai/agent-core';
import { AgentError } from '@touchai/agent-core/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred, fixtureHost, memoryPersistence, text, tools } from './fixtures';

afterEach(() => vi.useRealTimers());

describe('given pending user messages during a running turn', () => {
    it('user interrupts an answer when the remote iterator ignores return then its request aborts before the next live request starts', async () => {
        let immediate = false;
        let interruptedSignal: AbortSignal | undefined;
        const nextRound: boolean[] = [];
        const returning = deferred<IteratorResult<{ content: string; done: boolean }>>();
        const fixture = fixtureHost({
            persistence: { ...memoryPersistence().persistence, assistant: async () => undefined },
            stream: async function* () {},
            prepare: () => ({
                pendingMessages: {
                    hasImmediate: () => immediate,
                    deliver: async () => {
                        immediate = false;
                        return { messages: [{ role: 'user', content: 'Steer this' }] };
                    },
                },
                stream: (request, scope) => {
                    if (!interruptedSignal) {
                        interruptedSignal = request.signal;
                        return {
                            [Symbol.asyncIterator]: () => ({
                                next: async () => ({
                                    done: false,
                                    value: { content: 'Partial', done: false },
                                }),
                                return: () => returning.promise,
                            }),
                        };
                    }
                    nextRound.push(
                        interruptedSignal.aborted,
                        request.signal!.aborted,
                        scope.signal.aborted
                    );
                    return (async function* () {
                        yield* text('Done');
                    })();
                },
            }),
        });
        const agent = createAgent(fixture.host);
        try {
            const task = agent.start({ prompt: 'First' });
            agent.subscribe(task.taskId, (event) => {
                if (event.type === 'stream' && event.chunk.content === 'Partial') immediate = true;
            });
            expect((await task.completion).response).toBe('PartialDone');
            expect(nextRound).toEqual([true, false, false]);
        } finally {
            returning.resolve({ done: true, value: undefined });
            await agent.dispose();
        }
    });

    it('user has no immediate steer when an answer streams then every chunk completes without delivery', async () => {
        const deliver = vi.fn(async () => ({ messages: [] }));
        const fixture = fixtureHost({
            prepare: () => ({ pendingMessages: { hasImmediate: () => false, deliver } }),
            stream: async function* () {
                yield { content: 'First', done: false };
                yield { content: ' second', done: false };
                yield { content: ' third', done: true };
            },
        });
        const agent = createAgent(fixture.host);
        try {
            const task = agent.start({ prompt: 'First' });
            expect((await task.completion).response).toBe('First second third');
            expect(deliver).not.toHaveBeenCalled();
            expect(fixture.requests).toHaveLength(1);
        } finally {
            await agent.dispose();
        }
    });
    it('user steers during an answer and the next request follows the saved partial answer with the new input', async () => {
        const store = memoryPersistence();
        const saved: unknown[] = [];
        let immediate = false;
        let round = 0;
        const fixture = fixtureHost({
            persistence: {
                ...store.persistence,
                assistant: async (parts) => {
                    saved.push(structuredClone(parts));
                    return { key: 'partial', order: 1, fingerprint: 'partial-hash' };
                },
            },
            prepare: () => ({
                pendingMessages: {
                    hasImmediate: () => immediate,
                    deliver: async () => {
                        immediate = false;
                        return { messages: [{ role: 'user', content: 'Steer this' }] };
                    },
                },
            }),
            stream: async function* () {
                if (++round === 1) {
                    yield { content: 'Partial answer', done: false };
                    yield { content: ' never reached', done: true };
                } else yield* text('Done');
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'First' });
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'stream' && event.chunk.content === 'Partial answer')
                immediate = true;
        });
        try {
            expect((await task.completion).response).toBe('Partial answerDone');
            expect(saved).toEqual([[{ type: 'text', content: 'Partial answer' }]]);
            expect(fixture.requests[1]?.messages.slice(-2)).toEqual([
                { role: 'assistant', content: [{ type: 'text', text: 'Partial answer' }] },
                { role: 'user', content: 'Steer this' },
            ]);
            expect(store.terminals[0]?.outputParts).toEqual([{ type: 'text', content: 'Done' }]);
        } finally {
            await agent.dispose();
        }
    });

    it('user steers after tool streaming begins and delivery waits for the full call and every sibling result', async () => {
        const sibling = deferred<void>();
        const entered = deferred<void>();
        const delivered = deferred<void>();
        let immediate = false;
        let round = 0;
        const fixture = fixtureHost({
            prepare: () => ({
                pendingMessages: {
                    hasImmediate: () => immediate,
                    deliver: async () => {
                        immediate = false;
                        delivered.resolve();
                        return { messages: [{ role: 'user', content: 'Steer this' }] };
                    },
                },
            }),
            stream: async function* () {
                if (++round === 1) {
                    yield {
                        content: '',
                        done: false,
                        toolCallDeltas: [
                            {
                                index: 0,
                                callId: 'call-0',
                                name: 'builtin__read',
                                argumentsBuffer: '{}',
                                isComplete: false,
                            },
                        ],
                    };
                    immediate = true;
                    yield { content: '', done: false, reasoningState: 'end' };
                    yield* tools(['builtin__read', 'builtin__read']);
                } else yield* text('Done');
            },
            execute: async (call) => {
                if (call.id === 'call-1') {
                    entered.resolve();
                    await sibling.promise;
                }
                return { result: call.id, isError: false, sideEffect: 'completed' };
            },
        });
        const agent = createAgent(fixture.host);
        try {
            const task = agent.start({ prompt: 'First' });
            await entered.promise;
            expect(fixture.requests).toHaveLength(1);
            sibling.resolve();
            await task.completion;
            await delivered.promise;
            expect(fixture.requests[1]?.messages.slice(-3)).toMatchObject([
                { role: 'tool', content: 'call-0' },
                { role: 'tool', content: 'call-1' },
                { role: 'user', content: 'Steer this' },
            ]);
        } finally {
            sibling.resolve();
            await agent.dispose();
        }
    });

    it.each(['answer', 'tool round'] as const)(
        'user retries after inserting a skill during an %s then receives private context without leaking it into saved checkpoints or events',
        async (boundary) => {
            vi.useFakeTimers();
            const store = memoryPersistence();
            const privateContent = 'PRIVATE_STEER_SKILL\n\nSteer this';
            const events: unknown[] = [];
            let immediate = false;
            let round = 0;
            const fixture = fixtureHost({
                persistence: { ...store.persistence, assistant: async () => undefined },
                prepare: () => ({
                    pendingMessages: {
                        hasImmediate: () => immediate,
                        deliver: async () => {
                            immediate = false;
                            return {
                                messages: [{ role: 'user', content: 'Steer this' }],
                                privateContents: [{ index: 0, content: privateContent }],
                            };
                        },
                    },
                }),
                stream: async function* () {
                    round++;
                    if (round === 1) {
                        if (boundary === 'tool round') yield* tools();
                        else {
                            yield { content: 'Partial', done: false };
                            yield { content: ' never reached', done: true };
                        }
                    } else if (round === 2) throw new AgentError('NETWORK_ERROR', true);
                    else yield* text('Done');
                },
            });
            const agent = createAgent(fixture.host);
            try {
                const task = agent.start({ prompt: 'First' });
                agent.subscribe(task.taskId, (event) => {
                    events.push(event);
                    if (event.type === 'stream' && event.chunk.content === 'Partial')
                        immediate = true;
                });
                await vi.advanceTimersByTimeAsync(30_000);
                expect((await task.completion).response).toBe(
                    boundary === 'tool round' ? 'workingDone' : 'PartialDone'
                );
                expect(fixture.requests.at(-1)?.messages.at(-1)?.content).toBe(privateContent);
                expect(JSON.stringify([...store.checkpoints, ...events])).not.toContain(
                    'PRIVATE_STEER_SKILL'
                );
                expect(store.checkpoints[0]?.messages.at(-1)?.content).toBe('Steer this');
            } finally {
                await agent.dispose();
            }
        }
    );
});
