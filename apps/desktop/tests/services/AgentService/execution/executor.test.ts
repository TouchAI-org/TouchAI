import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type {
    AiRequestOptions,
    PersistedOutputPart,
} from '@/services/AgentService/contracts/protocol';
import type { AiToolCall } from '@/services/AgentService/contracts/tooling';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';

const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

const { createMcpToolLogMock, updateMcpToolLogByCallIdMock, resolveToolCallMock, executeToolMock } =
    vi.hoisted(() => ({
        createMcpToolLogMock: vi.fn(),
        updateMcpToolLogByCallIdMock: vi.fn(),
        resolveToolCallMock: vi.fn(),
        executeToolMock: vi.fn(),
    }));

const {
    builtInExecuteToolMock,
    resolveToolDefinitionsMock,
    createProviderForModelMock,
    createProviderFromRegistryMock,
} = vi.hoisted(() => ({
    // Typed loosely: each test decides which tool result shape it exercises.
    builtInExecuteToolMock: vi.fn() as unknown as {
        mockImplementation: (fn: (options: never) => Promise<unknown>) => void;
        mockResolvedValue: (value: unknown) => void;
        mockClear: () => void;
        mockReset: () => void;
    },
    resolveToolDefinitionsMock: vi.fn(async () => []),
    createProviderForModelMock: vi.fn(),
    createProviderFromRegistryMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createMcpToolLog: createMcpToolLogMock,
    updateMcpToolLogByCallId: updateMcpToolLogByCallIdMock,
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        resolveToolCall: resolveToolCallMock,
        executeTool: executeToolMock,
    },
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: {
        executeTool: builtInExecuteToolMock,
    },
}));

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: createProviderForModelMock,
    createProviderInstance: vi.fn(),

    resolveToolDefinitions: resolveToolDefinitionsMock,

    getModel: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/providers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/AgentService/infrastructure/providers')>()),
    createProviderFromRegistry: createProviderFromRegistryMock,
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

function createLongCheckpoint(): AttemptCheckpoint {
    const checkpoint = createCheckpoint();
    checkpoint.activeModel.context_limit = 8000;
    checkpoint.activeModel.output_limit = 1000;
    checkpoint.messages = [
        ...Array.from({ length: 12 }, (_, i) => [
            { role: 'user' as const, content: `Request ${i}: ${'context '.repeat(150)}` },
            { role: 'assistant' as const, content: 'evidence '.repeat(200) },
        ]).flat(),
        { role: 'user', content: 'Finish the task.' },
    ];
    return checkpoint;
}

describe('user sends a prompt and receives a streamed answer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createProviderForModelMock.mockReturnValue(providerMock);
        resolveToolDefinitionsMock.mockResolvedValue([]);
        builtInExecuteToolMock.mockResolvedValue(null);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('user keeps the same cache route across retries and later turns while other sessions stay separate', async () => {
        const sent: AiRequestOptions[] = [];
        providerMock.stream.mockImplementation(async function* (request: AiRequestOptions) {
            sent.push(request);
            if (sent.length === 1) throw new AiError(AiErrorCode.NETWORK_ERROR);
            yield { content: 'Done', done: true };
        });
        const executor = new AiRequestExecutor();
        const persister = {
            getSessionId: () => 42,
            persistOutputProgress: async () => undefined,
        };
        const failed = await executor.runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
        });
        expect(failed.type).toBe('failed');
        if (failed.type !== 'failed') throw new Error('Expected the first request to fail');
        const retry = await executor.runAttempt({
            startCheckpoint: failed.resumeCheckpoint,
            persister: persister as never,
        });
        const nextTurn = await executor.runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
        });
        const otherSession = await executor.runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { ...persister, getSessionId: () => 43 } as never,
        });
        expect([retry.type, nextTurn.type, otherSession.type]).toEqual([
            'completed',
            'completed',
            'completed',
        ]);
        const routes = sent.map((request) => request.promptCacheKey);
        expect(routes[0]).toEqual(expect.any(String));
        expect(routes.slice(0, 3)).toEqual([routes[0], routes[0], routes[0]]);
        expect(routes[3]).not.toBe(routes[0]);
    });

    it('user receives the answer with summary costs included when history exceeds the model budget', async () => {
        const checkpoint = createLongCheckpoint();
        const compactionStates: string[] = [];
        const sent: AiRequestOptions[] = [];
        providerMock.stream.mockImplementation(async function* (request: AiRequestOptions) {
            sent.push(request);
            yield {
                content:
                    request.toolChoice === 'none'
                        ? 'Goal: finish. Next: validate.'
                        : 'Final answer',
                done: true,
                finishReason: 'stop',
                usageReported: true,
                usage: {
                    inputTokens: 10,
                    cacheReadTokens: 20,
                    cacheWriteTokens: 0,
                    outputTokens: 5,
                    reasoningTokens: 0,
                },
            };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: checkpoint,
            onChunk: (chunk) => {
                if (chunk.contextCompaction) compactionStates.push(chunk.contextCompaction.state);
            },
            persister: {
                getSessionId: () => 42,
                loadContextSummary: async () => undefined,
                persistContextSummary: async () => undefined,
                persistOutputProgress: async () => undefined,
            } as never,
        });
        expect(result.type).toBe('completed');
        expect(result.response).toBe('Final answer');
        expect(compactionStates).toEqual(['compacting', 'compacted']);
        expect(sent.some((request) => request.toolChoice === 'none')).toBe(true);
        expect(result.totalUsage.inputTokens).toBe(sent.length * 10);
        expect(result.totalUsage.cacheReadTokens).toBe(sent.length * 20);
        expect(result.calls).toHaveLength(sent.length);
        expect(sent.map((request) => request.attachmentRequestIndex)).toEqual(
            sent.map((_, index) => index)
        );
        expect(sent[sent.length - 1]!.messages.length).toBeLessThan(checkpoint.messages.length);
    });

    it('user keeps Anthropic cache settings consistent when summarizing long history', async () => {
        const checkpoint = createLongCheckpoint();
        checkpoint.activeModel.provider_driver = 'anthropic';
        checkpoint.activeModel.context_limit = 40_000;
        checkpoint.activeModel.output_limit = 16_384;
        checkpoint.messages = [
            ...checkpoint.messages,
            ...checkpoint.messages,
            ...checkpoint.messages,
        ];
        const sent: AiRequestOptions[] = [];
        providerMock.stream.mockImplementation(async function* (request: AiRequestOptions) {
            sent.push(request);
            yield {
                content: 'Goal: finish the task. Preserve the requirements.',
                done: true,
                finishReason: 'stop',
            };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: checkpoint,
            persister: {
                getSessionId: () => 42,
                loadContextSummary: async () => undefined,
                persistContextSummary: async () => undefined,
                persistOutputProgress: async () => undefined,
            } as never,
        });
        expect(result.type).toBe('completed');
        expect(sent.length).toBeGreaterThan(1);
        expect(sent.every((request) => request.toolChoice !== 'none')).toBe(true);
        expect(new Set(sent.map((request) => request.maxOutputTokens)).size).toBe(1);
        expect(sent[0]!.maxOutputTokens).toBeGreaterThan(8192);
    });

    it('user retains reported summary costs when cancellation arrives with the final provider usage', async () => {
        const controller = new AbortController();
        providerMock.stream.mockImplementation(async function* () {
            controller.abort();
            yield {
                content: 'Summary must not be installed.',
                done: true,
                finishReason: 'stop',
                usageReported: true,
                usage: {
                    inputTokens: 10,
                    cacheReadTokens: 20,
                    cacheWriteTokens: 0,
                    outputTokens: 5,
                    reasoningTokens: 0,
                },
            };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createLongCheckpoint(),
            signal: controller.signal,
            persister: {
                getSessionId: () => 42,
                loadContextSummary: async () => undefined,
            } as never,
        });
        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('Expected cancellation');
        expect(result.error.code).toBe(AiErrorCode.REQUEST_CANCELLED);
        expect(result.response).toBe('');
        expect(result.totalUsage.cacheReadTokens).toBe(20);
        expect(result.usageReportedCalls).toBe(1);
        expect(result.calls[0]?.finishReason).toBe('aborted');
    });

    it('user rejects tool-calling summaries without executing them and retains their reported costs', async () => {
        providerMock.stream.mockImplementation(async function* () {
            yield {
                content: '',
                done: true,
                finishReason: 'tool_calls',
                toolCalls: [{ id: 'unexpected', name: 'delete_file', arguments: '{}' }],
                usageReported: true,
                usage: {
                    inputTokens: 10,
                    cacheReadTokens: 20,
                    cacheWriteTokens: 0,
                    outputTokens: 5,
                    reasoningTokens: 0,
                },
            };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createLongCheckpoint(),
            persister: {
                getSessionId: () => 42,
                loadContextSummary: async () => undefined,
            } as never,
        });
        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('Expected summary rejection');
        expect(result.error.code).toBe(AiErrorCode.CONTEXT_COMPACTION_FAILED);
        expect(result.response).toBe('');
        expect(result.hasToolActivitySinceCheckpoint).toBe(false);
        expect(result.totalUsage.outputTokens).toBe(5);
        expect(executeToolMock).not.toHaveBeenCalled();
    });

    it('user sees the requested reasoning level honored even when metadata says it is unsupported', async () => {
        providerMock.stream.mockImplementation(async function* () {
            yield { content: 'Done', done: true };
        });

        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { getSessionId: () => 42 } as never,
        });

        expect(outcome.type).toBe('completed');
        expect(providerMock.stream).toHaveBeenCalledWith(
            expect.objectContaining({ reasoningLevel: 'max' })
        );
    });

    it('user keeps the partial answer with its timings when the stream fails', async () => {
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
                getSessionId: () => 42,
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

    it('user sees reasoning saved before the next stream event arrives', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
        const firstSaved = new Promise<void>((resolve) => {
            persistOutputProgress.mockImplementationOnce(async () => resolve());
        });
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoningState: 'start', done: false };
            await firstSaved;
            expect(persistOutputProgress).toHaveBeenCalledWith([
                { type: 'reasoning', content: '', startedAt: 1000 },
            ]);
            vi.setSystemTime(6000);
            yield { content: '', reasoning: 'Plan', done: false };
            yield { content: 'Answer', done: true };
        });
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { getSessionId: () => 42, persistOutputProgress } as never,
        });
        expect(outcome.type).toBe('completed');
        expect(persistOutputProgress).toHaveBeenLastCalledWith([
            { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
            { type: 'text', content: 'Answer' },
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user sees the finished answer saved without a temporary snapshot', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const persistOutputProgress = vi.fn().mockResolvedValue(undefined);
        const reasoningSaved = new Promise<void>((resolve) => {
            persistOutputProgress.mockImplementation(async (parts: PersistedOutputPart[]) => {
                if (parts.some((part) => part.type === 'reasoning' && part.endedAt !== undefined))
                    resolve();
            });
        });
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Plan', done: false };
            vi.setSystemTime(6000);
            yield { content: 'Answer', done: false };
            // The completed reasoning fragment must survive before the reply finishes.
            await reasoningSaved;
            expect(persistOutputProgress).toHaveBeenCalledWith([
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
            ]);
            yield { content: ' complete', textState: 'end', done: false };
            yield { content: '', done: true };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: { getSessionId: () => 42, persistOutputProgress } as never,
        });
        expect(result.type).toBe('completed');
        expect(persistOutputProgress).toHaveBeenLastCalledWith([
            { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
            { type: 'text', content: 'Answer complete' },
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user sees interleaved output kept in order on the next tool-loop request', async () => {
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield {
                    content: '',
                    reasoning: 'Plan',
                    reasoningProviderOptions: {
                        openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc_1' },
                    },
                    done: false,
                };
                yield { content: 'First answer', done: false };
                yield {
                    content: '',
                    reasoning: 'Review',
                    reasoningProviderOptions: { openai: { itemId: 'rs_2' } },
                    done: false,
                };
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
                        {
                            type: 'reasoning',
                            text: 'Plan',
                            providerOptions: {
                                openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc_1' },
                            },
                        },
                        { type: 'text', text: 'First answer' },
                        {
                            type: 'reasoning',
                            text: 'Review',
                            providerOptions: { openai: { itemId: 'rs_2' } },
                        },
                        { type: 'text', text: 'Second answer' },
                    ],
                    tool_calls: [{ id: 'call-1', name: 'test', arguments: '{' }],
                });
                yield { content: 'Done', done: true };
            });
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {
                getSessionId: () => 42,
                persistOutputProgress: vi.fn().mockResolvedValue(undefined),
                persistToolCallMessage: vi.fn().mockResolvedValue(1),
                persistToolResult: vi.fn().mockResolvedValue(undefined),
                persistCheckpoint: vi.fn().mockResolvedValue(undefined),
            } as never,
        });
        expect(outcome.type).toBe('completed');
        expect(providerMock.stream).toHaveBeenCalledTimes(2);
    });

    it('user sees the original failure reported when classifying the provider error fails', async () => {
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
            persister: { getSessionId: () => 42 } as never,
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

type TestExecutor = {
    executeMcpToolCall(options: {
        toolCall: AiToolCall;
        toolArgs: Record<string, unknown>;
        iteration: number;
        sessionId: number | null;
        toolCallMessageId: number | null;
        onChunk?: (chunk: unknown) => void;
    }): Promise<{
        result: string;
        isError: boolean;
        toolLogKind: string | null;
    }>;
};

function createToolCall(): AiToolCall {
    return {
        id: 'call-mcp-1',
        name: 'mcp__1__search',
        arguments: '{}',
    };
}

describe('user runs a tool call and watches it start', () => {
    it('user sees a tool call start reported before the tool runs', async () => {
        createMcpToolLogMock.mockResolvedValue({ id: 23 });
        updateMcpToolLogByCallIdMock.mockResolvedValue(undefined);
        resolveToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        executeToolMock.mockResolvedValue({
            result: 'done',
            isError: false,
        });

        const executor = new AiRequestExecutor();
        const chunks: unknown[] = [];

        const result = await (executor as unknown as TestExecutor).executeMcpToolCall({
            toolCall: createToolCall(),
            toolArgs: {
                query: 'alpha',
            },
            iteration: 0,
            sessionId: null,
            toolCallMessageId: null,
            onChunk: (chunk: unknown) => chunks.push(chunk),
        });

        expect(result).toMatchObject({
            isError: false,
            result: 'done',
        });

        const callStartChunk = chunks.find((chunk) => {
            return (
                typeof chunk === 'object' &&
                chunk !== null &&
                'toolEvent' in chunk &&
                (chunk as { toolEvent?: { type?: string } }).toolEvent?.type === 'call_start'
            );
        }) as { toolEvent: Record<string, unknown> } | undefined;

        expect(callStartChunk?.toolEvent).toMatchObject({
            type: 'call_start',
            callId: 'call-mcp-1',
            toolName: 'search',
            namespacedName: 'mcp__1__search',
            source: 'mcp',
            serverId: 1,
            arguments: {
                query: 'alpha',
            },
            startedAt: expect.any(Number),
        });
    }, 30_000);

    it('user does not get mcp tool secrets stored in the audit log', async () => {
        vi.clearAllMocks();
        createMcpToolLogMock.mockResolvedValue({ id: 23 });
        updateMcpToolLogByCallIdMock.mockResolvedValue(undefined);
        resolveToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        executeToolMock.mockResolvedValue({
            result: 'called https://api.example.test/v1?token=result-secret',
            isError: false,
        });

        const executor = new AiRequestExecutor();
        await (executor as unknown as TestExecutor).executeMcpToolCall({
            toolCall: createToolCall(),
            toolArgs: { query: 'alpha', accessToken: 'argument-secret' },
            iteration: 0,
            sessionId: null,
            toolCallMessageId: null,
        });

        const storedInput = createMcpToolLogMock.mock.calls[0]?.[0] as { input: string };
        const storedOutput = updateMcpToolLogByCallIdMock.mock.calls[0]?.[1] as {
            output: string;
        };

        expect(storedInput.input).not.toContain('argument-secret');
        expect(JSON.parse(storedInput.input)).toMatchObject({
            query: 'alpha',
            accessToken: '[redacted]',
        });
        expect(storedOutput.output).not.toContain('result-secret');
        expect(storedOutput.output).toContain('https://api.example.test/[redacted-path]');
    }, 30_000);
});

describe('user calls a tool the agent does not have', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The once-queue survives clearAllMocks, so reset it to keep rounds per-test.
        providerMock.stream.mockReset();
        createProviderForModelMock.mockReturnValue(providerMock);
        resolveToolDefinitionsMock.mockResolvedValue([]);
        builtInExecuteToolMock.mockResolvedValue(null);
    });

    function streamOneToolCall(toolCall: AiToolCall) {
        return async function* () {
            yield { content: 'Checking', done: false };
            yield { content: '', done: true, finishReason: 'tool_calls', toolCalls: [toolCall] };
        };
    }

    function persisterStub() {
        return {
            persistOutputProgress: vi.fn().mockResolvedValue(undefined),
            getSessionId: vi.fn(() => 1),
            persistToolCallMessage: vi.fn().mockResolvedValue(1),
            persistToolResult: vi.fn().mockResolvedValue(undefined),
            persistCheckpoint: vi.fn().mockResolvedValue(undefined),
        };
    }

    it('user sees the tool reported as missing when no tool matches the call', async () => {
        resolveToolCallMock.mockResolvedValue(null);
        providerMock.stream
            .mockImplementationOnce(
                streamOneToolCall({ id: 'call-1', name: 'ghost', arguments: '{}' })
            )
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });

        const chunks: Array<{ toolEvent?: Record<string, unknown> }> = [];
        const persister = persisterStub();
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
            onChunk: (chunk) => chunks.push(chunk as never),
        });

        expect(outcome.type).toBe('completed');
        // The user is told the call ended in error, and the reason names the tool.
        expect(chunks).toContainEqual(
            expect.objectContaining({
                toolEvent: expect.objectContaining({
                    type: 'call_end',
                    callId: 'call-1',
                    isError: true,
                    finalStatus: 'error',
                }),
            })
        );
        expect(persister.persistToolResult).toHaveBeenCalledWith(
            expect.objectContaining({ result: expect.stringContaining('ghost') })
        );
    });

    it('user sees the tool reported as failed when it throws a plain message', async () => {
        resolveToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        createMcpToolLogMock.mockResolvedValue({ id: 23 });
        updateMcpToolLogByCallIdMock.mockResolvedValue(undefined);
        // A non-Error rejection must still surface a readable failure, not crash the turn.
        executeToolMock.mockRejectedValue('server went away');
        providerMock.stream
            .mockImplementationOnce(
                streamOneToolCall({ id: 'call-1', name: 'mcp__1__search', arguments: '{}' })
            )
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });

        const persister = persisterStub();
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
        });

        expect(outcome.type).toBe('completed');
        expect(persister.persistToolResult).toHaveBeenCalledWith(
            expect.objectContaining({
                result: expect.stringContaining('server went away'),
            })
        );
    });

    it('user sees a tool call with non-object arguments rejected before it runs', async () => {
        providerMock.stream
            .mockImplementationOnce(
                // Valid JSON, but not the object shape a tool call requires.
                streamOneToolCall({ id: 'call-1', name: 'builtin__bash', arguments: '42' })
            )
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });

        const persister = persisterStub();
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
        });

        expect(outcome.type).toBe('completed');
        expect(builtInExecuteToolMock).not.toHaveBeenCalled();
        if (outcome.type !== 'completed') {
            return;
        }
        // The rejected call counts against the model's structured-output ability.
        expect(outcome.toolArgumentErrors).toBe(1);
    });

    it('user is told the model cannot read the file a tool produced', async () => {
        builtInExecuteToolMock.mockImplementation(async (options: { toolCall: AiToolCall }) => ({
            toolCall: options.toolCall,
            builtInToolId: 'bash',
            toolLogId: 5,
            toolLogKind: 'builtin',
            result: 'file ready',
            isError: false,
            attachments: [
                {
                    id: 'attachment-1',
                    type: 'image',
                    name: 'chart.png',
                    path: 'D:/cache/chart.png',
                    originPath: 'D:/origin/chart.png',
                    mimeType: 'image/png',
                },
            ],
        }));
        providerMock.stream
            .mockImplementationOnce(
                streamOneToolCall({ id: 'call-1', name: 'builtin__bash', arguments: '{}' })
            )
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });

        // The checkpoint model cannot take images, so the turn stops rather than dropping the file.
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
        });

        expect(outcome.type).toBe('failed');
        if (outcome.type !== 'failed') {
            return;
        }
        expect(outcome.error.code).toBe(AiErrorCode.UNSUPPORTED_INPUT);
    });
});

describe('user asks the agent to switch to a stronger model', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // The once-queue survives clearAllMocks, so reset it to keep rounds per-test.
        providerMock.stream.mockReset();
        createProviderForModelMock.mockReturnValue(providerMock);
        builtInExecuteToolMock.mockResolvedValue(null);
    });

    function upgradeSignal() {
        return {
            type: 'upgrade_model',
            targetModel: {
                ...createCheckpoint().activeModel,
                id: 2,
                model_id: 'mimo-v3',
                name: 'MiMo v3',
            },
            restartCurrentRequest: false,
        };
    }

    function toolRoundThenAnswer(times: number) {
        for (let index = 0; index < times; index += 1) {
            providerMock.stream.mockImplementationOnce(async function* () {
                yield {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [
                        { id: `call-${index}`, name: 'builtin__upgrade_model', arguments: '{}' },
                    ],
                };
            });
        }
        providerMock.stream.mockImplementationOnce(async function* () {
            yield { content: 'Done', done: true };
        });
    }

    function persisterStub() {
        return {
            persistOutputProgress: vi.fn().mockResolvedValue(undefined),
            getSessionId: vi.fn(() => 1),
            persistToolCallMessage: vi.fn().mockResolvedValue(1),
            persistToolResult: vi.fn().mockResolvedValue(undefined),
            persistCheckpoint: vi.fn().mockResolvedValue(undefined),
        };
    }

    function upgradeStub() {
        return vi.fn(async (options: { toolCall: AiToolCall }) => ({
            toolCall: options.toolCall,
            builtInToolId: 'upgrade_model',
            toolLogId: 5,
            toolLogKind: 'builtin',
            result: 'switched',
            isError: false,
            controlSignal: upgradeSignal(),
        }));
    }

    it('user sees the switch reported with the model it moved to', async () => {
        builtInExecuteToolMock.mockImplementation(upgradeStub());
        resolveToolDefinitionsMock.mockResolvedValue([]);
        toolRoundThenAnswer(1);

        const chunks: Array<{ toolEvent?: Record<string, unknown> }> = [];
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
            onChunk: (chunk) => chunks.push(chunk as never),
        });

        expect(outcome.type).toBe('completed');
        if (outcome.type !== 'completed') {
            return;
        }
        expect(outcome.model.model_id).toBe('mimo-v3');
        expect(outcome.modelSwitchCount).toBe(1);
        expect(chunks).toContainEqual(
            expect.objectContaining({
                toolEvent: expect.objectContaining({
                    type: 'model_switched',
                    toModel: expect.objectContaining({ modelId: 'mimo-v3' }),
                }),
            })
        );
    });

    it('user is stopped from switching models once the ceiling is reached', async () => {
        builtInExecuteToolMock.mockImplementation(upgradeStub());
        resolveToolDefinitionsMock.mockResolvedValue([]);
        // Four switches is the ceiling, so the fifth round must hide the switch tool.
        toolRoundThenAnswer(5);

        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
        });

        expect(outcome.type).toBe('completed');
        if (outcome.type !== 'completed') {
            return;
        }
        expect(outcome.hitModelSwitchCeiling).toBe(true);
        expect(resolveToolDefinitionsMock).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ excludedToolNames: ['builtin__upgrade_model'] })
        );
    });

    it('user sees the switch tool still offered below the ceiling', async () => {
        builtInExecuteToolMock.mockImplementation(upgradeStub());
        resolveToolDefinitionsMock.mockResolvedValue([]);
        toolRoundThenAnswer(1);

        await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
        });

        expect(resolveToolDefinitionsMock).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ excludedToolNames: undefined })
        );
    });
});

describe('user configures a provider for a custom endpoint', () => {
    it('user gets the provider they configured back for use', () => {
        const executor = new AiRequestExecutor();
        const built = { name: 'stub' };
        createProviderFromRegistryMock.mockReturnValue(built);

        // What matters is that the executor hands back a usable provider, not how it builds one.
        expect(
            executor.createProviderInstance('openai', 'https://example.test/v1', 'sk-test', null)
        ).toBe(built);
    });

    it('user gets the endpoint they entered used for the provider', () => {
        const executor = new AiRequestExecutor();
        createProviderFromRegistryMock.mockReturnValue({ name: 'stub' });

        executor.createProviderInstance('openai-compatible', 'https://example.test/v1', null, null);

        // The endpoint is user input; a wrong one sends the request nowhere.
        expect(createProviderFromRegistryMock.mock.calls[0]![1]).toMatchObject({
            apiEndpoint: 'https://example.test/v1',
        });
    });
});
