import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';

const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: vi.fn(() => providerMock),

    resolveToolDefinitions: vi.fn(() => Promise.resolve([])),

    getModel: vi.fn(),
}));

function createCheckpoint(): AttemptCheckpoint {
    return {
        activeModel: {
            id: 1,

            created_at: '',

            updated_at: '',

            provider_id: 12,

            model_id: 'mimo-v2.5',

            name: 'mimo-v2.5',

            is_default: 1,

            last_used_at: null,

            attachment: 0,

            modalities: null,

            open_weights: 0,

            reasoning: 0,

            release_date: null,

            temperature: 1,

            tool_call: 0,

            knowledge: null,

            context_limit: null,

            output_limit: null,

            is_custom_metadata: 0,

            provider_name: 'Xiaomi MiMo',

            provider_driver: 'mimo',

            api_endpoint: 'https://token-plan-cn.xiaomimimo.com/v1',

            api_key: 'ta_live_test',

            provider_config_json: null,

            provider_enabled: 1,

            provider_logo: '',
        },

        messages: [{ role: 'user', content: 'hello' }],

        response: '',

        reasoning: '',

        iteration: 0,

        modelSwitchCount: 0,

        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },

        executedBuiltInToolIds: [],
    };
}

describe('AiRequestExecutor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('does not periodically save active reasoning and flushes the completed fragment on failure', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });

        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Saved thought', done: false };
            await waiting;
            yield { content: '', reasoning: ' and continuation', done: false };
            throw new Error('connection interrupted');
        });
        providerMock.classifyError.mockReturnValue(new AiError(AiErrorCode.NETWORK_ERROR));
        const persistReasoningProgress = vi.fn().mockResolvedValue(undefined);
        const persistCheckpoint = vi.fn().mockResolvedValue(undefined);
        const attempt = new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { persistReasoningProgress, persistCheckpoint } as never,
        });
        await vi.advanceTimersByTimeAsync(10000);
        expect(persistReasoningProgress).not.toHaveBeenCalled();
        release();
        const result = await attempt;

        expect(result.type).toBe('failed');
        expect(persistReasoningProgress).toHaveBeenLastCalledWith(
            [
                {
                    content: 'Saved thought and continuation',
                    startedAt: 1000,
                    endedAt: 11000,
                    textOffset: 0,
                },
            ],
            11000
        );
        expect(persistCheckpoint).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('flushes each finished reasoning segment immediately and does not keep writing after it ends', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'First', done: false };
            yield { content: '', reasoningState: 'end', done: false };
            await waiting;
            yield { content: '', reasoningState: 'start', done: false };
            yield { content: '', reasoning: 'Second', done: false };
            yield { content: 'Answer', done: true };
        });
        const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
        const attempt = new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { persistOutputProgress } as never,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(persistOutputProgress).toHaveBeenCalledTimes(1);
        expect(persistOutputProgress).toHaveBeenLastCalledWith(
            [{ type: 'reasoning', content: 'First', startedAt: 1000, endedAt: 1000 }],
            1000
        );
        await vi.advanceTimersByTimeAsync(10000);
        expect(persistOutputProgress).toHaveBeenCalledTimes(1);
        release();
        const result = await attempt;
        expect(result.type).toBe('completed');
        expect(persistOutputProgress).toHaveBeenLastCalledWith(
            [
                { type: 'reasoning', content: 'First', startedAt: 1000, endedAt: 1000 },
                { type: 'reasoning', content: 'Second', startedAt: 11000, endedAt: 11000 },
                { type: 'text', content: 'Answer' },
            ],
            11000
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['completed', 'failed', 'cancelled'] as const)(
        'flushes answer text when the stream ends or is interrupted: %s',
        async (status) => {
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            let release!: () => void;
            const waiting = new Promise<void>((resolve) => {
                release = resolve;
            });
            const controller = new AbortController();
            providerMock.stream.mockImplementation(async function* () {
                yield { content: 'Partial answer', done: false };
                await waiting;
                if (status === 'cancelled') controller.abort();
                yield {
                    content: status === 'cancelled' ? '' : ' continued',
                    done: status === 'completed',
                };
                if (status === 'failed') throw new Error('connection interrupted');
            });
            providerMock.classifyError.mockReturnValue(
                new AiError(
                    status === 'cancelled'
                        ? AiErrorCode.REQUEST_CANCELLED
                        : AiErrorCode.NETWORK_ERROR
                )
            );
            const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
            const attempt = new AiRequestExecutor().runAttempt({
                startCheckpoint: createCheckpoint(),
                signal: controller.signal,
                persister: { persistOutputProgress } as never,
            });
            await vi.advanceTimersByTimeAsync(10000);
            expect(persistOutputProgress).not.toHaveBeenCalled();
            release();
            const result = await attempt;
            expect(result.type).toBe(status === 'completed' ? 'completed' : 'failed');
            expect(persistOutputProgress).toHaveBeenLastCalledWith(
                [
                    {
                        type: 'text',
                        content:
                            status === 'cancelled' ? 'Partial answer' : 'Partial answer continued',
                    },
                ],
                11000
            );
            expect(vi.getTimerCount()).toBe(0);
        }
    );

    it.each([
        'reasoning-start',
        'reasoning-delta',
        'text-end',
        'text-start',
        'tool-input',
    ] as const)(
        'saves completed text at the %s boundary without periodic writes',
        async (boundary) => {
            vi.useFakeTimers();
            vi.setSystemTime(1000);
            let release!: () => void;
            const waiting = new Promise<void>((resolve) => {
                release = resolve;
            });
            providerMock.stream.mockImplementation(async function* () {
                yield { content: 'Intro', done: false };
                if (boundary === 'reasoning-start') {
                    yield { content: '', reasoningState: 'start', done: false };
                } else if (boundary === 'reasoning-delta') {
                    yield { content: '', reasoning: 'Review', done: false };
                } else if (boundary === 'tool-input') {
                    yield { content: '', toolCallDeltas: [{ callId: 'call-1' }], done: false };
                } else {
                    yield {
                        content: '',
                        textState: boundary === 'text-end' ? 'end' : 'start',
                        done: false,
                    };
                }
                await waiting;
                yield { content: 'Answer', done: true };
            });
            const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
            const attempt = new AiRequestExecutor().runAttempt({
                startCheckpoint: createCheckpoint(),
                persister: { persistOutputProgress } as never,
            });
            await vi.advanceTimersByTimeAsync(10000);
            const boundaryWrites = [...persistOutputProgress.mock.calls];
            release();
            await attempt;
            expect(boundaryWrites).toEqual([[[{ type: 'text', content: 'Intro' }], 1000]]);
            expect(vi.getTimerCount()).toBe(0);
        }
    );

    it('saves the positions of reasoning rounds within answer text', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        let release!: () => void;
        const waiting = new Promise<void>((resolve) => {
            release = resolve;
        });
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Plan', done: false };
            yield { content: 'Intro', done: false };
            yield { content: '', reasoning: 'Review', done: false };
            await waiting;
            yield { content: 'Answer', done: true };
        });
        const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
        const attempt = new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { persistOutputProgress } as never,
        });
        // Both completed fragments are durable before the next reasoning finishes.
        await vi.advanceTimersByTimeAsync(0);
        expect(persistOutputProgress).toHaveBeenCalledTimes(2);
        expect(persistOutputProgress).toHaveBeenLastCalledWith(
            [
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 1000 },
                { type: 'text', content: 'Intro' },
            ],
            1000
        );
        vi.setSystemTime(6000);
        release();
        const result = await attempt;
        expect(result).toMatchObject({
            type: 'completed',
            finalStepResponse: 'IntroAnswer',
            finalStepReasoningSegments: [
                { content: 'Plan', textOffset: 0 },
                { content: 'Review', textOffset: 5 },
            ],
        });
        expect(persistOutputProgress).toHaveBeenLastCalledWith(
            [
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 1000 },
                { type: 'text', content: 'Intro' },
                { type: 'reasoning', content: 'Review', startedAt: 1000, endedAt: 6000 },
                { type: 'text', content: 'Answer' },
            ],
            6000
        );
    });

    it('keeps the original request error when provider error classification fails', async () => {
        const requestError = new Error(
            'error sending request for url (https://token-plan-cn.xiaomimimo.com/v1/chat/completions)'
        );
        providerMock.stream.mockImplementation(
            () =>
                ({
                    [Symbol.asyncIterator]() {
                        return {
                            next: async () => {
                                throw requestError;
                            },
                        };
                    },
                }) as AsyncIterable<unknown>
        );
        providerMock.classifyError.mockImplementation(() => {
            throw new TypeError('n is not a function');
        });

        const executor = new AiRequestExecutor();
        const result = await executor.runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {} as never,
        });

        expect(result.type).toBe('failed');
        if (result.type !== 'failed') {
            return;
        }
        expect(providerMock.classifyError).toHaveBeenCalledWith(requestError);
        expect(result.error.code).toBe(AiErrorCode.NETWORK_ERROR);
        expect(result.error.message).toBe(AiError.getMessage(AiErrorCode.NETWORK_ERROR));
        expect(result.error.cause).toBe(requestError);
        expect(result.error.details).toBe(requestError);
    });
});
