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
        outputParts: [],

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

    it('requests the highest reasoning effort even when model metadata disables reasoning', async () => {
        providerMock.stream.mockImplementation(async function* () {
            yield { content: 'Done', done: true };
        });

        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {} as never,
        });

        expect(outcome.type).toBe('completed');
        expect(providerMock.stream).toHaveBeenCalledWith(
            expect.objectContaining({ reasoningEffort: 'max' })
        );
    });

    it('uses the active OpenAI model capability when resolving reasoning effort', async () => {
        providerMock.stream.mockImplementation(async function* () {
            yield { content: 'Done', done: true };
        });
        const checkpoint = createCheckpoint();
        checkpoint.activeModel.provider_driver = 'openai';
        checkpoint.activeModel.provider_name = 'OpenAI';
        checkpoint.activeModel.model_id = 'gpt-5.1';
        checkpoint.activeModel.name = 'gpt-5.1';

        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: checkpoint,
            persister: {} as never,
        });

        expect(outcome.type).toBe('completed');
        expect(providerMock.stream).toHaveBeenCalledWith(
            expect.objectContaining({ reasoningEffort: 'high' })
        );
    });

    it('returns the failed stream fragments with their wall-clock boundaries without persisting a snapshot', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Plan', done: false };
            vi.setSystemTime(6000);
            yield { content: 'Answer', done: false };
            throw new Error('connection interrupted');
        });
        providerMock.classifyError.mockReturnValue(new AiError(AiErrorCode.NETWORK_ERROR));
        const persistCheckpoint = vi.fn().mockResolvedValue(undefined);
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {
                persistCheckpoint,
                persistOutputProgress: vi.fn().mockResolvedValue(undefined),
            } as never,
        });
        expect(result).toMatchObject({
            type: 'failed',
            partialOutputParts: [
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
                { type: 'text', content: 'Answer' },
            ],
        });
        expect(persistCheckpoint).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('persists the reasoning start before waiting for the next stream event', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoningState: 'start', done: false };
            await Promise.resolve();
            await Promise.resolve();
            expect(persistOutputProgress).toHaveBeenCalledWith([
                { type: 'reasoning', content: '', startedAt: 1000 },
            ]);
            vi.setSystemTime(6000);
            yield { content: '', reasoning: 'Plan', done: false };
            yield { content: 'Answer', done: true };
        });
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { persistOutputProgress } as never,
        });
        expect(outcome.type).toBe('completed');
        expect(persistOutputProgress).toHaveBeenLastCalledWith([
            { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
            { type: 'text', content: 'Answer' },
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('persists completed output fragments without a timer or an attempt snapshot', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Plan', done: false };
            vi.setSystemTime(6000);
            yield { content: 'Answer', done: false };
            // The completed reasoning fragment must survive before the reply finishes.
            await Promise.resolve();
            expect(persistOutputProgress).toHaveBeenCalledWith([
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
            ]);
            yield { content: ' complete', textState: 'end', done: false };
            yield { content: '', done: true };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { persistOutputProgress } as never,
        });
        expect(result.type).toBe('completed');
        expect(persistOutputProgress).toHaveBeenLastCalledWith([
            { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
            { type: 'text', content: 'Answer complete' },
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('preserves interleaved output order in the next live tool-loop request', async () => {
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield { content: '', reasoning: 'Plan', done: false };
                yield { content: 'First answer', done: false };
                yield { content: '', reasoning: 'Review', done: false };
                yield { content: 'Second answer', done: false };
                yield {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'call-1', name: 'test', arguments: '{' }],
                };
            })
            .mockImplementationOnce(async function* (request) {
                expect(request.messages[1]).toEqual({
                    role: 'assistant',
                    content: [
                        { type: 'reasoning', text: 'Plan' },
                        { type: 'text', text: 'First answer' },
                        { type: 'reasoning', text: 'Review' },
                        { type: 'text', text: 'Second answer' },
                    ],
                    tool_calls: [{ id: 'call-1', name: 'test', arguments: '{' }],
                });
                yield { content: 'Done', done: true };
            });
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {
                persistOutputProgress: vi.fn().mockResolvedValue(undefined),
                persistToolCallMessage: vi.fn().mockResolvedValue(1),
                persistToolResultMessage: vi.fn().mockResolvedValue(undefined),
                persistCheckpoint: vi.fn().mockResolvedValue(undefined),
            } as never,
        });
        expect(outcome.type).toBe('completed');
        expect(providerMock.stream).toHaveBeenCalledTimes(2);
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
