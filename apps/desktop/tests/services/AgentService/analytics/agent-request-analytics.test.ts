/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type {
    AttemptCheckpoint,
    AttemptExecutionResult,
    ModelWithProvider,
} from '@/services/AgentService/execution/executor';
import {
    AiConversationRuntime,
    type ExecuteRequestOptions,
    type TurnEvent,
} from '@/services/AgentService/execution/runtime';
import { AgentRequestAnalytics } from '@/services/AgentService/infrastructure/analytics';
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
    waitForRetryDelayMock,
    projectorMock,
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
    waitForRetryDelayMock: vi.fn(async () => undefined),
    projectorMock: {
        recordTurnStart: vi.fn(async () => undefined),
        getSessionId: vi.fn(() => 1),
        getTurn: vi.fn(() => ({ id: 9 })),
        markCompleted: vi.fn(async () => undefined),
        markCancelled: vi.fn(async () => undefined),
        markFailed: vi.fn(async () => undefined),
        beginNextAttempt: vi.fn(async () => undefined),
    },
}));

vi.mock('@database/queries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database/queries')>()),
    updateModelLastUsed: updateModelLastUsedMock,
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
    waitForRetryDelay: waitForRetryDelayMock,
}));

const LANGUAGE_CONTEXT = { locale: 'zh-CN', label: 'Simplified Chinese' } as const;

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

/** Terminal telemetry is backgrounded; wait for the single terminal event. */
async function waitForTerminal(): Promise<TrackedEvent> {
    await vi.waitFor(() => {
        expect(tracksOf('agent.request_completed')).toHaveLength(1);
    });
    return tracksOf('agent.request_completed')[0]!;
}

function createModel(overrides: Partial<ModelWithProvider> = {}): ModelWithProvider {
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
        ...overrides,
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

function createCheckpoint(): AttemptCheckpoint {
    return {
        activeModel: createModel(),
        messages: [{ role: 'user', content: 'hello' }],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { ...LANGUAGE_CONTEXT },
    };
}

function createCall(overrides: Record<string, unknown> = {}) {
    return {
        iteration: 0,
        modelId: 1,
        modelName: 'mimo-v2.5',
        providerId: 12,
        providerName: 'Xiaomi MiMo',
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        },
        timing: { durationMs: 5 },
        toolCallsInStep: 0,
        toolArgumentErrors: 0,
        ...overrides,
    };
}

function completedResult(
    overrides: Partial<Extract<AttemptExecutionResult, { type: 'completed' }>> = {}
): AttemptExecutionResult {
    return {
        type: 'completed',
        model: createModel(),
        response: 'Answer',
        reasoning: '',
        finalStepOutputParts: [{ type: 'text', content: 'Answer' }],
        calls: [],
        totalUsage: {
            inputTokens: 3,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        },
        firstTtftMs: 120,
        firstTextMs: 150,
        toolArgumentErrors: 0,
        usageReportedCalls: 1,
        modelSwitchCount: 0,
        hitModelSwitchCeiling: false,
        ...overrides,
    };
}

function failedResult(
    overrides: Partial<Extract<AttemptExecutionResult, { type: 'failed' }>> = {}
): AttemptExecutionResult {
    return {
        type: 'failed',
        error: new AiError(AiErrorCode.NETWORK_ERROR),
        response: '',
        reasoning: '',
        partialOutputParts: [],
        resumeCheckpoint: createCheckpoint(),
        hasVisibleOutputSinceCheckpoint: false,
        hasToolActivitySinceCheckpoint: false,
        providerErrorDetails: null,
        calls: [],
        totalUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        },
        firstTtftMs: null,
        firstTextMs: null,
        toolArgumentErrors: 0,
        usageReportedCalls: 0,
        modelSwitchCount: 0,
        hitModelSwitchCeiling: false,
        ...overrides,
    };
}

interface ExecutorStub {
    getModel: ReturnType<typeof vi.fn>;
    createInitialCheckpoint: ReturnType<typeof vi.fn>;
    runAttempt: ReturnType<typeof vi.fn>;
}

function createExecutor(): ExecutorStub {
    return {
        getModel: vi.fn(async () => createModel()),
        createInitialCheckpoint: vi.fn(() => createCheckpoint()),
        runAttempt: vi.fn(async () => completedResult()),
    };
}

function run(
    executor: ExecutorStub,
    options: Partial<ExecuteRequestOptions> = {}
): { runtime: AiConversationRuntime; events: TurnEvent[] } {
    const events: TurnEvent[] = [];
    const runtime = new AiConversationRuntime(executor as never, {
        prompt: 'hello',
        onTurnEvent: (event) => events.push(event),
        ...options,
    });

    return { runtime, events };
}

let operationSequence = 0;

interface InjectedOperation {
    operationId: string;
    enabled: boolean;
    consentEpoch: number;
}

/** Mock the native-issued handle the runtime captures at request start. */
function injectOperation(overrides: Partial<InjectedOperation> = {}): InjectedOperation {
    operationSequence += 1;
    const handle: InjectedOperation = {
        operationId: `op-${operationSequence}`,
        enabled: true,
        consentEpoch: 3,
        ...overrides,
    };
    mockTauriCommand('analytics_begin_operation', () => handle);
    mockTauriCommand('analytics_complete_operation', () => undefined);
    mockTauriCommand('analytics_track', () => ({ status: 'persisted', eventId: 'event-1' }));
    return handle;
}

function enableAnalytics(consentEpoch = 3): InjectedOperation {
    return injectOperation({ enabled: true, consentEpoch });
}

function disableAnalytics(): InjectedOperation {
    return injectOperation({ enabled: false, consentEpoch: 0 });
}

function completedOperationCalls(): string[] {
    return getTauriInvokeCalls('analytics_complete_operation').map(
        (call) => (call.payload as { operationId: string }).operationId
    );
}

describe('user runs a logical request with analytics on', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
        projectorMock.markCompleted.mockResolvedValue(undefined);
        projectorMock.markCancelled.mockResolvedValue(undefined);
        projectorMock.markFailed.mockResolvedValue(undefined);
        projectorMock.beginNextAttempt.mockResolvedValue(undefined);
    });

    it('user gets one submission and one completion sharing a fresh request id', async () => {
        const { runtime } = run(createExecutor());

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('agent.request_submitted')).toHaveLength(1);
        });
        await waitForTerminal();
        const submitted = tracksOf('agent.request_submitted');
        const completed = tracksOf('agent.request_completed');
        expect(submitted).toHaveLength(1);
        expect(completed).toHaveLength(1);
        expect(submitted[0]!.attributes.request_id).toBe(completed[0]!.attributes.request_id);
        expect(submitted[0]!.attributes).toMatchObject({
            request_kind: 'chat',
            surface: 'main',
            attachment_count_bucket: '0',
        });
        expect(completed[0]!.attributes).toMatchObject({
            result: 'success',
            persistence_result: 'saved',
            provider_ttft_ms: 120,
        });
    });

    it('user gets distinct request ids when two requests run at once', async () => {
        const first = run(createExecutor());
        const second = run(createExecutor());

        await Promise.all([first.runtime.run(), second.runtime.run()]);

        await vi.waitFor(() => {
            expect(tracksOf('agent.request_submitted')).toHaveLength(2);
            expect(tracksOf('agent.request_completed')).toHaveLength(2);
        });
        const ids = tracksOf('agent.request_submitted').map(
            (tracked) => tracked.attributes.request_id
        );
        expect(new Set(ids).size).toBe(2);
    });

    it('user gets the first output recorded only when display-ready body text arrives', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockImplementation(
            async (options: { onChunk?: (chunk: unknown) => void }) => {
                options.onChunk?.({ content: '', done: false });
                options.onChunk?.({ content: '', reasoning: 'thinking', done: false });
                options.onChunk?.({
                    content: '',
                    done: false,
                    toolEvent: { type: 'iteration_start', iteration: 0 },
                });
                options.onChunk?.({ content: '', done: false, textState: 'start' });
                options.onChunk?.({ content: 'Hello', done: false });
                options.onChunk?.({ content: ' world', done: false });
                options.onChunk?.({ content: '', done: true });
                return completedResult();
            }
        );
        const { runtime } = run(executor);

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('agent.first_output_received')).toHaveLength(1);
        });
        await waitForTerminal();
        const firstOutput = tracksOf('agent.first_output_received');
        expect(firstOutput[0]!.attributes.first_output_latency_ms).toBeGreaterThanOrEqual(0);
    });

    it('user gets the provider reported usage coverage and no fabricated cost when unpriced', async () => {
        const executor = createExecutor();
        const call = createCall({
            usage: {
                inputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 200,
            },
        });
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [call] as never, usageReportedCalls: 1 })
        );
        const { runtime } = run(executor);

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes.usage_coverage).toBe('observed');
        // 1000 input + 500 output; reasoning stays inside output and is not added twice.
        expect(completed.attributes.total_tokens).toBe(1500);
        expect(completed.attributes.cost_usd_micros).toBeUndefined();
    });

    it('user gets the known usd cost when the whole request is priced', async () => {
        findModelPricingMock.mockResolvedValue({
            modelId: 'mimo-v2.5',
            inputPerMillion: '1',
            outputPerMillion: '2',
            cacheReadPerMillion: '0',
            cacheWritePerMillion: '0',
            reasoningPerMillion: '2',
            currency: 'USD',
            tiers: [],
        });
        const executor = createExecutor();
        const call = createCall({
            usage: {
                inputTokens: 1000,
                outputTokens: 500,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
            },
        });
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [call] as never, usageReportedCalls: 1 })
        );
        const { runtime } = run(executor);

        await runtime.run();

        expect((await waitForTerminal()).attributes.cost_usd_micros).toBe(2000);
    });

    it('user gets usage marked unavailable when the provider never reported usage', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [createCall()] as never, usageReportedCalls: 0 })
        );
        const { runtime } = run(executor);

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes.usage_coverage).toBe('unavailable');
        expect(completed.attributes.total_tokens).toBeUndefined();
        expect(completed.attributes.cost_usd_micros).toBeUndefined();
    });
});

describe('user retries inside one logical request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
    });

    it('user gets one submission and one terminal with call usage summed once', async () => {
        shouldRetryRequestFailureMock.mockReturnValueOnce(true).mockReturnValue(false);
        const executor = createExecutor();
        const failedCall = createCall({
            usage: {
                inputTokens: 1,
                outputTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
            },
        });
        const completedCall = createCall({
            usage: {
                inputTokens: 2,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
            },
        });
        executor.runAttempt
            .mockResolvedValueOnce(
                failedResult({ calls: [failedCall] as never, usageReportedCalls: 1 })
            )
            .mockResolvedValueOnce(
                completedResult({ calls: [completedCall] as never, usageReportedCalls: 1 })
            );
        const { runtime } = run(executor);

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('agent.request_submitted')).toHaveLength(1);
        });
        const completed = await waitForTerminal();
        expect(completed.attributes.retry_count).toBe(1);
        // (1+1) from the retried attempt plus (2+2) from the winner, counted once.
        expect(completed.attributes.total_tokens).toBe(6);
        expect(completed.attributes.usage_coverage).toBe('observed');
    });
});

describe('user reaches a terminal result', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
        projectorMock.markCompleted.mockResolvedValue(undefined);
        projectorMock.markCancelled.mockResolvedValue(undefined);
        projectorMock.markFailed.mockResolvedValue(undefined);
        projectorMock.beginNextAttempt.mockResolvedValue(undefined);
    });

    it('user gets a failure result when the request fails', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(failedResult());
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        const completed = await waitForTerminal();
        expect(completed.attributes.result).toBe('failure');
        expect(completed.attributes.persistence_result).toBe('saved');
        expect(completed.attributes.cancel_stage).toBeUndefined();
    });

    it('user gets a failure result when the model returns an empty answer', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.EMPTY_RESPONSE) })
        );
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        expect((await waitForTerminal()).attributes.result).toBe('failure');
    });

    it('user gets a cancelled result with the streaming stage when cancelled mid-answer', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockImplementation(
            async (options: { onChunk?: (c: unknown) => void }) => {
                options.onChunk?.({ content: 'partial', done: false });
                return failedResult({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) });
            }
        );
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        const completed = await waitForTerminal();
        expect(completed.attributes.result).toBe('cancelled');
        expect(completed.attributes.cancel_stage).toBe('streaming');
    });

    it('user gets a failed save outcome when persistence fails after a saved answer', async () => {
        projectorMock.markCompleted.mockRejectedValue(new Error('database is locked'));
        const executor = createExecutor();
        const { runtime } = run(executor);

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        const completed = await waitForTerminal();
        expect(completed.attributes.result).toBe('success');
        expect(completed.attributes.persistence_result).toBe('failed');
    });
});

describe('user keeps analytics off or unreachable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
    });

    it('user gets no analytics events when statistics are off at request start', async () => {
        const handle = disableAnalytics();
        const { runtime } = run(createExecutor());

        await runtime.run();

        expect(getTauriInvokeCalls('analytics_track')).toHaveLength(0);
        await vi.waitFor(() => {
            expect(completedOperationCalls()).toEqual([handle.operationId]);
        });
    });

    it('user keeps the operation captured at start and never borrows a newer one', async () => {
        const started = enableAnalytics(3);
        const { runtime } = run(createExecutor());
        await vi.waitFor(() => {
            expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(1);
        });
        // A later request opens its own native operation; the in-flight request
        // must keep the handle it started with.
        enableAnalytics(9);

        await runtime.run();

        await waitForTerminal();
        const operationIds = new Set(trackCalls().map((tracked) => tracked.operationId));
        expect(operationIds).toEqual(new Set([started.operationId]));
        expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(1);
    });

    it('user keeps a request suppressed when it began disabled and is re-enabled mid-request', async () => {
        disableAnalytics();
        const { runtime } = run(createExecutor());
        await vi.waitFor(() => {
            expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(1);
        });
        // The user turns statistics on in another window mid-request.
        enableAnalytics(5);

        await runtime.run();

        await vi.waitFor(() => {
            expect(completedOperationCalls()).toHaveLength(1);
        });
        expect(getTauriInvokeCalls('analytics_track')).toHaveLength(0);
    });

    it('user still gets the answer when the analytics channel is down', async () => {
        mockTauriCommand('analytics_begin_operation', () => {
            throw new Error('channel down');
        });
        mockTauriCommand('analytics_track', () => ({ status: 'persisted', eventId: 'event-1' }));
        const executor = createExecutor();
        const { runtime } = run(executor);

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        expect(getTauriInvokeCalls('analytics_track')).toHaveLength(0);
        expect(getTauriInvokeCalls('analytics_complete_operation')).toHaveLength(0);
    });
});

describe('user finishes the native analytics operation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
        projectorMock.markCompleted.mockResolvedValue(undefined);
        projectorMock.markCancelled.mockResolvedValue(undefined);
        projectorMock.markFailed.mockResolvedValue(undefined);
        projectorMock.beginNextAttempt.mockResolvedValue(undefined);
    });

    it('user gets one native operation for every event, released once and last, on success', async () => {
        const handle = enableAnalytics();
        const { runtime } = run(createExecutor());

        await runtime.run();

        await vi.waitFor(() => {
            expect(completedOperationCalls()).toEqual([handle.operationId]);
        });
        const operationIds = new Set(trackCalls().map((tracked) => tracked.operationId));
        expect(operationIds).toEqual(new Set([handle.operationId]));
        expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(1);

        // The handle is released only after the events bound to it settled, so no
        // event loses its captured session or consent epoch.
        const calls = getTauriInvokeCalls();
        const releaseIndex = calls.findIndex((call) => call.cmd === 'analytics_complete_operation');
        const lastTrackIndex = calls.reduce(
            (last, call, index) => (call.cmd === 'analytics_track' ? index : last),
            -1
        );
        expect(releaseIndex).toBeGreaterThan(lastTrackIndex);
    });

    it('user gets the operation released once when the request fails', async () => {
        const handle = enableAnalytics();
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(failedResult());
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        await vi.waitFor(() => {
            expect(completedOperationCalls()).toEqual([handle.operationId]);
        });
        expect(tracksOf('agent.request_completed')).toHaveLength(1);
    });

    it('user gets the operation released once when the request is cancelled', async () => {
        const handle = enableAnalytics();
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) })
        );
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        await vi.waitFor(() => {
            expect(completedOperationCalls()).toEqual([handle.operationId]);
        });
        expect(tracksOf('agent.request_completed')).toHaveLength(1);
    });

    it('user gets the operation released once when the request cannot build its context', async () => {
        const handle = enableAnalytics();
        const executor = createExecutor();
        executor.getModel.mockRejectedValue(new AiError(AiErrorCode.INVALID_CONFIG));
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        await vi.waitFor(() => {
            expect(completedOperationCalls()).toEqual([handle.operationId]);
        });
        expect((await waitForTerminal()).attributes.result).toBe('failure');
    });

    it('user gets one terminal and one release when completion is recorded twice', async () => {
        const handle = enableAnalytics();
        const request = new AgentRequestAnalytics();
        const completion = {
            result: 'success' as const,
            retryCount: 0,
            modelSwitchCount: 0,
            persistenceResult: 'saved' as const,
            calls: [],
            usageReportedCalls: 0,
        };

        request.complete(completion);
        request.complete(completion);

        await waitForTerminal();
        await vi.waitFor(() => {
            expect(completedOperationCalls()).toEqual([handle.operationId]);
        });
        expect(tracksOf('agent.request_completed')).toHaveLength(1);
    });

    it('user gets no late approval or attachment notes after the terminal event', async () => {
        enableAnalytics();
        const request = new AgentRequestAnalytics();

        request.complete({
            result: 'cancelled',
            retryCount: 0,
            modelSwitchCount: 0,
            persistenceResult: 'saved',
            calls: [],
            usageReportedCalls: 0,
        });
        request.noteApprovalResolved({ resolution: 'approved', waitMs: 1 });
        request.noteAttachmentPreparation({
            attachments: [
                {
                    id: 'a1',
                    type: 'image',
                    path: '/tmp/a.png',
                    originPath: '/tmp/a.png',
                    name: 'a.png',
                },
            ] as never,
            result: 'success',
            durationMs: 1,
        });

        await waitForTerminal();
        expect(tracksOf('agent.approval_resolved')).toHaveLength(0);
        expect(tracksOf('attachment.preparation_completed')).toHaveLength(0);
    });

    it('user still gets the answer when the release never settles', async () => {
        enableAnalytics();
        mockTauriCommand('analytics_complete_operation', () => new Promise(() => undefined));
        const { runtime } = run(createExecutor());

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
    });

    it('user still gets the answer when the release channel throws', async () => {
        const handle = enableAnalytics();
        mockTauriCommand('analytics_complete_operation', () => {
            throw new Error('release down');
        });
        const { runtime } = run(createExecutor());

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        await vi.waitFor(() => {
            expect(completedOperationCalls()).toEqual([handle.operationId]);
        });
    });

    it('user still gets the answer when the operation start never settles', async () => {
        mockTauriCommand('analytics_begin_operation', () => new Promise(() => undefined));
        const { runtime } = run(createExecutor());

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        // The terminal attempt is captured, but its send waits on the start it
        // can never obtain; the request result must not.
        expect(getTauriInvokeCalls('analytics_track')).toHaveLength(0);
    });

    it('user still gets the answer when the pricing lookup never settles', async () => {
        enableAnalytics();
        findModelPricingMock.mockReturnValue(new Promise(() => undefined));
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [createCall()] as never, usageReportedCalls: 1 })
        );
        const { runtime } = run(executor);

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        // The terminal event needs pricing evidence; the request does not.
        expect(tracksOf('agent.request_completed')).toHaveLength(0);
    });

    it('user still gets the answer when the terminal track never settles', async () => {
        enableAnalytics();
        mockTauriCommand('analytics_track', () => new Promise(() => undefined));
        const { runtime } = run(createExecutor());

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        await vi.waitFor(() => {
            expect(tracksOf('agent.request_completed')).toHaveLength(1);
        });
    });
});

describe('user sends no private content to analytics', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
    });

    it('user never sees the prompt or a custom model name in an analytics payload', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            completedResult({
                model: createModel({ name: 'SENTINEL_MODEL', model_id: 'SENTINEL_MODEL' }),
            })
        );
        const { runtime } = run(executor, { prompt: 'SENTINEL_PROMPT' });

        await runtime.run();

        await waitForTerminal();
        const serialized = JSON.stringify(trackCalls());
        expect(serialized).not.toContain('SENTINEL_PROMPT');
        expect(serialized).not.toContain('SENTINEL_MODEL');
    });
});

describe('user decides a tool approval', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
    });

    function approvalExecutor(): ExecutorStub {
        const executor = createExecutor();
        executor.runAttempt.mockImplementation(
            async (options: { requestToolApproval?: (payload: unknown) => Promise<boolean> }) => {
                await options.requestToolApproval?.({ callId: 'call-1' });
                return completedResult();
            }
        );
        return executor;
    }

    it('user gets an approval resolution and wait when the tool is approved', async () => {
        const { runtime } = run(approvalExecutor(), {
            requestToolApproval: vi.fn(async () => true),
        });

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('agent.approval_resolved')).toHaveLength(1);
        });
        await waitForTerminal();
        const resolved = tracksOf('agent.approval_resolved');
        expect(resolved[0]!.attributes).toMatchObject({ resolution: 'approved' });
        expect(resolved[0]!.attributes.wait_ms).toBeGreaterThanOrEqual(0);
    });

    it('user gets a rejection resolution when the tool is rejected', async () => {
        const { runtime } = run(approvalExecutor(), {
            requestToolApproval: vi.fn(async () => false),
        });

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('agent.approval_resolved')).toHaveLength(1);
        });
        await waitForTerminal();
        expect(tracksOf('agent.approval_resolved')[0]!.attributes.resolution).toBe('rejected');
    });

    it('user gets a cancellation resolution when the request is aborted while waiting', async () => {
        const controller = new AbortController();
        const { runtime } = run(approvalExecutor(), {
            signal: controller.signal,
            requestToolApproval: vi.fn(async () => {
                controller.abort();
                return false;
            }),
        });

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('agent.approval_resolved')).toHaveLength(1);
        });
        await waitForTerminal();
        expect(tracksOf('agent.approval_resolved')[0]!.attributes.resolution).toBe('cancelled');
    });
});

describe('user prepares attachments for a request', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
    });

    const attachments = [
        {
            id: 'a1',
            type: 'image' as const,
            path: '/tmp/a.png',
            originPath: '/tmp/a.png',
            name: 'a.png',
        },
        {
            id: 'a2',
            type: 'file' as const,
            path: '/tmp/b.ts',
            originPath: '/tmp/b.ts',
            name: 'b.ts',
        },
    ];

    it('user gets the preparation result and merged type when attachments are prepared', async () => {
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        const { runtime } = run(createExecutor(), { attachments });

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('attachment.preparation_completed')).toHaveLength(1);
        });
        await waitForTerminal();
        const prepared = tracksOf('attachment.preparation_completed');
        expect(prepared[0]!.attributes).toMatchObject({
            attachment_type: 'other',
            count_bucket: '2-5',
            result: 'success',
        });
    });

    it('user gets a failed preparation when an attachment cannot be prepared', async () => {
        ensurePersistedAttachmentIndexMock.mockRejectedValue(new Error('disk full'));
        const { runtime } = run(createExecutor(), { attachments });

        await runtime.run();

        await vi.waitFor(() => {
            expect(tracksOf('attachment.preparation_completed')).toHaveLength(1);
        });
        await waitForTerminal();
        expect(tracksOf('attachment.preparation_completed')[0]!.attributes).toMatchObject({
            result: 'failure',
            error_category: 'other',
        });
    });
});

describe('user gets bounded diagnostics on completion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        getModelAttachmentCapabilitiesMock.mockReturnValue({
            supportsImages: true,
            supportsFiles: true,
        });
        getUnsupportedAttachmentTypesMock.mockReturnValue([]);
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue([]);
        composePromptSnapshotMock.mockResolvedValue(createSnapshot());
        buildPromptTransportMessagesMock.mockResolvedValue([{ role: 'user', content: 'hello' }]);
        getCurrentModelLanguageContextMock.mockReturnValue({ ...LANGUAGE_CONTEXT });
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
        projectorMock.markCompleted.mockResolvedValue(undefined);
        projectorMock.markCancelled.mockResolvedValue(undefined);
        projectorMock.markFailed.mockResolvedValue(undefined);
        projectorMock.beginNextAttempt.mockResolvedValue(undefined);
    });

    /** A complete USD price row so `resolveCalls` yields a priced call. */
    function usdPricing(modelId: string) {
        return {
            modelId,
            inputPerMillion: '1',
            outputPerMillion: '1',
            cacheReadPerMillion: '0',
            cacheWritePerMillion: '0',
            reasoningPerMillion: '1',
            currency: 'USD',
            tiers: [],
        };
    }

    function usage(inputTokens: number, extra: Record<string, number> = {}) {
        return {
            inputTokens,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            ...extra,
        };
    }

    it('user gets error_category none when the request succeeds', async () => {
        const { runtime } = run(createExecutor());

        await runtime.run();

        expect((await waitForTerminal()).attributes.error_category).toBe('none');
    });

    it('user gets a mapped error_category when the request fails with a network error', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.NETWORK_ERROR) })
        );
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        expect((await waitForTerminal()).attributes.error_category).toBe('network');
    });

    it('user gets other for an unclassified failure and never the raw error text', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({
                error: new AiError(AiErrorCode.UNKNOWN, undefined, 'SENTINEL_ERROR_TEXT'),
            })
        );
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        const completed = await waitForTerminal();
        expect(completed.attributes.error_category).toBe('other');
        expect(JSON.stringify(trackCalls())).not.toContain('SENTINEL_ERROR_TEXT');
    });

    it('user gets no error_category when the request is cancelled', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) })
        );
        const { runtime } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);

        expect((await waitForTerminal()).attributes.error_category).toBeUndefined();
    });

    it('user gets observed pricing coverage and the known usd cost when every call is priced', async () => {
        findModelPricingMock.mockImplementation(async (name: string) =>
            name === 'priced-model' ? usdPricing('priced-model') : null
        );
        const executor = createExecutor();
        const call = createCall({ modelName: 'priced-model', usage: usage(1000) });
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [call] as never, usageReportedCalls: 1 })
        );
        const { runtime } = run(executor);

        await runtime.run();

        expect((await waitForTerminal()).attributes).toMatchObject({
            pricing_coverage: 'observed',
            llm_call_count: 1,
            unpriced_call_count: 0,
            cost_usd_micros: 1000,
        });
    });

    it('user gets partial pricing coverage and only the priced usd cost when some calls are unpriced', async () => {
        findModelPricingMock.mockImplementation(async (name: string) =>
            name === 'priced-model' ? usdPricing('priced-model') : null
        );
        const executor = createExecutor();
        const priced = createCall({ modelName: 'priced-model', usage: usage(1000) });
        const unpriced = createCall({ modelName: 'unknown-model', usage: usage(1000) });
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [priced, unpriced] as never, usageReportedCalls: 2 })
        );
        const { runtime } = run(executor);

        await runtime.run();

        expect((await waitForTerminal()).attributes).toMatchObject({
            pricing_coverage: 'partial',
            llm_call_count: 2,
            unpriced_call_count: 1,
            cost_usd_micros: 1000,
        });
    });

    it('user gets unavailable pricing coverage and no fabricated cost when nothing is priced', async () => {
        findModelPricingMock.mockResolvedValue(null);
        const executor = createExecutor();
        const call = createCall({ modelName: 'unknown-model', usage: usage(1000) });
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [call] as never, usageReportedCalls: 1 })
        );
        const { runtime } = run(executor);

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes).toMatchObject({
            pricing_coverage: 'unavailable',
            llm_call_count: 1,
            unpriced_call_count: 1,
        });
        expect(completed.attributes.cost_usd_micros).toBeUndefined();
    });

    it('user gets cache token counts only when the provider reported them', async () => {
        const executor = createExecutor();
        const call = createCall({
            usage: usage(10, { outputTokens: 5, cacheReadTokens: 400, cacheWriteTokens: 200 }),
        });
        executor.runAttempt.mockResolvedValue(
            completedResult({ calls: [call] as never, usageReportedCalls: 1 })
        );
        const { runtime } = run(executor);

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes.cache_read_tokens).toBe(400);
        expect(completed.attributes.cache_write_tokens).toBe(200);
    });

    it('user gets no cache token counts when the provider reported none', async () => {
        const { runtime } = run(createExecutor());

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes.cache_read_tokens).toBeUndefined();
        expect(completed.attributes.cache_write_tokens).toBeUndefined();
    });

    it('user counts each retried provider call once and never more unpriced than total', async () => {
        shouldRetryRequestFailureMock.mockReturnValueOnce(true).mockReturnValue(false);
        findModelPricingMock.mockImplementation(async (name: string) =>
            name === 'priced-model' ? usdPricing('priced-model') : null
        );
        const executor = createExecutor();
        const first = createCall({ modelName: 'priced-model', usage: usage(1000) });
        const second = createCall({ modelName: 'unknown-model', usage: usage(1000) });
        executor.runAttempt
            .mockResolvedValueOnce(failedResult({ calls: [first] as never, usageReportedCalls: 1 }))
            .mockResolvedValueOnce(
                completedResult({ calls: [second] as never, usageReportedCalls: 1 })
            );
        const { runtime } = run(executor);

        await runtime.run();

        const completed = await waitForTerminal();
        expect(completed.attributes.retry_count).toBe(1);
        expect(completed.attributes.llm_call_count).toBe(2);
        expect(completed.attributes.unpriced_call_count).toBe(1);
        expect(completed.attributes.cost_usd_micros).toBe(1000);
    });
});
