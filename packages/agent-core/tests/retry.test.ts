import { createAgent } from '@touchai/agent-core';
import { AiError, AiErrorCode, type AiStreamChunk } from '@touchai/models/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deferred, fixtureHost, text } from './fixtures';

afterEach(() => vi.useRealTimers());

function rateLimitedStream(): AsyncIterable<AiStreamChunk> {
    return {
        [Symbol.asyncIterator]: () => ({
            next: async () => {
                throw new AiError(AiErrorCode.RATE_LIMIT);
            },
        }),
    };
}

describe('given a temporary model request failure and a live task', () => {
    it.each([
        ['timeout', new AiError(AiErrorCode.TIMEOUT)],
        ['rate limit', new AiError(AiErrorCode.API_ERROR, { statusCode: 429 })],
        [
            'temporarily unavailable configuration',
            new AiError(AiErrorCode.INVALID_CONFIG, { statusCode: 503 }),
        ],
        ['wrapped upstream failure', { lastError: { statusCode: 503 } }],
    ])(
        'user receives the answer after a %s failure without starting another task',
        async (_label, error) => {
            vi.useFakeTimers();
            let failed = false;
            const fixture = fixtureHost({
                stream: async function* () {
                    if (!failed) {
                        failed = true;
                        throw error;
                    }
                    yield* text('answer after retry');
                },
            });
            const agent = createAgent(fixture.host);
            const task = agent.start({ prompt: 'authorized request' });
            try {
                await vi.runAllTimersAsync();
                expect((await task.completion).response).toBe('answer after retry');
                expect(fixture.requests).toHaveLength(2);
                expect(fixture.store.attempts).toHaveLength(1);
                expect(fixture.store.terminals.map((terminal) => terminal.status)).toEqual([
                    'completed',
                ]);
            } finally {
                await agent.dispose();
            }
        }
    );

    it('user cancels during retry backoff and no later model request starts', async () => {
        vi.useFakeTimers();
        const retrying = deferred<void>();
        const fixture = fixtureHost({
            stream: rateLimitedStream,
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'cancel a retry' });
        agent.subscribe(task.taskId, (event) => {
            if (event.type === 'retry_scheduled') retrying.resolve();
        });
        const cancelled = expect(task.completion).rejects.toMatchObject({
            code: 'REQUEST_CANCELLED',
        });
        try {
            await retrying.promise;
            expect(agent.cancel(task.taskId)).toBe(true);
            await cancelled;
            await vi.advanceTimersByTimeAsync(60_000);
            expect(fixture.requests).toHaveLength(1);
            expect(agent.getTask(task.taskId)?.status).toBe('cancelled');
        } finally {
            await agent.dispose();
        }
    });

    it('user gets a final failure after the existing five retries instead of an unbounded request loop', async () => {
        vi.useFakeTimers();
        const fixture = fixtureHost({
            stream: rateLimitedStream,
        });
        const agent = createAgent(fixture.host);
        const task = agent.start({ prompt: 'bounded retry' });
        const failure = expect(task.completion).rejects.toMatchObject({ code: 'RATE_LIMIT' });
        try {
            await vi.runAllTimersAsync();
            await failure;
            expect(fixture.requests).toHaveLength(6);
            expect(fixture.store.attempts).toHaveLength(5);
            expect(fixture.store.terminals.map((terminal) => terminal.status)).toEqual(['failed']);
        } finally {
            await agent.dispose();
        }
    });
});

describe('given a failure that retrying cannot authorize or confirm', () => {
    it.each([
        ['authentication', new AiError(AiErrorCode.UNAUTHORIZED)],
        ['invalid request', new AiError(AiErrorCode.API_ERROR, { statusCode: 400 })],
        ['unknown remote effect', { code: 'SIDE_EFFECT_UNCERTAIN' }],
    ])(
        'user sees the %s failure without a blind retry and can issue a following task',
        async (_label, error) => {
            let failed = false;
            const fixture = fixtureHost({
                stream: async function* () {
                    if (!failed) {
                        failed = true;
                        throw error;
                    }
                    yield* text('following authorized answer');
                },
            });
            const agent = createAgent(fixture.host);
            try {
                await expect(
                    agent.start({ prompt: 'failing request' }).completion
                ).rejects.toMatchObject({ code: error.code });
                expect(fixture.requests).toHaveLength(1);
                expect(fixture.store.attempts).toEqual([]);
                expect(
                    (await agent.start({ prompt: 'following request' }).completion).response
                ).toBe('following authorized answer');
            } finally {
                await agent.dispose();
            }
        }
    );
});
