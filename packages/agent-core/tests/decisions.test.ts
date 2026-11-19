import { createAgent } from '@touchai/agent-core';
import type { AgentEvent, AgentToolScope } from '@touchai/agent-core/contracts';
import { AiError, AiErrorCode } from '@touchai/models/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred, fixtureHost, text, tools } from './fixtures';

afterEach(() => vi.useRealTimers());

describe('given Core-owned approvals and question waits scoped to one live attempt', () => {
    it('user sees one approval for duplicate callbacks and both callers receive the same decision', async () => {
        const entered = deferred<Extract<AgentEvent, { type: 'decision_required' }>>();
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (!request.messages.some((message) => message.role === 'tool')) yield* tools();
                else yield* text('decision recorded');
            },
            execute: async (call, scope) => {
                const first = scope.approve(call.id, { command: 'fixture' });
                const duplicate = scope.approve(call.id, { command: 'fixture' });
                return {
                    result: JSON.stringify(await Promise.all([first, duplicate])),
                    isError: false,
                    sideEffect: 'none',
                };
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'duplicate approval' });
        const decisions: string[] = [];
        agent.subscribe(task.taskId, (event) => {
            if (event.type !== 'decision_required') return;
            decisions.push(event.decisionId);
            entered.resolve(event);
        });
        try {
            const decision = await entered.promise;
            expect(agent.reply({ taskId: task.taskId, decisionId: '', value: true })).toBe(false);
            expect(
                agent.reply({ taskId: 'other-task', decisionId: decision.decisionId, value: true })
            ).toBe(false);
            expect(
                agent.reply({ taskId: task.taskId, decisionId: decision.decisionId, value: false })
            ).toBe(true);
            expect(
                agent.reply({ taskId: task.taskId, decisionId: decision.decisionId, value: true })
            ).toBe(false);
            await task.completion;
            expect(decisions).toEqual([decision.decisionId]);
            expect(fixture.store.results[0]?.result).toBe('[false,false]');
        } finally {
            await agent.dispose();
        }
    });

    it('user settles a live approval once and cannot submit a stale or duplicate reply', async () => {
        const entered = deferred<Extract<AgentEvent, { type: 'decision_required' }>>();
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (!request.messages.some((message) => message.role === 'tool')) yield* tools();
                else yield* text('approved');
            },
            execute: async (call, scope) => ({
                result: (await scope.approve(call.id, { command: 'fixture' }))
                    ? 'allowed'
                    : 'denied',
                isError: false,
                sideEffect: 'none',
            }),
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'question' });
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'decision_required') entered.resolve(event);
        });
        const event = await entered.promise;
        expect(agent.reply({ taskId: task.taskId, decisionId: 'stale', value: true })).toBe(false);
        expect(
            agent.reply({ taskId: task.taskId, decisionId: event.decisionId, value: true })
        ).toBe(true);
        expect(
            agent.reply({ taskId: task.taskId, decisionId: event.decisionId, value: false })
        ).toBe(false);
        await task.completion;
        expect(fixture.store.results[0]?.result).toBe('allowed');
        await agent.dispose();
    });

    it('user cannot approve a previous attempt or register a late callback after cancellation', async () => {
        const entered = deferred<Extract<AgentEvent, { type: 'decision_required' }>>();
        let previousScope: AgentToolScope | undefined;
        const fixture = fixtureHost({
            stream: async function* () {
                yield* tools();
            },
            execute: async (call, scope) => {
                previousScope = scope;
                await scope.approve(call.id, { command: 'fixture' });
                return { result: 'released', isError: true, sideEffect: 'none' };
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'question' });
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'decision_required') entered.resolve(event);
        });
        const event = await entered.promise;
        agent.cancel(task.taskId);
        await expect(task.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(
            agent.reply({ taskId: task.taskId, decisionId: event.decisionId, value: true })
        ).toBe(false);
        expect(await previousScope!.approve('late-call', { command: 'late' })).toBe(false);
        await agent.dispose();
    });

    it('user sees duplicate question registration as one wait and disposal releases every pending decision', async () => {
        const entered = deferred<void>();
        const fixture = fixtureHost({
            stream: async function* () {
                yield* tools();
            },
            execute: async (call, scope) => {
                const questions = [
                    { question: 'choose', options: [{ label: 'one' }, { label: 'two' }] },
                ];
                const first = scope.ask(call.id, questions);
                const duplicate = scope.ask(call.id, questions);
                entered.resolve();
                expect(await first).toBeNull();
                expect(await duplicate).toBeNull();
                return { result: 'released', isError: true, sideEffect: 'none' };
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'question' });
        const questions: string[] = [];
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'decision_required') questions.push(event.decisionId);
        });
        await entered.promise;
        await agent.dispose();
        await expect(task.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(new Set(questions).size).toBe(1);
        expect(agent.getTask(task.taskId)).toBeNull();
    });

    it('user cannot authorize a reused call with an old decision or register a late callback during retry backoff', async () => {
        vi.useFakeTimers();
        const retrying = deferred<void>();
        const issued = [
            deferred<Extract<AgentEvent, { type: 'decision_required' }>>(),
            deferred<Extract<AgentEvent, { type: 'decision_required' }>>(),
        ];
        const scopes: AgentToolScope[] = [];
        let resumedCall = false;
        const fixture = fixtureHost({
            stream: async function* (request, scope) {
                if (!request.messages.some((message) => message.role === 'tool')) yield* tools();
                else if (scope.attemptGeneration === 1) throw new AiError(AiErrorCode.RATE_LIMIT);
                else if (!resumedCall) {
                    resumedCall = true;
                    yield* tools();
                } else yield* text('both live decisions recorded');
            },
            execute: async (call, scope) => {
                scopes.push(scope);
                return {
                    result: (await scope.approve(call.id, { command: 'fixture' }))
                        ? 'allowed'
                        : 'denied',
                    isError: false,
                    sideEffect: 'none',
                };
            },
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'retry with a reused call' });
        let decisionIndex = 0;
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'decision_required') issued[decisionIndex++]?.resolve(event);
            if (event.type === 'retry_scheduled') retrying.resolve();
        });
        try {
            const first = await issued[0]!.promise;
            expect(
                agent.reply({ taskId: task.taskId, decisionId: first.decisionId, value: true })
            ).toBe(true);
            await retrying.promise;
            expect(await scopes[0]!.approve('late-call', { command: 'late' })).toBe(false);
            expect(
                await scopes[0]!.ask('late-question', [
                    { question: 'Late?', options: [{ label: 'No' }] },
                ])
            ).toBeNull();
            await vi.advanceTimersByTimeAsync(600);
            const second = await issued[1]!.promise;
            expect(second.callId).toBe(first.callId);
            expect(second.decisionId).not.toBe(first.decisionId);
            expect(
                agent.reply({ taskId: task.taskId, decisionId: first.decisionId, value: true })
            ).toBe(false);
            expect(
                agent.reply({ taskId: task.taskId, decisionId: second.decisionId, value: false })
            ).toBe(true);
            await task.completion;
            expect(fixture.store.results.map((result) => result.result)).toEqual([
                'allowed',
                'denied',
            ]);
            expect(await scopes[1]!.approve('after-completion', { command: 'late' })).toBe(false);
            expect(
                await scopes[1]!.ask('after-completion', [
                    { question: 'Late?', options: [{ label: 'No' }] },
                ])
            ).toBeNull();
        } finally {
            await agent.dispose();
        }
    });

    it('user cancels one task and releases its approval and question without settling another task', async () => {
        const waiting = deferred<void>();
        const answers: unknown[][] = [];
        const fixture = fixtureHost({
            stream: async function* () {
                yield* tools();
            },
            execute: async (call, scope) => {
                const approval = scope.approve(call.id, { command: 'fixture' });
                const question = scope.ask(call.id, [
                    { question: 'Choose', options: [{ label: 'One' }] },
                ]);
                const resolved = await Promise.all([approval, question]);
                answers.push(resolved);
                return { result: JSON.stringify(resolved), isError: false, sideEffect: 'none' };
            },
        });
        const agent = createAgent(fixture.host);
        const first = agent.start({ prompt: 'first' });
        const second = agent.start({ prompt: 'second' });
        const decisions: Extract<AgentEvent, { type: 'decision_required' }>[] = [];
        for (const task of [first, second])
            agent.subscribe(task.taskId, (event) => {
                if (event.type !== 'decision_required') return;
                decisions.push(event);
                if (decisions.length === 4) waiting.resolve();
            });
        try {
            await waiting.promise;
            agent.cancel(first.taskId);
            await expect(first.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect(answers).toEqual([[false, null]]);
            expect(agent.getTask(second.taskId)?.status).toBe('waiting_approval');
            for (const decision of decisions.filter((event) => event.taskId === first.taskId)) {
                expect(
                    agent.reply({
                        taskId: first.taskId,
                        decisionId: decision.decisionId,
                        value: true,
                    })
                ).toBe(false);
            }
            agent.cancel(second.taskId);
            await expect(second.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
            expect(answers).toEqual([
                [false, null],
                [false, null],
            ]);
        } finally {
            await agent.dispose();
        }
    });

    it('user can answer every live question in a large concurrent round without an added execution limit', async () => {
        const names = Array.from({ length: 260 }, (_, index) => `mcp__1__question_${index}`);
        const fixture = fixtureHost({
            stream: async function* (request) {
                if (!request.messages.some((message) => message.role === 'tool'))
                    yield* tools(names);
                else yield* text('all questions answered');
            },
            execute: async (call, scope) => ({
                result: (await scope.ask(call.id, [
                    { question: 'choose', options: [{ label: 'one' }] },
                ]))
                    ? 'answered'
                    : 'rejected',
                isError: false,
                sideEffect: 'none',
            }),
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'answer questions' });
        const entered = deferred<void>();
        const pending: Extract<AgentEvent, { type: 'decision_required' }>[] = [];
        agent.subscribe(task.taskId, (event) => {
            if (event.type !== 'decision_required') return;
            pending.push(event);
            if (pending.length === names.length) entered.resolve();
        });
        // Flush the synchronous round before answering, so all decisions coexist.
        await Promise.race([
            entered.promise,
            new Promise<void>((resolve) => setTimeout(resolve, 0)),
        ]);
        try {
            expect(pending).toHaveLength(names.length);
            for (const event of pending)
                expect(
                    agent.reply({
                        taskId: task.taskId,
                        decisionId: event.decisionId,
                        value: [{ questionIndex: 0, selectedLabels: ['one'], skipped: false }],
                    })
                ).toBe(true);
            expect((await task.completion).response).toBe('workingall questions answered');
            expect(fixture.store.results.every((result) => result.result === 'answered')).toBe(
                true
            );
        } finally {
            await agent.dispose();
        }
    });
});
