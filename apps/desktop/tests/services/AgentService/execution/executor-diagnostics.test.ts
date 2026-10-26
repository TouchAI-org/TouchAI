/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';

/**
 * Complements executor.test.ts with the diagnostics an attempt reports when a provider
 * fails, and with the guards on an attempt that produces nothing usable.
 *
 * The provider error details are what the settings page shows when a request fails, so
 * losing them turns a diagnosable 401 into a bare "request failed".
 */
const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

const { resolveToolDefinitionsMock, createProviderForModelMock } = vi.hoisted(() => ({
    resolveToolDefinitionsMock: vi.fn(async () => []),
    createProviderForModelMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: { resolveToolCall: vi.fn(), executeTool: vi.fn() },
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: { executeTool: vi.fn(async () => null) },
}));

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: createProviderForModelMock,
    createProviderInstance: vi.fn(),
    resolveToolDefinitions: resolveToolDefinitionsMock,
    getModel: vi.fn(),
}));

function createCheckpoint(overrides: Partial<AttemptCheckpoint> = {}): AttemptCheckpoint {
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
            reasoning_options: null,
            release_date: null,
            temperature: 1,
            tool_call: 0,
            knowledge: null,
            context_limit: null,
            output_limit: null,
            is_custom_metadata: 0,
            upstream_metadata: null,
            provider_name: 'Xiaomi MiMo',
            provider_driver: 'mimo',
            api_endpoint: 'https://example.test/v1',
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
        ...overrides,
    };
}

/** A stream that fails on its first read with the given error. */
function streamThrowing(error: unknown) {
    return () =>
        ({
            [Symbol.asyncIterator]() {
                return {
                    next: async () => {
                        throw error;
                    },
                };
            },
        }) as AsyncIterable<unknown>;
}

async function failWith(error: unknown, signal?: AbortSignal) {
    providerMock.stream.mockImplementation(streamThrowing(error));
    providerMock.classifyError.mockReturnValue(new AiError(AiErrorCode.NETWORK_ERROR));
    return new AiRequestExecutor().runAttempt({
        startCheckpoint: createCheckpoint(),
        persister: {} as never,
        signal,
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks keeps the mockImplementationOnce queue; drain it so rounds stay per-test.
    providerMock.stream.mockReset();
    providerMock.classifyError.mockReset();
    createProviderForModelMock.mockReturnValue(providerMock);
    resolveToolDefinitionsMock.mockResolvedValue([]);
});

describe('user sees why the provider request failed', () => {
    it('user gets the HTTP status and url kept for diagnosis', async () => {
        const failure = Object.assign(new Error('unauthorized'), {
            statusCode: 401,
            url: 'https://example.test/v1/chat/completions',
        });

        const result = await failWith(failure);

        expect(result).toMatchObject({
            type: 'failed',
            providerErrorDetails: {
                statusCode: 401,
                url: 'https://example.test/v1/chat/completions',
            },
        });
    });

    it('user gets the response body and request values kept when the provider reports them', async () => {
        const failure = Object.assign(new Error('bad request'), {
            statusCode: 400,
            responseBody: { error: 'context too long' },
            requestBodyValues: { model: 'mimo-v2.5' },
            data: { retryable: false },
        });

        const result = await failWith(failure);

        expect(result).toMatchObject({
            providerErrorDetails: {
                statusCode: 400,
                responseBody: { error: 'context too long' },
                requestBodyValues: { model: 'mimo-v2.5' },
                data: { retryable: false },
            },
        });
    });

    it('user gets the details of the real error when the SDK wraps it in a retry', async () => {
        // The AI SDK's RetryError hides the useful error one level down.
        const inner = Object.assign(new Error('rate limited'), {
            statusCode: 429,
            url: 'https://example.test/v1/chat/completions',
        });
        const wrapped = Object.assign(new Error('retries exhausted'), { lastError: inner });

        const result = await failWith(wrapped);

        expect(result).toMatchObject({
            providerErrorDetails: { statusCode: 429 },
        });
    });

    it('user gets the innermost error when the SDK wraps it more than once', async () => {
        const innermost = Object.assign(new Error('gateway timeout'), { statusCode: 504 });
        const middle = Object.assign(new Error('retry'), { lastError: innermost });
        const outer = Object.assign(new Error('retry'), { lastError: middle });

        const result = await failWith(outer);

        expect(result).toMatchObject({ providerErrorDetails: { statusCode: 504 } });
    });

    it('user gets the wrapper itself when it names no inner error', async () => {
        // `lastError: undefined` means the wrapper is all there is.
        const wrapped = Object.assign(new Error('odd failure'), {
            lastError: undefined,
            statusCode: 500,
        });

        const result = await failWith(wrapped);

        expect(result).toMatchObject({ providerErrorDetails: { statusCode: 500 } });
    });

    it('user gets no details invented when the error carries none', async () => {
        const result = await failWith(new Error('plain failure'));

        expect(result).toMatchObject({ type: 'failed', providerErrorDetails: null });
    });

    it('user gets no details when the provider rejects with a plain string', async () => {
        const result = await failWith('something went wrong');

        expect(result).toMatchObject({ type: 'failed', providerErrorDetails: null });
    });

    it('user gets no details for a provider error that carries only unrelated fields', async () => {
        const failure = Object.assign(new Error('odd'), { unrelated: 'value' });

        const result = await failWith(failure);

        expect(result).toMatchObject({ providerErrorDetails: null });
    });
});

describe('user cancels an attempt before the model answers', () => {
    it('user gets the attempt stopped as soon as the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        providerMock.stream.mockImplementation(async function* () {
            yield { content: 'never read', done: false };
        });
        providerMock.classifyError.mockReturnValue(new AiError(AiErrorCode.REQUEST_CANCELLED));

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {} as never,
            signal: controller.signal,
        });

        // No content is consumed once the caller has cancelled.
        expect(result).toMatchObject({ type: 'failed', response: '' });
    });
});

describe('user gets an answer the model never produced', () => {
    it('user is told the answer was empty rather than shown a blank reply', async () => {
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', done: true };
        });
        providerMock.classifyError.mockReturnValue(new AiError(AiErrorCode.EMPTY_RESPONSE));

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {} as never,
        });

        expect(result).toMatchObject({ type: 'failed' });
        if (result.type !== 'failed') {
            return;
        }
        expect(result.error.code).toBe(AiErrorCode.EMPTY_RESPONSE);
    });

    it('user gets thinking-only output accepted as a real answer', async () => {
        // A model that thinks but returns no prose still produced something.
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Thought about it', done: true };
        });

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {} as never,
        });

        expect(result).toMatchObject({ type: 'completed', reasoning: 'Thought about it' });
    });
});

describe('user watches a tool loop commit its progress', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // clearAllMocks keeps the mockImplementationOnce queue; drain it so rounds stay per-test.
        providerMock.stream.mockReset();
        createProviderForModelMock.mockReturnValue(providerMock);
        resolveToolDefinitionsMock.mockResolvedValue([]);
    });

    function persisterStub() {
        return {
            persistOutputProgress: vi.fn().mockResolvedValue(undefined),
            persistToolCallMessage: vi.fn().mockResolvedValue(1),
            persistToolResult: vi.fn().mockResolvedValue(undefined),
            persistCheckpoint: vi.fn().mockResolvedValue(undefined),
            getSessionId: vi.fn(() => 1),
        };
    }

    it('user sees a safe point reported after each tool round', async () => {
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield { content: 'Checking', done: false };
                yield {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'call-1', name: 'builtin__bash', arguments: '{}' }],
                };
            })
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });
        const persister = persisterStub();
        const events: Array<Record<string, unknown>> = [];

        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
            taskId: 'task-1',
            onTurnEvent: (event) => events.push(event as never),
        });

        expect(outcome.type).toBe('completed');
        expect(persister.persistCheckpoint).toHaveBeenCalled();
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'checkpoint_committed', taskId: 'task-1' })
        );
    });

    it('user still gets the answer when saving the safe point fails', async () => {
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'call-1', name: 'builtin__bash', arguments: '{}' }],
                };
            })
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });
        const persister = persisterStub();
        persister.persistCheckpoint.mockRejectedValue(new Error('database is locked'));

        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
        });

        // A failed checkpoint write must not cost the user the answer.
        expect(outcome.type).toBe('completed');
    });

    it('user sees the safe point reported without a task when none is running', async () => {
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'call-1', name: 'builtin__bash', arguments: '{}' }],
                };
            })
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });
        const persister = persisterStub();
        const events: Array<Record<string, unknown>> = [];

        await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
            onTurnEvent: (event) => events.push(event as never),
        });

        // Nothing to attach a live task event to, but the checkpoint is still saved.
        expect(events).toEqual([]);
        expect(persister.persistCheckpoint).toHaveBeenCalled();
    });
});
