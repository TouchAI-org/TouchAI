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
    summarizeTaskModel,
    type TurnEvent,
} from '@/services/AgentService/execution/runtime';
import type { PromptSnapshot } from '@/services/AgentService/prompt/types';

/** Kept small so the retry-exhaustion path runs without a long test. */
const MAX_RETRIES = 3;

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
    trackerMock,
    projectorMock,
} = vi.hoisted(() => ({
    updateModelLastUsedMock: vi.fn(),
    findModelPricingMock: vi.fn(),
    ensurePersistedAttachmentIndexMock: vi.fn(),
    getModelAttachmentCapabilitiesMock: vi.fn(),
    getUnsupportedAttachmentTypesMock: vi.fn(),
    findUnsupportedSessionAttachmentTypesMock: vi.fn(),
    composePromptSnapshotMock: vi.fn(),
    buildPromptTransportMessagesMock: vi.fn(),
    getCurrentModelLanguageContextMock: vi.fn(),
    shouldRetryRequestFailureMock: vi.fn(),
    waitForRetryDelayMock: vi.fn(async () => undefined),
    trackerMock: {
        start: vi.fn(),
        stop: vi.fn(),
        finish: vi.fn(),
        consume: vi.fn(),
    },
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
        return trackerMock;
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

function createSnapshot(overrides: Partial<PromptSnapshot> = {}): PromptSnapshot {
    return {
        id: 'prompt-1',
        createdAt: '2026-10-08T00:00:00Z',
        systemPrompt: '',
        executionMode: 'foreground',
        fragments: [],
        userPrompt: 'hello',
        attachments: [],
        modelLanguageContext: { ...LANGUAGE_CONTEXT },
        ...overrides,
    };
}

function createCheckpoint(overrides: Partial<AttemptCheckpoint> = {}): AttemptCheckpoint {
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
        ...overrides,
    };
}

function emptyUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
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
        totalUsage: { ...emptyUsage(), inputTokens: 3, outputTokens: 5 },
        firstTtftMs: 120,
        firstTextMs: 150,
        toolArgumentErrors: 0,
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
        totalUsage: emptyUsage(),
        firstTtftMs: null,
        firstTextMs: null,
        toolArgumentErrors: 0,
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
): {
    runtime: AiConversationRuntime;
    events: TurnEvent[];
    chunks: unknown[];
} {
    const events: TurnEvent[] = [];
    const chunks: unknown[] = [];
    const runtime = new AiConversationRuntime(executor as never, {
        prompt: 'hello',
        onTurnEvent: (event) => events.push(event),
        onChunk: (chunk) => chunks.push(chunk),
        ...options,
    });

    return { runtime, events, chunks };
}

describe('user starts a turn that needs a new conversation', () => {
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
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
        projectorMock.markCompleted.mockResolvedValue(undefined);
        projectorMock.markCancelled.mockResolvedValue(undefined);
        projectorMock.markFailed.mockResolvedValue(undefined);
        projectorMock.beginNextAttempt.mockResolvedValue(undefined);
    });

    it('user sees the turn saved before the answer starts streaming', async () => {
        const executor = createExecutor();
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(projectorMock.recordTurnStart).toHaveBeenCalledTimes(1);
        expect(events.map((event) => event.type)).toEqual([
            'prompt_snapshot_ready',
            'task_started',
            'task_completed',
        ]);
    });

    it('user sees the turn start carry the conversation and reply ids', async () => {
        const executor = createExecutor();
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(events[1]).toMatchObject({
            type: 'task_started',
            taskId: 'task-1',
            sessionId: 1,
            turnId: 9,
            executionMode: 'foreground',
            model: { modelId: 'mimo-v2.5', providerName: 'Xiaomi MiMo' },
        });
    });

    it('user sees the turn start survive a reply id that is not saved yet', async () => {
        projectorMock.getTurn.mockReturnValue(null as never);
        const executor = createExecutor();
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(events[1]).toMatchObject({ type: 'task_started', turnId: null });
    });

    it('user sees no live task events when the request runs outside a task', async () => {
        const executor = createExecutor();
        const { runtime, events } = run(executor);

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        // Without a task id the UI has nothing to attach live progress to.
        expect(events).toEqual([]);
    });

    it('user sees the background request run in the mode the caller asked for', async () => {
        const executor = createExecutor();
        const { runtime, events } = run(executor, {
            taskId: 'task-1',
            executionMode: 'background',
        });

        await runtime.run();

        expect(events[1]).toMatchObject({ executionMode: 'background' });
    });

    it('user keeps the conversation when saving its start fails', async () => {
        const failure = new Error('database is locked');
        projectorMock.recordTurnStart.mockRejectedValue(failure);
        const reportPersistenceIssue = vi.fn();
        const executor = createExecutor();
        const { runtime } = run(executor, {
            taskId: 'task-1',
            environment: { reportPersistenceIssue },
        });

        const result = await runtime.run();

        // A failed bookkeeping write must not lose the answer the user already paid for.
        expect(result.response).toBe('Answer');
        expect(reportPersistenceIssue).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'turn_start', error: failure })
        );
    });

    it('user still gets the answer when nobody listens for persistence problems', async () => {
        projectorMock.recordTurnStart.mockRejectedValue(new Error('database is locked'));
        const executor = createExecutor();
        const { runtime } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).resolves.toMatchObject({ response: 'Answer' });
    });

    it('user still gets the answer when reporting a persistence problem throws', async () => {
        projectorMock.recordTurnStart.mockRejectedValue(new Error('database is locked'));
        const reportPersistenceIssue = vi.fn(() => {
            throw new Error('notification channel closed');
        });
        const executor = createExecutor();
        const { runtime } = run(executor, {
            taskId: 'task-1',
            environment: { reportPersistenceIssue },
        });

        await expect(runtime.run()).resolves.toMatchObject({ response: 'Answer' });
    });
});

describe('user sends attachments with the prompt', () => {
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
        findModelPricingMock.mockResolvedValue(null);
        updateModelLastUsedMock.mockResolvedValue(undefined);
        ensurePersistedAttachmentIndexMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
    });

    function imageAttachment() {
        return {
            id: 'attachment-1',
            type: 'image',
            name: 'chart.png',
            path: 'D:/cache/chart.png',
            originPath: 'D:/origin/chart.png',
            mimeType: 'image/png',
            size: 12,
        } as never;
    }

    it('user is told which attachments the chosen model cannot read', async () => {
        getUnsupportedAttachmentTypesMock.mockReturnValue(['image']);
        const executor = createExecutor();
        const { runtime } = run(executor, { attachments: [imageAttachment()] });

        await expect(runtime.run()).rejects.toMatchObject({
            code: AiErrorCode.UNSUPPORTED_INPUT,
        });
        // The turn must not start at all when the model cannot read the input.
        expect(projectorMock.recordTurnStart).not.toHaveBeenCalled();
        expect(executor.runAttempt).not.toHaveBeenCalled();
    });

    it('user is told when an attachment from earlier in the conversation no longer fits the model', async () => {
        findUnsupportedSessionAttachmentTypesMock.mockResolvedValue(['file']);
        const executor = createExecutor();
        const { runtime } = run(executor, { sessionId: 4 });

        await expect(runtime.run()).rejects.toMatchObject({
            code: AiErrorCode.UNSUPPORTED_INPUT,
        });
        expect(projectorMock.recordTurnStart).not.toHaveBeenCalled();
    });

    it('user sees attachments saved before the request so they can be reused', async () => {
        const executor = createExecutor();
        const { runtime } = run(executor, { attachments: [imageAttachment()] });

        await runtime.run();

        expect(ensurePersistedAttachmentIndexMock).toHaveBeenCalledTimes(1);
    });

    it('user still gets the answer when an attachment cannot be saved first', async () => {
        const failure = new Error('disk full');
        ensurePersistedAttachmentIndexMock.mockRejectedValue(failure);
        const reportPersistenceIssue = vi.fn();
        const executor = createExecutor();
        const { runtime } = run(executor, {
            attachments: [imageAttachment()],
            environment: { reportPersistenceIssue },
        });

        const result = await runtime.run();

        // The raw file can still be sent inline, so the turn proceeds.
        expect(result.response).toBe('Answer');
        expect(reportPersistenceIssue).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'attachment_prepare', error: failure })
        );
    });
});

describe('user asks a follow-up in an existing conversation', () => {
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
        findModelPricingMock.mockResolvedValue(null);
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
    });

    it('user sees the prompt built from their message when none was frozen yet', async () => {
        const executor = createExecutor();
        const { runtime, events } = run(executor, { taskId: 'task-1', sessionId: 4 });

        await runtime.run();

        expect(composePromptSnapshotMock).toHaveBeenCalledWith(
            expect.objectContaining({ prompt: 'hello', executionMode: 'foreground' })
        );
        expect(events[0]).toMatchObject({ type: 'prompt_snapshot_ready' });
    });

    it('user keeps the frozen prompt on a retry instead of rebuilding it', async () => {
        const frozen = createSnapshot({ userPrompt: 'frozen prompt' });
        const executor = createExecutor();
        const { runtime, events } = run(executor, { taskId: 'task-1', promptSnapshot: frozen });

        await runtime.run();

        expect(composePromptSnapshotMock).not.toHaveBeenCalled();
        expect(events[0]).toMatchObject({ snapshot: frozen });
    });

    it('user gets the app language when the frozen prompt carries none', async () => {
        const frozen = createSnapshot({ modelLanguageContext: undefined as never });
        const executor = createExecutor();
        const { runtime } = run(executor, { taskId: 'task-1', promptSnapshot: frozen });

        await runtime.run();

        expect(executor.createInitialCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({ modelLanguageContext: LANGUAGE_CONTEXT })
        );
    });
});

describe('user watches live usage while the answer streams', () => {
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
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
    });

    it('user sees the live cost estimate based on the model price', async () => {
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        const executor = createExecutor();
        const { runtime } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(trackerMock.start).toHaveBeenCalled();
        expect(trackerMock.finish).toHaveBeenCalledWith(
            expect.objectContaining({ outputTokens: 5 })
        );
    });

    it('user sees no cost estimate for a model that has no price', async () => {
        findModelPricingMock.mockResolvedValue(null);
        const executor = createExecutor();
        const { runtime } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(trackerMock.finish).toHaveBeenCalled();
    });

    it('user still gets the answer when the price lookup fails', async () => {
        findModelPricingMock.mockRejectedValue(new Error('metadata table missing'));
        const executor = createExecutor();
        const { runtime } = run(executor, { taskId: 'task-1' });

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
    });

    it('user sees no live usage panel when the request runs outside a task', async () => {
        findModelPricingMock.mockResolvedValue(null);
        const executor = createExecutor();
        const { runtime } = run(executor);

        await runtime.run();

        expect(trackerMock.start).not.toHaveBeenCalled();
        expect(trackerMock.finish).not.toHaveBeenCalled();
    });

    it('user sees the live usage panel start before the conversation is saved', async () => {
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        // The conversation id is only known once the turn record exists.
        projectorMock.getSessionId.mockReturnValue(null as never);
        const executor = createExecutor();
        const { runtime } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).resolves.toMatchObject({ response: 'Answer' });
        expect(trackerMock.start).toHaveBeenCalled();
    });

    it('user sees each streamed chunk reach the panel and the live usage count', async () => {
        findModelPricingMock.mockResolvedValue({ outputPerMillion: '15' });
        const executor = createExecutor();
        executor.runAttempt.mockImplementation(
            async (options: { onChunk?: (chunk: unknown) => void }) => {
                options.onChunk?.({ content: 'Hel', done: false });
                options.onChunk?.({ content: 'lo', done: true });
                return completedResult();
            }
        );
        const { runtime, chunks } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(chunks).toEqual([
            { content: 'Hel', done: false },
            { content: 'lo', done: true },
        ]);
        expect(trackerMock.consume).toHaveBeenCalledTimes(2);
    });

    it('user sees live usage stop when the turn completes', async () => {
        findModelPricingMock.mockResolvedValue(null);
        const executor = createExecutor();
        const { runtime } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(trackerMock.finish).toHaveBeenCalledTimes(1);
    });
});

describe('user waits through a failed attempt that can be retried', () => {
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
        findModelPricingMock.mockResolvedValue(null);
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(true);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
    });

    it('user sees the retry scheduled with the attempt number and reason', async () => {
        const executor = createExecutor();
        executor.runAttempt
            .mockResolvedValueOnce(failedResult({ error: new AiError(AiErrorCode.NETWORK_ERROR) }))
            .mockResolvedValueOnce(completedResult());
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(projectorMock.beginNextAttempt).toHaveBeenCalledWith(
            expect.any(String),
            expect.anything(),
            expect.objectContaining({ calls: [] })
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'retry_scheduled',
                attempt: 1,
                maxRetries: MAX_RETRIES,
            })
        );
    });

    it('user sees the retry resume from the last safe point instead of the start', async () => {
        const resumeCheckpoint = createCheckpoint({ iteration: 2, response: 'partial' });
        const executor = createExecutor();
        executor.runAttempt
            .mockResolvedValueOnce(failedResult({ resumeCheckpoint }))
            .mockResolvedValueOnce(completedResult());
        const { runtime, chunks } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(executor.runAttempt).toHaveBeenLastCalledWith(
            expect.objectContaining({ startCheckpoint: resumeCheckpoint })
        );
        expect(chunks).toContainEqual(
            expect.objectContaining({
                toolEvent: expect.objectContaining({
                    type: 'request_retry',
                    retryScope: 'checkpoint',
                    resumeFromIteration: 2,
                }),
            })
        );
    });

    it('user sees a first-attempt retry described as a restart', async () => {
        const executor = createExecutor();
        executor.runAttempt
            .mockResolvedValueOnce(failedResult({ resumeCheckpoint: createCheckpoint() }))
            .mockResolvedValueOnce(completedResult());
        const { runtime, chunks } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(chunks).toContainEqual(
            expect.objectContaining({
                toolEvent: expect.objectContaining({
                    type: 'request_retry',
                    retryScope: 'restart',
                }),
            })
        );
    });

    it('user sees output and tool activity discarded when the retry restarts the step', async () => {
        const executor = createExecutor();
        executor.runAttempt
            .mockResolvedValueOnce(
                failedResult({
                    hasVisibleOutputSinceCheckpoint: true,
                    hasToolActivitySinceCheckpoint: true,
                })
            )
            .mockResolvedValueOnce(completedResult());
        const { runtime, chunks } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(chunks).toContainEqual(
            expect.objectContaining({
                toolEvent: expect.objectContaining({
                    discardVisibleOutputSinceCheckpoint: true,
                    discardToolActivitySinceCheckpoint: true,
                }),
            })
        );
    });

    it('user keeps waiting for the answer when saving the retry fails', async () => {
        const failure = new Error('database is locked');
        projectorMock.beginNextAttempt.mockRejectedValue(failure);
        const reportPersistenceIssue = vi.fn();
        const executor = createExecutor();
        executor.runAttempt
            .mockResolvedValueOnce(failedResult())
            .mockResolvedValueOnce(completedResult());
        const { runtime } = run(executor, {
            taskId: 'task-1',
            environment: { reportPersistenceIssue },
        });

        const result = await runtime.run();

        expect(result.response).toBe('Answer');
        expect(reportPersistenceIssue).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'retry_started', error: failure })
        );
    });

    it('user sees the retry reported without a task when no task is running', async () => {
        const executor = createExecutor();
        executor.runAttempt
            .mockResolvedValueOnce(failedResult())
            .mockResolvedValueOnce(completedResult());
        const { runtime, events, chunks } = run(executor);

        await runtime.run();

        expect(events).toEqual([]);
        // The streaming panel still shows the retry even outside a task.
        expect(chunks).toContainEqual(
            expect.objectContaining({
                toolEvent: expect.objectContaining({ type: 'request_retry' }),
            })
        );
    });
});

describe('user is told when the request cannot be retried any further', () => {
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
        findModelPricingMock.mockResolvedValue(null);
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
    });

    it('user sees the turn marked failed with the reason the model gave', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.UNAUTHORIZED) })
        );
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toMatchObject({
            code: AiErrorCode.UNAUTHORIZED,
        });
        expect(projectorMock.markFailed).toHaveBeenCalledWith(
            expect.any(String),
            expect.anything(),
            expect.objectContaining({ retryScope: 'restart' })
        );
        expect(events).toContainEqual(expect.objectContaining({ type: 'task_failed', turnId: 9 }));
    });

    it('user sees a failure after a retry recorded against the checkpoint it resumed from', async () => {
        const resumeCheckpoint = createCheckpoint({ iteration: 3 });
        const executor = createExecutor();
        // One retry happens (so the loop adopts the resumed checkpoint), then retries stop.
        shouldRetryRequestFailureMock.mockReturnValueOnce(true);
        executor.runAttempt
            .mockResolvedValueOnce(failedResult({ resumeCheckpoint }))
            .mockResolvedValueOnce(failedResult({ resumeCheckpoint }));
        const { runtime } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(projectorMock.markFailed).toHaveBeenCalledWith(
            expect.any(String),
            expect.anything(),
            expect.objectContaining({ retryScope: 'checkpoint' })
        );
    });

    it('user still sees the failure when saving it fails', async () => {
        const failure = new Error('database is locked');
        projectorMock.markFailed.mockRejectedValue(failure);
        const reportPersistenceIssue = vi.fn();
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(failedResult());
        const { runtime, events } = run(executor, {
            taskId: 'task-1',
            environment: { reportPersistenceIssue },
        });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(reportPersistenceIssue).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'turn_failed', error: failure })
        );
        expect(events).toContainEqual(expect.objectContaining({ type: 'task_failed' }));
    });

    it('user sees the failure reported without a task when no task is running', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(failedResult());
        const { runtime, events } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toEqual([]);
        expect(projectorMock.markFailed).toHaveBeenCalled();
    });

    it('user is told the request failed after every retry slot is spent', async () => {
        const executor = createExecutor();
        shouldRetryRequestFailureMock.mockReturnValue(true);
        const lastError = new AiError(AiErrorCode.NETWORK_ERROR);
        executor.runAttempt.mockResolvedValue(failedResult({ error: lastError }));
        const { runtime } = run(executor);

        // The last loop slot can no longer retry, so the failure is surfaced, not swallowed.
        await expect(runtime.run()).rejects.toMatchObject({
            code: AiErrorCode.NETWORK_ERROR,
        });
        expect(executor.runAttempt).toHaveBeenCalledTimes(MAX_RETRIES + 1);
        expect(projectorMock.markFailed).toHaveBeenCalledTimes(1);
    });
});

describe('user cancels a running request', () => {
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
        findModelPricingMock.mockResolvedValue(null);
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
    });

    it('user sees the partial answer kept when the request is cancelled', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({
                error: new AiError(AiErrorCode.REQUEST_CANCELLED),
                partialOutputParts: [{ type: 'text', content: 'Half an ans' }],
            })
        );
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toMatchObject({
            code: AiErrorCode.REQUEST_CANCELLED,
        });
        expect(projectorMock.markCancelled).toHaveBeenCalledWith(
            [{ type: 'text', content: 'Half an ans' }],
            expect.objectContaining({ calls: [] })
        );
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'task_cancelled', turnId: 9 })
        );
    });

    it('user sees the cancellation reported without a task when no task is running', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) })
        );
        const { runtime, events } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toEqual([]);
        expect(projectorMock.markCancelled).toHaveBeenCalled();
    });

    it('user still sees the cancellation when saving it fails', async () => {
        const failure = new Error('database is locked');
        projectorMock.markCancelled.mockRejectedValue(failure);
        const reportPersistenceIssue = vi.fn();
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) })
        );
        const { runtime, events } = run(executor, {
            taskId: 'task-1',
            environment: { reportPersistenceIssue },
        });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(reportPersistenceIssue).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'turn_cancelled', error: failure })
        );
        expect(events).toContainEqual(expect.objectContaining({ type: 'task_cancelled' }));
    });

    it('user sees the cancellation stop the live usage panel', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) })
        );
        const { runtime } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(trackerMock.stop).toHaveBeenCalled();
    });

    it('user is told the request was cancelled when it never reached the model', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new AiError(AiErrorCode.REQUEST_CANCELLED));
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toMatchObject({
            code: AiErrorCode.REQUEST_CANCELLED,
        });
        expect(projectorMock.markCancelled).toHaveBeenCalledWith();
        expect(events).toContainEqual(expect.objectContaining({ type: 'task_cancelled' }));
    });

    it('user still sees the cancellation when saving the untouched turn fails', async () => {
        const failure = new Error('database is locked');
        projectorMock.markCancelled.mockRejectedValue(failure);
        const reportPersistenceIssue = vi.fn();
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new AiError(AiErrorCode.REQUEST_CANCELLED));
        const { runtime } = run(executor, {
            taskId: 'task-1',
            environment: { reportPersistenceIssue },
        });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(reportPersistenceIssue).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'turn_cancelled', error: failure })
        );
    });

    it('user sees the untouched turn marked cancelled without a task', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new AiError(AiErrorCode.REQUEST_CANCELLED));
        const { runtime, events } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toEqual([]);
        expect(projectorMock.markCancelled).toHaveBeenCalled();
    });
});

describe('user hits an unexpected problem before the model answers', () => {
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
        findModelPricingMock.mockResolvedValue(null);
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        projectorMock.getTurn.mockReturnValue({ id: 9 });
    });

    it('user sees an unexpected crash reported as a failed turn', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new Error('boom'));
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(projectorMock.markFailed).toHaveBeenCalledWith(expect.stringContaining('boom'));
        expect(events).toContainEqual(expect.objectContaining({ type: 'task_failed' }));
    });

    it('user still sees the crash when saving it fails', async () => {
        const failure = new Error('database is locked');
        projectorMock.markFailed.mockRejectedValue(failure);
        const reportPersistenceIssue = vi.fn();
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new Error('boom'));
        const { runtime } = run(executor, {
            taskId: 'task-1',
            environment: { reportPersistenceIssue },
        });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(reportPersistenceIssue).toHaveBeenCalledWith(
            expect.objectContaining({ phase: 'turn_failed', error: failure })
        );
    });

    it('user sees the crash reported without a task when no task is running', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new Error('boom'));
        const { runtime, events } = run(executor);

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toEqual([]);
        expect(projectorMock.markFailed).toHaveBeenCalled();
    });

    it('user sees no second failure record when the turn already closed itself', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(completedResult());
        projectorMock.markCompleted.mockRejectedValue(new Error('database is locked'));
        updateModelLastUsedMock.mockRejectedValue(new Error('database is locked'));
        const { runtime } = run(executor, { taskId: 'task-1' });

        // Completion bookkeeping is best-effort: the answer still reaches the user.
        await expect(runtime.run()).resolves.toMatchObject({ response: 'Answer' });
        expect(projectorMock.markFailed).not.toHaveBeenCalled();
    });
});

describe('user reads the model summary attached to a task event', () => {
    it('user sees the provider and model names the task reports', () => {
        const summary = summarizeTaskModel(createModel());

        expect(summary).toEqual({
            modelDbId: 1,
            providerId: 12,
            providerName: 'Xiaomi MiMo',
            modelId: 'mimo-v2.5',
            modelName: 'MiMo v2.5',
        });
    });
});

describe('user is kept informed when the turn record itself is missing', () => {
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
        findModelPricingMock.mockResolvedValue(null);
        updateModelLastUsedMock.mockResolvedValue(undefined);
        shouldRetryRequestFailureMock.mockReturnValue(false);
        projectorMock.getSessionId.mockReturnValue(1);
        // The turn row never made it to the database.
        projectorMock.getTurn.mockReturnValue(null as never);
        projectorMock.recordTurnStart.mockResolvedValue(undefined);
        projectorMock.markCompleted.mockResolvedValue(undefined);
        projectorMock.markCancelled.mockResolvedValue(undefined);
        projectorMock.markFailed.mockResolvedValue(undefined);
    });

    it('user sees the completion reported without a turn id', async () => {
        const executor = createExecutor();
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await runtime.run();

        expect(events).toContainEqual(
            expect.objectContaining({ type: 'task_completed', turnId: null })
        );
    });

    it('user sees the failure reported without a turn id', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(failedResult());
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'task_failed', turnId: null })
        );
    });

    it('user sees the cancellation reported without a turn id', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockResolvedValue(
            failedResult({ error: new AiError(AiErrorCode.REQUEST_CANCELLED) })
        );
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'task_cancelled', turnId: null })
        );
    });

    it('user sees an early cancellation reported without a turn id', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new AiError(AiErrorCode.REQUEST_CANCELLED));
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'task_cancelled', turnId: null })
        );
    });

    it('user sees an early crash reported without a turn id', async () => {
        const executor = createExecutor();
        executor.runAttempt.mockRejectedValue(new Error('boom'));
        const { runtime, events } = run(executor, { taskId: 'task-1' });

        await expect(runtime.run()).rejects.toBeInstanceOf(AiError);
        expect(events).toContainEqual(
            expect.objectContaining({ type: 'task_failed', turnId: null })
        );
    });
});
