import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type {
    AiMessage,
    AiRequestOptions,
    PersistedOutputPart,
} from '@/services/AgentService/contracts/protocol';
import type { AiToolCall } from '@/services/AgentService/contracts/tooling';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type {
    AttemptCheckpoint,
    RequestPrivateState,
} from '@/services/AgentService/execution/executor';
import { dispatchToolCall } from '@/services/AgentService/infrastructure/tools';

const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

const { createMcpToolLogMock, updateMcpToolLogByIdMock, resolveToolCallMock, executeToolMock } =
    vi.hoisted(() => ({
        createMcpToolLogMock: vi.fn(),
        updateMcpToolLogByIdMock: vi.fn(),
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
    updateMcpToolLogById: updateMcpToolLogByIdMock,
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

vi.mock('@/services/AgentService/infrastructure/providers/drivers', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('@/services/AgentService/infrastructure/providers/drivers')
    >()),
    createProviderFromRegistry: createProviderFromRegistryMock,
}));

function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

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
        { role: 'user' as const, content: 'Finish the task.' },
    ].map((message, index) => ({
        ...message,
        contextSource: { id: index + 1, fingerprint: 'a'.repeat(64) },
    }));
    return checkpoint;
}

function prepareToolMessage(sessionId: number) {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database
        .prepare(
            "INSERT INTO sessions (id, session_id, title, model) VALUES (?, 'test', 'Test', 'test')"
        )
        .run(sessionId);
    database
        .prepare("INSERT INTO messages (id, session_id, role) VALUES (1, ?, 'tool_call')")
        .run(sessionId);
}

afterEach(closeTestDatabases);

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

    it('user selects oversized private instructions and receives a context error before sending an over-budget request', async () => {
        const checkpoint = createCheckpoint();
        checkpoint.activeModel.context_limit = 8000;
        checkpoint.activeModel.output_limit = 1000;
        checkpoint.messages.unshift({ role: 'system', content: 'Selected skill: summary' });
        const sent: AiRequestOptions[] = [];
        providerMock.stream.mockImplementation(async function* (request: AiRequestOptions) {
            sent.push(request);
            yield { content: 'Unexpected over-budget answer', done: true };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: checkpoint,
            privateState: {
                messageContents: new Map([[0, 'Private instructions '.repeat(3000)]]),
                skillActivationAttempts: 0,
            },
            persister: {
                getSessionId: () => 42,
                persistOutputProgress: async () => undefined,
            } as never,
        });
        expect(result).toMatchObject({
            type: 'failed',
            error: { code: AiErrorCode.CONTEXT_TOO_LARGE },
        });
        expect(sent).toEqual([]);
    });

    it.each(['tool round', 'retry'] as const)(
        'user compacts history then continues through a %s with private content attached only to its original message',
        async (continuation) => {
            const checkpoint = createLongCheckpoint();
            const publicCall = {
                id: 'retained-public-call',
                name: 'builtin__read',
                arguments: '{"path":"chart.md"}',
            };
            const start = checkpoint.messages.length;
            const source = { id: 100, fingerprint: 'b'.repeat(64) };
            checkpoint.messages.push(
                {
                    role: 'assistant',
                    content: '',
                    tool_calls: [publicCall],
                    contextSource: source,
                },
                {
                    role: 'tool',
                    content: 'Public result',
                    tool_call_id: publicCall.id,
                    name: publicCall.name,
                    contextSource: source,
                }
            );
            const privateState: RequestPrivateState = {
                messageContents: new Map<number, AiMessage['content']>([
                    [1, 'ARCHIVED_PRIVATE_BODY'],
                    [start + 1, 'RETAINED_PRIVATE_BODY'],
                ]),
                skillActivationAttempts: 0,
            };
            const nextCall = { id: 'next-call', name: 'builtin__read', arguments: '{}' };
            const sent: AiRequestOptions[] = [];
            const summaries: AiRequestOptions[] = [];
            providerMock.stream.mockImplementation(async function* (request: AiRequestOptions) {
                if (request.toolChoice === 'none') {
                    summaries.push(request);
                    yield { content: 'Goal: finish the task.', done: true, finishReason: 'stop' };
                    return;
                }
                sent.push(request);
                if (sent.length === 1) {
                    if (continuation === 'retry') throw new AiError(AiErrorCode.NETWORK_ERROR);
                    yield {
                        content: '',
                        done: true,
                        finishReason: 'tool_calls',
                        toolCalls: [nextCall],
                    };
                    return;
                }
                yield { content: 'Final answer', done: true, finishReason: 'stop' };
            });
            builtInExecuteToolMock.mockResolvedValue({
                toolCall: nextCall,
                result: 'Next result stays intact',
                isError: false,
                toolLogId: 2,
                builtInToolId: 'read_file',
            });
            const persisted: unknown[] = [];
            const persister = {
                getSessionId: () => 42,
                getAttemptGeneration: () => 1,
                persistContextSummary: async (summary: unknown) => {
                    persisted.push(summary);
                    return 1;
                },
                validateContextSummary: async () => undefined,
                persistOutputProgress: async () => undefined,
                persistToolCallMessage: async () => 101,
                persistToolResult: async () => undefined,
                getContextMessageSource: async () => ({ id: 101, fingerprint: 'c'.repeat(64) }),
                persistCheckpoint: async (value: unknown) => {
                    persisted.push(value);
                },
            };
            const executor = new AiRequestExecutor();
            let result = await executor.runAttempt({
                startCheckpoint: checkpoint,
                privateState,
                persister: persister as never,
            });
            if (continuation === 'retry') {
                expect(result.type).toBe('failed');
                if (result.type !== 'failed') throw new Error('Expected a retryable failure');
                persisted.push(result.resumeCheckpoint);
                result = await executor.runAttempt({
                    startCheckpoint: result.resumeCheckpoint,
                    privateState,
                    persister: persister as never,
                });
            }
            expect(result).toMatchObject({ type: 'completed', response: 'Final answer' });
            expect(sent).toHaveLength(2);
            expect(summaries.length).toBeGreaterThan(0);
            for (const request of sent) {
                expect(
                    request.messages.find((message) => message.tool_call_id === publicCall.id)
                ).toMatchObject({ role: 'tool', content: 'RETAINED_PRIVATE_BODY' });
                expect(
                    request.messages.flatMap((message) => message.tool_calls ?? [])
                ).toContainEqual(publicCall);
                expect(JSON.stringify(request)).not.toContain('ARCHIVED_PRIVATE_BODY');
            }
            for (const value of [summaries, persisted]) {
                expect(JSON.stringify(value)).not.toContain('PRIVATE_BODY');
            }
        }
    );

    it('user sees no duplicated prior output when next-step preparation fails after a complete tool round', async () => {
        const checkpoint = createCheckpoint();
        checkpoint.activeModel.context_limit = 8000;
        checkpoint.activeModel.output_limit = 1000;
        const call = { id: 'read-1', name: 'builtin__read', arguments: '{}' };
        providerMock.stream.mockImplementation(async function* () {
            yield {
                content: 'I will inspect the file.',
                toolCalls: [call],
                done: true,
                finishReason: 'tool_calls',
            };
        });
        builtInExecuteToolMock.mockResolvedValue({
            toolCall: call,
            result: 'large result '.repeat(30000),
            isError: false,
            toolLogId: 7,
            builtInToolId: 'read_file',
        });
        const storedToolParts: PersistedOutputPart[][] = [];
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: checkpoint,
            persister: {
                getSessionId: () => 42,

                persistContextSummary: async () => 1,
                validateContextSummary: async () => undefined,
                persistCheckpoint: async () => undefined,
                persistOutputProgress: async () => undefined,
                persistToolCallMessage: async (parts: PersistedOutputPart[]) => {
                    storedToolParts.push(parts);
                    return 5;
                },
                persistToolResult: async () => undefined,
                getContextMessageSource: async () => undefined,
                getAttemptGeneration: () => 1,
            } as never,
        });
        expect(result.type).toBe('failed');
        if (result.type !== 'failed') throw new Error('Expected a preparation failure');
        expect(result.error.code).toBe(AiErrorCode.CONTEXT_TOO_LARGE);
        expect(storedToolParts).toEqual([[{ type: 'text', content: 'I will inspect the file.' }]]);
        expect(result.partialOutputParts).toEqual([]);
    });

    it('user retries and continues a session with the same budget calibration while other sessions stay separate', async () => {
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
            getAttemptGeneration: () => 1,
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
        const originalMessageCount = checkpoint.messages.length;
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

                persistContextSummary: async () => 1,
                validateContextSummary: async () => undefined,
                persistCheckpoint: async () => undefined,
                persistOutputProgress: async () => undefined,
                getAttemptGeneration: () => 1,
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
        expect(sent[sent.length - 1]!.messages.length).toBeLessThan(originalMessageCount);
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
        ].map((message, index) => ({
            ...message,
            contextSource: { id: index + 1, fingerprint: 'a'.repeat(64) },
        }));
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

                persistContextSummary: async () => 1,
                validateContextSummary: async () => undefined,
                persistCheckpoint: async () => undefined,
                persistOutputProgress: async () => undefined,
                getAttemptGeneration: () => 1,
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
                persistOutputProgress: async () => undefined,
                getAttemptGeneration: () => 1,
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

    it.each([false, true])(
        'user on WebKit without AbortSignal.any can compact with cancellation=%s',
        async (cancel) => {
            const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
            Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
            const controller = new AbortController();
            const summarySignals: AbortSignal[] = [];
            try {
                providerMock.stream.mockImplementation(async function* (request: AiRequestOptions) {
                    if (request.toolChoice === 'none') {
                        summarySignals.push(request.signal!);
                        expect(request.signal?.aborted).toBe(false);
                        if (cancel) {
                            controller.abort();
                            expect(request.signal?.aborted).toBe(true);
                        }
                    }
                    yield {
                        content: request.toolChoice === 'none' ? 'Goal: finish.' : 'Final answer',
                        done: true,
                        finishReason: 'stop',
                    };
                });
                const result = await new AiRequestExecutor().runAttempt({
                    startCheckpoint: createLongCheckpoint(),
                    signal: controller.signal,
                    persister: {
                        getSessionId: () => 42,

                        persistContextSummary: async () => 1,
                        validateContextSummary: async () => undefined,
                        persistCheckpoint: async () => undefined,
                        persistOutputProgress: async () => undefined,
                        getAttemptGeneration: () => 1,
                    } as never,
                });
                if (cancel) {
                    expect(result).toMatchObject({
                        type: 'failed',
                        error: { code: AiErrorCode.REQUEST_CANCELLED },
                        response: '',
                    });
                } else {
                    expect(result).toMatchObject({ type: 'completed', response: 'Final answer' });
                    expect(controller.signal.aborted).toBe(false);
                }
                expect(summarySignals.length).toBeGreaterThan(0);
                expect(summarySignals.every((signal) => signal.aborted)).toBe(true);
            } finally {
                if (descriptor) Object.defineProperty(AbortSignal, 'any', descriptor);
                else Reflect.deleteProperty(AbortSignal, 'any');
            }
        }
    );

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
                validateContextSummary: async () => undefined,
                persistCheckpoint: async () => undefined,
                persistOutputProgress: async () => undefined,
                getAttemptGeneration: () => 1,
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
            persister: {
                getSessionId: () => 42,
                persistOutputProgress: vi.fn().mockResolvedValue(undefined),
                getAttemptGeneration: () => 1,
            } as never,
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
                getAttemptGeneration: () => 1,
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
        const firstWriteStarted = deferred<void>();
        const releaseFirstWrite = deferred<void>();
        let writeCount = 0;
        const persistOutputProgress = vi.fn(async () => {
            writeCount += 1;
            if (writeCount === 1) {
                firstWriteStarted.resolve();
                await releaseFirstWrite.promise;
            }
        });
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoningState: 'start', done: false };
            await firstWriteStarted.promise;
            expect(persistOutputProgress).toHaveBeenCalledWith(
                [{ type: 'reasoning', content: '', startedAt: 1000 }],
                { attemptGeneration: 1, step: 0 }
            );
            releaseFirstWrite.resolve();
            vi.setSystemTime(6000);
            yield { content: '', reasoning: 'Plan', done: false };
            yield { content: 'Answer', done: true };
        });
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {
                getSessionId: () => 42,
                persistOutputProgress,
                getAttemptGeneration: () => 1,
            } as never,
        });
        expect(outcome.type).toBe('completed');
        expect(persistOutputProgress).toHaveBeenLastCalledWith(
            [
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
                { type: 'text', content: 'Answer' },
            ],
            { attemptGeneration: 1, step: 0 }
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user sees the finished answer saved without a temporary snapshot', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        const completedReasoningWriteStarted = deferred<void>();
        const releaseCompletedReasoningWrite = deferred<void>();
        const persistOutputProgress = vi.fn(async (parts: Array<{ endedAt?: number }>) => {
            if (parts[0]?.endedAt === 6000) {
                completedReasoningWriteStarted.resolve();
                await releaseCompletedReasoningWrite.promise;
            }
        });
        providerMock.stream.mockImplementation(async function* () {
            yield { content: '', reasoning: 'Plan', done: false };
            vi.setSystemTime(6000);
            yield { content: 'Answer', done: false };
            // The completed reasoning fragment must survive before the reply finishes.
            await completedReasoningWriteStarted.promise;
            expect(persistOutputProgress).toHaveBeenCalledWith(
                [{ type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 }],
                { attemptGeneration: 1, step: 0 }
            );
            releaseCompletedReasoningWrite.resolve();
            yield { content: ' complete', textState: 'end', done: false };
            yield { content: '', done: true };
        });
        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: {
                getSessionId: () => 42,
                persistOutputProgress,
                getAttemptGeneration: () => 1,
            } as never,
        });
        expect(result.type).toBe('completed');
        expect(persistOutputProgress).toHaveBeenLastCalledWith(
            [
                { type: 'reasoning', content: 'Plan', startedAt: 1000, endedAt: 6000 },
                { type: 'text', content: 'Answer complete' },
            ],
            { attemptGeneration: 1, step: 0 }
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user sees interleaved output kept in order on the next tool-loop request', async () => {
        prepareToolMessage(42);
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
                getContextMessageSource: async () => undefined,
                persistCheckpoint: vi.fn().mockResolvedValue(undefined),
                getAttemptGeneration: () => 1,
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
            persister: { getSessionId: () => 42, getAttemptGeneration: () => 1 } as never,
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

function createToolCall(): AiToolCall {
    return {
        id: 'call-mcp-1',
        name: 'mcp__1__search',
        arguments: '{"query":"alpha"}',
    };
}

describe('user runs a tool call and watches it start', () => {
    it('user sees a tool call start reported before the tool runs', async () => {
        createMcpToolLogMock.mockResolvedValue({ id: 23 });
        updateMcpToolLogByIdMock.mockResolvedValue(undefined);
        resolveToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        executeToolMock.mockResolvedValue({
            result: 'done',
            isError: false,
        });

        const events: Array<{ type?: string }> = [];
        const result = await dispatchToolCall({
            toolCall: createToolCall(),
            iteration: 0,
            currentModel: {} as never,
            sessionId: null,
            toolCallMessageId: null,
            emitToolEvent: (event) => events.push(event as { type?: string }),
        });

        expect(result).toMatchObject({
            isError: false,
            result: 'done',
        });

        const callStartEvent = events.find((event) => event.type === 'call_start') as
            | Record<string, unknown>
            | undefined;

        expect(callStartEvent).toMatchObject({
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
        updateMcpToolLogByIdMock.mockResolvedValue(undefined);
        resolveToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        executeToolMock.mockResolvedValue({
            result: 'called https://api.example.test/v1?token=result-secret',
            isError: false,
        });

        const toolCall = createToolCall();
        toolCall.arguments = JSON.stringify({
            query: 'alpha',
            accessToken: 'argument-secret',
        });
        await dispatchToolCall({
            toolCall,
            iteration: 0,
            currentModel: {} as never,
            sessionId: null,
            toolCallMessageId: null,
            emitToolEvent: vi.fn(),
        });

        const storedInput = createMcpToolLogMock.mock.calls[0]?.[0] as { input: string };
        const storedOutput = updateMcpToolLogByIdMock.mock.calls[0]?.[1] as {
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
        prepareToolMessage(1);
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
            getAttemptGeneration: () => 1,
            getSessionId: vi.fn(() => 1),
            persistToolCallMessage: vi.fn().mockResolvedValue(1),
            persistToolResult: vi.fn().mockResolvedValue(undefined),
            getContextMessageSource: async () => undefined,
            persistCheckpoint: vi.fn().mockResolvedValue(undefined),
        };
    }

    it('user sees the executor forward a started MCP call to the stream', async () => {
        resolveToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        createMcpToolLogMock.mockResolvedValue({ id: 23 });
        updateMcpToolLogByIdMock.mockResolvedValue(undefined);
        executeToolMock.mockResolvedValue({ result: 'found', isError: false });
        providerMock.stream
            .mockImplementationOnce(
                streamOneToolCall({
                    id: 'call-start',
                    name: 'mcp__1__search',
                    arguments: '{"query":"alpha"}',
                })
            )
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });

        const chunks: Array<{ toolEvent?: Record<string, unknown> }> = [];
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
            onChunk: (chunk) => chunks.push(chunk as never),
        });

        expect(outcome.type).toBe('completed');
        expect(chunks).toContainEqual(
            expect.objectContaining({
                toolEvent: expect.objectContaining({
                    type: 'call_start',
                    callId: 'call-start',
                    toolName: 'search',
                    namespacedName: 'mcp__1__search',
                    source: 'mcp',
                    serverId: 1,
                }),
            })
        );
    });

    it('user waits for a pending sibling before a failed parallel round settles', async () => {
        const siblingStarted = deferred<void>();
        const siblingObservedAbort = deferred<void>();
        const releaseSibling = deferred<void>();
        builtInExecuteToolMock.mockImplementation(
            async (options: { toolCall: AiToolCall; signal?: AbortSignal }) => {
                if (options.toolCall.name === 'builtin__fail') {
                    throw new Error('first tool failed');
                }
                siblingStarted.resolve();
                options.signal?.addEventListener('abort', () => siblingObservedAbort.resolve(), {
                    once: true,
                });
                await releaseSibling.promise;
                return {
                    toolCall: options.toolCall,
                    builtInToolId: 'bash',
                    result: 'sibling finished',
                    isError: false,
                    toolLogId: null,
                };
            }
        );
        providerMock.classifyError.mockImplementationOnce(
            () => new AiError(AiErrorCode.NETWORK_ERROR)
        );
        providerMock.stream.mockImplementationOnce(async function* () {
            yield {
                content: '',
                done: true,
                finishReason: 'tool_calls',
                toolCalls: [
                    { id: 'call-fail', name: 'builtin__fail', arguments: '{}' },
                    { id: 'call-sibling', name: 'builtin__sibling', arguments: '{}' },
                ],
            };
        });

        const attempt = new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
        });
        let settled = false;
        void attempt.finally(() => {
            settled = true;
        });

        await siblingStarted.promise;
        await siblingObservedAbort.promise;
        expect(settled).toBe(false);

        releaseSibling.resolve();
        const outcome = await attempt;
        expect(outcome.type).toBe('failed');
    });

    it('user cancellation is not recorded as rejection when a parallel tool fails', async () => {
        const approvalRequested = deferred<void>();
        const approvalWait = deferred<boolean>();
        const siblingObservedCancellation = deferred<boolean>();
        builtInExecuteToolMock.mockImplementation(
            async (options: {
                toolCall: AiToolCall;
                signal?: AbortSignal;
                requestToolApproval?: (payload: { callId: string }) => Promise<boolean>;
            }) => {
                if (options.toolCall.name === 'builtin__fail') {
                    await approvalRequested.promise;
                    throw new Error('first tool failed');
                }
                const approved = await options.requestToolApproval?.({
                    callId: options.toolCall.id,
                });
                siblingObservedCancellation.resolve(
                    approved === false && options.signal?.aborted === true
                );
                if (options.signal?.aborted) {
                    throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                }
                return {
                    toolCall: options.toolCall,
                    builtInToolId: 'bash',
                    result: 'approved',
                    isError: false,
                    toolLogId: null,
                };
            }
        );
        providerMock.classifyError.mockImplementationOnce(
            () => new AiError(AiErrorCode.NETWORK_ERROR)
        );
        providerMock.stream.mockImplementationOnce(async function* () {
            yield {
                content: '',
                done: true,
                finishReason: 'tool_calls',
                toolCalls: [
                    { id: 'call-fail', name: 'builtin__fail', arguments: '{}' },
                    { id: 'call-await-approval', name: 'builtin__approval', arguments: '{}' },
                ],
            };
        });

        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
            requestToolApproval: async () => {
                approvalRequested.resolve();
                return approvalWait.promise;
            },
        });

        expect(outcome.type).toBe('failed');
        expect(await siblingObservedCancellation.promise).toBe(true);
    });

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
        updateMcpToolLogByIdMock.mockResolvedValue(undefined);
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

    it('user gets an inserted message carried into the next request after the tool result', async () => {
        resolveToolCallMock.mockResolvedValue(null);
        providerMock.stream
            .mockImplementationOnce(
                streamOneToolCall({ id: 'call-1', name: 'ghost', arguments: '{}' })
            )
            .mockImplementationOnce(async function* (request: AiRequestOptions) {
                const tail = request.messages.slice(-2);
                // The tool result stays where it belongs; the inserted user turn follows it
                // and is the last thing the model sees before answering.
                expect(tail[0]).toMatchObject({ role: 'tool' });
                expect(tail[1]).toEqual({ role: 'user', content: 'Insert this' });
                yield { content: 'Done', done: true };
            });

        const onToolBoundary = vi
            .fn()
            .mockResolvedValue([{ role: 'user', content: 'Insert this' }]);
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
            onToolBoundary,
        });

        expect(outcome.type).toBe('completed');
        expect(onToolBoundary).toHaveBeenCalledTimes(1);
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
        const chunks: Array<{ toolEvent?: Record<string, unknown> }> = [];
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister as never,
            onChunk: (chunk) => chunks.push(chunk as never),
        });

        expect(outcome.type).toBe('completed');
        expect(builtInExecuteToolMock).not.toHaveBeenCalled();
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
            expect.objectContaining({
                result: expect.stringContaining('builtin__bash'),
                toolCallId: 'call-1',
                toolCallPartId: expect.any(Number),
            })
        );
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
            getAttemptGeneration: () => 1,
            getSessionId: vi.fn(() => 1),
            persistToolCallMessage: vi.fn().mockResolvedValue(1),
            persistToolResult: vi.fn().mockResolvedValue(undefined),
            getContextMessageSource: async () => undefined,
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

    it('user switches to a text model with a retained image and receives an input error before the next request', async () => {
        builtInExecuteToolMock.mockImplementation(upgradeStub());
        resolveToolDefinitionsMock.mockResolvedValue([]);
        toolRoundThenAnswer(1);
        const checkpoint = createCheckpoint();
        checkpoint.activeModel.attachment = 1;
        checkpoint.activeModel.modalities = JSON.stringify({
            input: ['text', 'image'],
            output: ['text'],
        });
        checkpoint.messages = [
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        data: 'cGl4ZWw=',
                        mimeType: 'image/png',
                        name: 'pixel.png',
                        sourcePath: '/pixel.png',
                        size: 5,
                        kind: 'image',
                        semanticIntent: 'visual-reference',
                        meta: {
                            alias: 'image-1',
                            order: 0,
                            type: 'image',
                            name: 'pixel.png',
                            mimeType: 'image/png',
                            originPath: '/pixel.png',
                            attachmentId: 1,
                            hash: 'pixel',
                        },
                    },
                ],
            },
        ];
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: checkpoint,
            persister: persisterStub() as never,
        });
        expect(outcome.type).toBe('failed');
        if (outcome.type !== 'failed') throw new Error('Expected unsupported retained input');
        expect(outcome.error.code).toBe(AiErrorCode.UNSUPPORTED_INPUT);
        expect(outcome.modelSwitchCount).toBe(1);
        expect(outcome.partialOutputParts).toEqual([]);
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
