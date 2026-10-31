/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type { ToolApprovalDecisionRequest } from '@/services/AgentService/contracts/tooling';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type {
    AttemptExecutionResult,
    ModelWithProvider,
    RequestExecutionCallbacks,
} from '@/services/AgentService/execution/executor';
import {
    AiConversationRuntime,
    type ExecuteRequestOptions,
} from '@/services/AgentService/execution/runtime';
import { createAiSdkStreamProcessor } from '@/services/AgentService/infrastructure/providers/ai-sdk/stream';
import type { PromptSnapshot } from '@/services/AgentService/prompt/types';

import { getTauriInvokeCalls, mockTauriCommand } from '../../../utils/tauri';

const {
    updateModelLastUsedMock,
    findModelPricingMock,
    ensurePersistedAttachmentIndexMock,
    getModelAttachmentCapabilitiesMock,
    getUnsupportedAttachmentTypesMock,
    findUnsupportedSessionAttachmentTypesMock,
    composePromptSnapshotMock,
    buildPromptTransportMessagesMock,
    getCurrentModelLanguageContextMock,
    shouldRetryRequestFailureMock,
    projectorMock,
    providerMock,
    builtInExecuteToolMock,
    resolveToolDefinitionsMock,
    createProviderForModelMock,
    getModelMock,
} = vi.hoisted(() => ({
    updateModelLastUsedMock: vi.fn(async () => undefined),
    findModelPricingMock: vi.fn(),
    ensurePersistedAttachmentIndexMock: vi.fn(async () => undefined),
    getModelAttachmentCapabilitiesMock: vi.fn(),
    getUnsupportedAttachmentTypesMock: vi.fn(),
    findUnsupportedSessionAttachmentTypesMock: vi.fn(async () => []),
    composePromptSnapshotMock: vi.fn(),
    buildPromptTransportMessagesMock: vi.fn(),
    getCurrentModelLanguageContextMock: vi.fn(),
    shouldRetryRequestFailureMock: vi.fn(() => false),
    projectorMock: {
        recordTurnStart: vi.fn(async () => undefined),
        getSessionId: vi.fn(() => 1),
        getTurn: vi.fn(() => ({ id: 9 })),
        markCompleted: vi.fn(async () => undefined),
        markCancelled: vi.fn(async () => undefined),
        markFailed: vi.fn(async () => undefined),
        beginNextAttempt: vi.fn(async () => undefined),
        persistOutputProgress: vi.fn(async () => undefined),
        persistToolCallMessage: vi.fn(async () => 1),
        persistToolResult: vi.fn(async () => undefined),
        persistCheckpoint: vi.fn(async () => undefined),
        syncDeliveryManifestRequest: vi.fn(async () => undefined),
    },
    providerMock: {
        stream: vi.fn(),
        classifyError: vi.fn(),
    },
    builtInExecuteToolMock: vi.fn(),
    resolveToolDefinitionsMock: vi.fn(async () => []),
    createProviderForModelMock: vi.fn(),
    getModelMock: vi.fn(),
}));

vi.mock('@database/queries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database/queries')>()),
    updateModelLastUsed: updateModelLastUsedMock,
    createMcpToolLog: vi.fn(async () => ({ id: 23 })),
    updateMcpToolLogByCallId: vi.fn(async () => undefined),
}));

vi.mock('@database/queries/llmMetadata', () => ({
    findModelPricing: findModelPricingMock,
}));

vi.mock('@/services/AgentService/infrastructure/attachments', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('@/services/AgentService/infrastructure/attachments')
    >()),
    ensurePersistedAttachmentIndex: ensurePersistedAttachmentIndexMock,
    getModelAttachmentCapabilities: getModelAttachmentCapabilitiesMock,
    getUnsupportedAttachmentTypes: getUnsupportedAttachmentTypesMock,
}));

vi.mock('@/services/AgentService/session/transport', () => ({
    findUnsupportedSessionAttachmentTypes: findUnsupportedSessionAttachmentTypesMock,
}));

vi.mock('@/services/AgentService/prompt/composer', () => ({
    composePromptSnapshot: composePromptSnapshotMock,
}));

vi.mock('@/services/AgentService/prompt/transport', () => ({
    buildPromptTransportMessages: buildPromptTransportMessagesMock,
}));

vi.mock('@/services/AgentService/languageContext', () => ({
    getCurrentModelLanguageContext: getCurrentModelLanguageContextMock,
}));

vi.mock('@/services/UsageService/liveUsage', () => ({
    LiveUsageTracker: vi.fn(function liveUsageTrackerStub() {
        return { start: vi.fn(), stop: vi.fn(), finish: vi.fn(), consume: vi.fn() };
    }),
}));

vi.mock('@/services/AgentService/outputs/persistence', () => ({
    PersistenceProjector: vi.fn(function persistenceProjectorStub() {
        return projectorMock;
    }),
}));

vi.mock('@/services/AgentService/execution/retry', () => ({
    MAX_REQUEST_RETRIES: 3,
    shouldRetryRequestFailure: shouldRetryRequestFailureMock,
    getRetryDelayMs: vi.fn(() => 0),
    waitForRetryDelay: vi.fn(async () => undefined),
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: {
        executeTool: builtInExecuteToolMock,
    },
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        resolveToolCall: vi.fn(),
        executeTool: vi.fn(),
    },
}));

vi.mock('@/services/AgentService/catalog', () => ({
    getModel: getModelMock,
    createProviderForModel: createProviderForModelMock,
    createProviderInstance: vi.fn(),
    resolveToolDefinitions: resolveToolDefinitionsMock,
}));

vi.mock('@/services/AgentService/infrastructure/providers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/AgentService/infrastructure/providers')>()),
    createProviderFromRegistry: vi.fn(),
}));

const LANGUAGE_CONTEXT = { locale: 'zh-CN', label: 'Simplified Chinese' } as const;

function createModel(): ModelWithProvider {
    return {
        id: 1,
        created_at: '',
        updated_at: '',
        provider_id: 12,
        model_id: 'mimo-v2.5',
        name: 'MiMo v2.5',
        is_default: 1,
        last_used_at: null,
        attachment: 1,
        modalities: '{"input":["text","image"],"output":["text"]}',
        open_weights: 0,
        reasoning: 0,
        reasoning_options: null,
        release_date: null,
        temperature: 1,
        tool_call: 1,
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
    } as ModelWithProvider;
}

function createSnapshot(): PromptSnapshot {
    return {
        id: 'prompt-1',
        createdAt: '2026-10-08T00:00:00Z',
        systemPrompt: '',
        executionMode: 'foreground',
        fragments: [],
        userPrompt: 'hello',
        attachments: [],
        modelLanguageContext: { ...LANGUAGE_CONTEXT },
    };
}

interface TrackedEvent {
    eventName: string;
    attributes: Record<string, unknown>;
    operationId: string;
}

function trackCalls(): TrackedEvent[] {
    return getTauriInvokeCalls('analytics_track').map((call) => {
        const payload = call.payload as {
            request: {
                eventName: string;
                attributes: Record<string, unknown>;
                operationId: string;
            };
        };
        return payload.request;
    });
}

function tracksOf(eventName: string): TrackedEvent[] {
    return trackCalls().filter((tracked) => tracked.eventName === eventName);
}

async function waitForTerminal(): Promise<TrackedEvent> {
    await vi.waitFor(() => {
        expect(tracksOf('agent.request_completed')).toHaveLength(1);
    });
    return tracksOf('agent.request_completed')[0]!;
}

let operationSequence = 0;

function enableAnalytics(consentEpoch = 3): string {
    operationSequence += 1;
    const operationId = `op-runtime-${operationSequence}`;
    mockTauriCommand('analytics_begin_operation', () => ({
        operationId,
        enabled: true,
        consentEpoch,
    }));
    mockTauriCommand('analytics_complete_operation', () => undefined);
    mockTauriCommand('analytics_track', () => ({ status: 'persisted', eventId: 'event-1' }));
    return operationId;
}

function createRuntime(options: Partial<ExecuteRequestOptions> = {}) {
    const executor = new AiRequestExecutor();
    const runtime = new AiConversationRuntime(executor, {
        prompt: 'hello',
        ...options,
    });

    return runtime;
}

function streamToolCalls(...toolCalls: Array<{ id: string; name: string }>) {
    return async function* () {
        yield { content: '', done: false };
        yield {
            content: '',
            done: true,
            finishReason: 'tool_calls',
            toolCalls: toolCalls.map((toolCall) => ({ ...toolCall, arguments: '{}' })),
        };
    };
}

function streamAnswer(content = 'Done') {
    return async function* () {
        yield { content, done: false };
        yield { content: '', done: true, finishReason: 'stop' };
    };
}

function builtInResult(toolCallId: string) {
    return {
        toolCall: { id: toolCallId, name: 'builtin__bash', arguments: '{}' },
        builtInToolId: 'bash',
        result: 'ok',
        isError: false,
        toolLogId: 5,
        toolLogKind: 'builtin',
    };
}

async function runExecutorAttempt(): Promise<AttemptExecutionResult> {
    const executor = new AiRequestExecutor();
    const startCheckpoint = executor.createInitialCheckpoint({
        initialModel: createModel(),
        baseMessages: [{ role: 'user', content: 'hello' }],
        modelLanguageContext: { ...LANGUAGE_CONTEXT },
    });

    return executor.runAttempt({
        startCheckpoint,
        persister: projectorMock as never,
    });
}

describe('user gets real agent telemetry from the runtime and executor seam', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelMock.mockResolvedValue(createModel());
        createProviderForModelMock.mockReturnValue(providerMock);
        resolveToolDefinitionsMock.mockResolvedValue([]);
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({
            modelId: 'mimo-v2.5',
            inputPerMillion: '1',
            outputPerMillion: '1',
            cacheReadPerMillion: '0',
            cacheWritePerMillion: '0',
            reasoningPerMillion: '1',
            currency: 'USD',
            tiers: [],
        });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        providerMock.stream.mockReset();
        providerMock.classifyError.mockReset();
        builtInExecuteToolMock.mockReset();
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    });

    afterEach(() => vi.restoreAllMocks());

    it.each([
        ['a network failure', AiErrorCode.NETWORK_ERROR],
        ['user cancellation', AiErrorCode.REQUEST_CANCELLED],
    ] as const)(
        'user gets the started call and available timing when a provider stream ends with %s',
        async (_label, code) => {
            let now = 1_800_000_000_000;
            vi.mocked(Date.now).mockImplementation(() => now);
            providerMock.stream.mockImplementationOnce(async function* () {
                now += 25;
                yield { content: 'partial', done: false };
                now += 75;
                throw new AiError(code);
            });

            const outcome = await runExecutorAttempt();

            expect(outcome.type).toBe('failed');
            if (outcome.type !== 'failed') throw new Error('expected failure');
            expect(outcome.error.code).toBe(code);
            expect(outcome.calls).toHaveLength(1);
            expect(outcome.calls[0]).toMatchObject({
                finishReason: code === AiErrorCode.REQUEST_CANCELLED ? 'aborted' : 'error',
                usageReported: false,
                timing: { ttftMs: 25, firstTextMs: 25, durationMs: 100 },
            });
            expect(outcome.usageReportedCalls).toBe(0);
            expect(outcome.firstTtftMs).toBe(25);
            expect(outcome.partialOutputParts).toEqual([{ type: 'text', content: 'partial' }]);
        }
    );

    it('user gets partial usage coverage when a real failed stream is retried successfully', async () => {
        shouldRetryRequestFailureMock.mockReturnValueOnce(true).mockReturnValue(false);
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield { content: 'partial', done: false };
                throw new AiError(AiErrorCode.NETWORK_ERROR);
            })
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: false };
                yield {
                    content: '',
                    done: true,
                    usageReported: true,
                    usage: {
                        inputTokens: 10,
                        outputTokens: 5,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        reasoningTokens: 0,
                    },
                };
            });

        await createRuntime().run();

        expect((await waitForTerminal()).attributes).toMatchObject({
            result: 'success',
            retry_count: 1,
            llm_call_count: 2,
            usage_coverage: 'partial',
            pricing_coverage: 'partial',
            unpriced_call_count: 1,
            total_tokens: 15,
            cost_usd_micros: 15,
        });
    });

    it('user counts one switch when a checkpoint after switching is retried successfully', async () => {
        shouldRetryRequestFailureMock.mockReturnValueOnce(true).mockReturnValue(false);
        const target = { ...createModel(), id: 2, model_id: 'upgraded-model' };
        builtInExecuteToolMock.mockResolvedValue({
            ...builtInResult('switch-1'),
            toolCall: { id: 'switch-1', name: 'builtin__upgrade_model', arguments: '{}' },
            controlSignal: {
                type: 'upgrade_model',
                targetModel: target,
                restartCurrentRequest: false,
            },
        });
        providerMock.stream
            .mockImplementationOnce(
                streamToolCalls({ id: 'switch-1', name: 'builtin__upgrade_model' })
            )
            .mockImplementationOnce(async function* () {
                yield { content: 'partial', done: false };
                throw new AiError(AiErrorCode.NETWORK_ERROR);
            })
            .mockImplementationOnce(streamAnswer());
        const checkpoints: Array<{ modelSwitchCount: number; iteration: number }> = [];

        const result = await createRuntime({
            taskId: 'checkpoint-task',
            onTurnEvent: (event) => {
                if (event.type === 'checkpoint_committed') checkpoints.push(event.checkpoint);
            },
        }).run();

        expect(result.model.model_id).toBe('upgraded-model');
        expect(checkpoints).toMatchObject([{ modelSwitchCount: 1, iteration: 1 }]);
        expect((await waitForTerminal()).attributes).toMatchObject({
            result: 'success',
            model_switch_count: 1,
            retry_count: 1,
            llm_call_count: 3,
        });
    });

    it('user gets streaming as the cancellation stage when cancelling a stream after a later tool round', async () => {
        const controller = new AbortController();
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield { content: 'first text', done: false };
                yield* streamToolCalls({ id: 'call-1', name: 'builtin__bash' })();
            })
            .mockImplementationOnce(async function* () {
                yield { content: '', done: false };
                controller.abort();
                throw new AiError(AiErrorCode.REQUEST_CANCELLED);
            });
        builtInExecuteToolMock.mockResolvedValue(builtInResult('call-1'));

        await expect(createRuntime({ signal: controller.signal }).run()).rejects.toMatchObject({
            code: AiErrorCode.REQUEST_CANCELLED,
        });

        expect((await waitForTerminal()).attributes).toMatchObject({
            result: 'cancelled',
            cancel_stage: 'streaming',
            tool_count: 1,
        });
        expect(tracksOf('agent.first_output_received')).toHaveLength(1);
    });

    it('user keeps approval as the cancellation stage after the cancelled tool unwinds', async () => {
        const controller = new AbortController();
        providerMock.stream.mockImplementationOnce(
            streamToolCalls({ id: 'call-1', name: 'builtin__bash' })
        );
        const approval: ToolApprovalDecisionRequest = {
            callId: 'call-1',
            title: 'Run command',
            description: '',
            command: 'controlled-command',
            riskLabel: '',
            reason: '',
            commandLabel: '',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
            enterHint: '',
            escHint: '',
        };
        builtInExecuteToolMock.mockImplementationOnce(
            async ({ requestToolApproval }: RequestExecutionCallbacks) => {
                await requestToolApproval?.(approval);
                throw new AiError(AiErrorCode.REQUEST_CANCELLED);
            }
        );

        await expect(
            createRuntime({
                signal: controller.signal,
                requestToolApproval: async () => {
                    controller.abort();
                    await Promise.resolve();
                    return false;
                },
            }).run()
        ).rejects.toMatchObject({ code: AiErrorCode.REQUEST_CANCELLED });

        expect((await waitForTerminal()).attributes).toMatchObject({
            result: 'cancelled',
            cancel_stage: 'approval',
            tool_count: 1,
            approval_count: 1,
        });
        expect(tracksOf('agent.approval_resolved')[0]!.attributes.resolution).toBe('cancelled');
        expect(tracksOf('agent.tool_completed')[0]!.attributes.result).toBe('cancelled');
    });

    it('user gets one tool completion and tool_count one when a built-in tool finishes', async () => {
        providerMock.stream
            .mockImplementationOnce(streamToolCalls({ id: 'call-1', name: 'builtin__bash' }))
            .mockImplementationOnce(streamAnswer());
        builtInExecuteToolMock.mockResolvedValue(builtInResult('call-1'));
        const runtime = createRuntime();

        const result = await runtime.run();

        expect(result.response).toBe('Done');
        await vi.waitFor(() => {
            expect(tracksOf('agent.tool_completed')).toHaveLength(1);
        });
        const toolCompleted = tracksOf('agent.tool_completed')[0]!;
        expect(toolCompleted.attributes).toMatchObject({
            tool_category: 'command',
            result: 'success',
        });
        const completed = await waitForTerminal();
        expect(completed.attributes).toMatchObject({
            result: 'success',
            tool_count: 1,
        });
        expect(tracksOf('agent.request_completed')).toHaveLength(1);
    });

    it('user gets no reported usage calls when the provider sends an empty usage object', async () => {
        const processor = createAiSdkStreamProcessor();
        providerMock.stream.mockImplementationOnce(async function* () {
            yield { content: 'Done', done: false };
            yield processor.buildFinishChunk('stop', {} as never);
        });

        const outcome = await runExecutorAttempt();

        expect(outcome.type).toBe('completed');
        if (outcome.type !== 'completed') {
            throw new Error('expected a completed attempt');
        }
        expect(outcome.usageReportedCalls).toBe(0);
        expect(outcome.calls).toHaveLength(1);
        expect(outcome.calls[0]!.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
    });

    it('user gets one reported usage call when the provider explicitly reports zero', async () => {
        const processor = createAiSdkStreamProcessor();
        providerMock.stream.mockImplementationOnce(async function* () {
            yield { content: 'Done', done: false };
            yield processor.buildFinishChunk('stop', {
                inputTokens: 0,
                outputTokens: 0,
            } as never);
        });

        const outcome = await runExecutorAttempt();

        expect(outcome.type).toBe('completed');
        if (outcome.type !== 'completed') {
            throw new Error('expected a completed attempt');
        }
        expect(outcome.usageReportedCalls).toBe(1);
    });

    it('user gets unavailable usage and no fabricated cost when the provider sends an empty usage object', async () => {
        const processor = createAiSdkStreamProcessor();
        providerMock.stream.mockImplementationOnce(async function* () {
            yield { content: 'Done', done: false };
            // The SDK shape for "no usage reported": every field is undefined.
            yield processor.buildFinishChunk('stop', {} as never);
        });
        const runtime = createRuntime();

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes).toMatchObject({
            usage_coverage: 'unavailable',
            pricing_coverage: 'unavailable',
        });
        expect(completed.attributes.total_tokens).toBeUndefined();
        expect(completed.attributes.cost_usd_micros).toBeUndefined();
    });

    it('user gets observed zero usage when the provider explicitly reports zero tokens', async () => {
        const processor = createAiSdkStreamProcessor();
        providerMock.stream.mockImplementationOnce(async function* () {
            yield { content: 'Done', done: false };
            yield processor.buildFinishChunk('stop', {
                inputTokens: 0,
                outputTokens: 0,
            } as never);
        });
        const runtime = createRuntime();

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes).toMatchObject({
            usage_coverage: 'observed',
            pricing_coverage: 'observed',
            total_tokens: 0,
            cost_usd_micros: 0,
        });
    });

    it('user sees no late tool completion after a cancelled request has already completed', async () => {
        const controller = new AbortController();
        let releaseSecondTool: (() => void) | undefined;
        const secondToolGate = new Promise<void>((resolve) => {
            releaseSecondTool = resolve;
        });
        builtInExecuteToolMock.mockImplementation(
            async ({ toolCall }: { toolCall: { id: string } }) => {
                if (toolCall.id === 'call-1') {
                    // Let the second parallel tool start before the abort lands,
                    // so this really is a late completion after cancellation.
                    await Promise.resolve();
                    controller.abort();
                    throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                }
                await secondToolGate;
                return builtInResult('call-2');
            }
        );
        providerMock.stream.mockImplementationOnce(
            streamToolCalls(
                { id: 'call-1', name: 'builtin__bash' },
                { id: 'call-2', name: 'builtin__bash' }
            )
        );
        const startedOperation = operationSequence;
        const runtime = createRuntime({ signal: controller.signal });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        const completed = await waitForTerminal();
        expect(completed.attributes).toMatchObject({
            result: 'cancelled',
            tool_count: 1,
        });

        // The user re-enables analytics in another window while the second tool
        // is still finishing; the late completion must neither be sent nor be
        // rebound to the newer consent epoch.
        enableAnalytics(9);
        releaseSecondTool?.();
        // Let the still-running tool return and any note it makes run; a false
        // positive would only happen if the guard let it through.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(tracksOf('agent.tool_completed')).toHaveLength(1);
        expect(tracksOf('agent.request_completed')).toHaveLength(1);
        const operationIds = new Set(trackCalls().map((tracked) => tracked.operationId));
        expect(operationIds).toEqual(new Set([`op-runtime-${startedOperation}`]));
    });
});
