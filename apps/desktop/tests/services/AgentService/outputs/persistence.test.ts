/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiCallRecord } from '@/services/AgentService/contracts/protocol';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';
import { PersistenceProjector } from '@/services/AgentService/outputs/persistence';

const queries = vi.hoisted(() => ({
    createMessage: vi.fn(),
    createMessageParts: vi.fn(),
    updateMessage: vi.fn(),
    syncOutputParts: vi.fn(),
    createSession: vi.fn(),
    createSessionTurn: vi.fn(),
    createSessionTurnAttempt: vi.fn(),
    updateSession: vi.fn(),
    updateSessionTurn: vi.fn(),
    updateSessionTurnAttempt: vi.fn(),
    updateSessionTurnUsage: vi.fn(),
    updateSessionTurnAttemptUsage: vi.fn(),
    refreshSessionMetadata: vi.fn(),
    appendMessagePart: vi.fn(),
    findToolCallPartByCallId: vi.fn(),
    mergeMessagePartData: vi.fn(),
    createMessageAttachment: vi.fn(),
    findAllBuiltInTools: vi.fn(),
    findAllMcpTools: vi.fn(),
}));

const usage = vi.hoisted(() => ({
    resolveCalls: vi.fn(),
    sumUsage: vi.fn(),
    sumCost: vi.fn(),
    countUnpriced: vi.fn(),
    insertLlmCallParts: vi.fn(),
}));

vi.mock('@database', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database')>()),
    db: { transaction: (callback: (tx: unknown) => Promise<unknown>) => callback({}) },
}));

vi.mock('@database/queries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database/queries')>()),
    ...queries,
}));

vi.mock('@/services/UsageService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/UsageService')>()),
    ...usage,
}));

vi.mock('@/services/UsageService/contextBreakdown', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/UsageService/contextBreakdown')>()),
    buildPromptBreakdown: vi.fn(() => ({ total: 42 })),
}));

vi.mock('@/services/AgentService/infrastructure/attachments', async (importOriginal) => ({
    ...(await importOriginal<
        typeof import('@/services/AgentService/infrastructure/attachments')
    >()),
    prepareAttachmentForPersistence: vi.fn(async () => undefined),
    persistPreparedAttachment: vi.fn(async () => ({
        id: 7,
        origin_path: 'D:/origin/seven.txt',
    })),
    ensurePersistedAttachmentIndex: vi.fn(async () => ({ id: 8 })),
}));

function createSnapshot() {
    return {
        id: 'prompt-1',
        createdAt: '2026-10-08T00:00:00Z',
        systemPrompt: '',
        executionMode: 'foreground' as const,
        fragments: [],
        userPrompt: 'hello',
        attachments: [],
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' } as never,
    };
}

function createProjector(overrides: { sessionId?: number | null; attachments?: unknown[] } = {}) {
    return new PersistenceProjector({
        sessionId: overrides.sessionId === undefined ? 1 : overrides.sessionId,
        model: { id: 1, provider_id: 1, model_id: 'test-model' },
        taskId: 'task-1',
        executionMode: 'foreground',
        prompt: 'hello',
        maxRetries: 3,
        buildSessionTitle: (prompt) => prompt,
        promptSnapshot: createSnapshot(),
        ...(overrides.attachments ? { attachments: overrides.attachments as never } : {}),
    });
}

function createCheckpoint(): AttemptCheckpoint {
    return {
        activeModel: {
            id: 1,
            provider_id: 1,
            model_id: 'test-model',
        } as AttemptCheckpoint['activeModel'],
        messages: [{ role: 'user', content: 'hello' }],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' } as never,
    };
}

function createCall(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
    return {
        iteration: 0,
        modelId: 1,
        modelName: 'test-model',
        providerId: 1,
        providerName: 'Test',
        usage: {
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        },
        timing: { ttftMs: 100, durationMs: 500 },
        finishReason: 'stop',
        toolCallsInStep: 0,
        toolArgumentErrors: 0,
        ...overrides,
    };
}

describe('user waits for the answer while its turn is recorded', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSession.mockImplementation(async (draft) => ({ ...draft, id: 3 }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({ ...draft, id: 3 }));
        queries.updateSessionTurnUsage.mockResolvedValue(undefined);
        queries.updateSessionTurnAttemptUsage.mockResolvedValue(undefined);
        queries.syncOutputParts.mockResolvedValue(undefined);
        queries.createMessageParts.mockResolvedValue(undefined);
        queries.updateMessage.mockResolvedValue(undefined);
        queries.updateSession.mockResolvedValue(undefined);
        queries.updateSessionTurn.mockResolvedValue(undefined);
        queries.updateSessionTurnAttempt.mockResolvedValue(undefined);
        queries.refreshSessionMetadata.mockResolvedValue(undefined);
        queries.findAllMcpTools.mockResolvedValue([]);
        queries.findAllBuiltInTools.mockResolvedValue([]);
        usage.resolveCalls.mockImplementation(async (calls) => calls);
        usage.sumUsage.mockReturnValue({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        });
        usage.sumCost.mockReturnValue({ totalCostMicros: 1234 });
        usage.countUnpriced.mockReturnValue(0);
        usage.insertLlmCallParts.mockResolvedValue(undefined);
    });

    it('user sees the prompt cost breakdown saved with the turn', async () => {
        const projector = createProjector();

        await projector.recordTurnStart(createCheckpoint());

        expect(queries.updateSessionTurnUsage).toHaveBeenCalledWith(
            expect.objectContaining({
                usagePatch: { prompt_breakdown_json: JSON.stringify({ total: 42 }) },
            })
        );
    });

    it('user still gets the answer when the cost breakdown cannot be built', async () => {
        queries.findAllMcpTools.mockRejectedValue(new Error('toolbox table missing'));
        const projector = createProjector();

        await expect(projector.recordTurnStart(createCheckpoint())).resolves.toBeUndefined();
        // The turn itself is still recorded; only the extra statistics are skipped.
        expect(queries.createSessionTurn).toHaveBeenCalled();
        expect(queries.updateSessionTurnUsage).not.toHaveBeenCalled();
    });

    it('user sees the conversation created lazily when none was open', async () => {
        const projector = createProjector({ sessionId: null });

        await projector.recordTurnStart(createCheckpoint());

        expect(queries.createSession).toHaveBeenCalledWith(
            expect.objectContaining({ model: 'test-model', provider_id: 1 }),
            expect.anything()
        );
        expect(projector.getSessionId()).toBe(3);
    });

    it('user sees the open conversation model corrected to the model that answered', async () => {
        const projector = createProjector({ sessionId: 1 });

        await projector.recordTurnStart(createCheckpoint());

        expect(queries.updateSession).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 1,
                sessionPatch: { model: 'test-model', provider_id: 1 },
            })
        );
    });

    it('user still gets the answer when the conversation model cannot be corrected', async () => {
        queries.updateSession.mockRejectedValue(new Error('database is locked'));
        const projector = createProjector({ sessionId: 1 });

        await expect(projector.recordTurnStart(createCheckpoint())).resolves.toBeUndefined();
        expect(queries.createSessionTurn).toHaveBeenCalled();
    });

    it('user sees the turn linked to the message they typed', async () => {
        const projector = createProjector();

        await projector.recordTurnStart(createCheckpoint());

        expect(queries.createSessionTurn).toHaveBeenCalledWith(
            expect.objectContaining({ prompt_message_id: 10, task_id: 'task-1' }),
            expect.anything()
        );
    });

    it('user sees the turn start again without duplicating their message', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.createMessage.mockClear();

        await projector.recordTurnStart(createCheckpoint());

        // The prompt message and the turn row are reused, not re-created.
        expect(queries.createMessage).not.toHaveBeenCalled();
        expect(queries.createSessionTurn).toHaveBeenCalledTimes(1);
    });
});

describe('user sees usage counted once the answer is done', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({ ...draft, id: 3 }));
        queries.updateSessionTurnUsage.mockResolvedValue(undefined);
        queries.updateSessionTurnAttemptUsage.mockResolvedValue(undefined);
        queries.syncOutputParts.mockResolvedValue(undefined);
        queries.updateSessionTurn.mockResolvedValue(undefined);
        queries.updateSessionTurnAttempt.mockResolvedValue(undefined);
        queries.refreshSessionMetadata.mockResolvedValue(undefined);
        queries.findAllMcpTools.mockResolvedValue([]);
        queries.findAllBuiltInTools.mockResolvedValue([]);
        usage.resolveCalls.mockImplementation(async (calls) => calls);
        usage.sumUsage.mockReturnValue({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 1,
            cacheWriteTokens: 2,
            reasoningTokens: 3,
        });
        usage.sumCost.mockReturnValue({ totalCostMicros: 1234 });
        usage.countUnpriced.mockReturnValue(0);
        usage.insertLlmCallParts.mockResolvedValue(undefined);
    });

    it('user sees each model call stored against the reply that used it', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [createCall()],
        });

        expect(usage.insertLlmCallParts).toHaveBeenCalledWith(
            11,
            [expect.objectContaining({ iteration: 0 })],
            expect.anything(),
            2
        );
    });

    it('user sees the call count and tool activity saved with the turn', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [createCall({ toolCallsInStep: 2 })],
            toolArgumentErrors: 1,
            modelSwitchCount: 2,
            hitModelSwitchCeiling: true,
        });

        expect(queries.updateSessionTurnUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                usagePatch: expect.objectContaining({
                    tool_call_count: 2,
                    tool_argument_error_count: 1,
                    model_switch_count: 2,
                    hit_iteration_ceiling: 1,
                }),
            })
        );
    });

    it('user sees the first answer delay saved when it was measured', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [createCall()],
            ttftMs: 120,
            firstTextMs: 180,
        });

        expect(queries.updateSessionTurnAttemptUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({ usagePatch: expect.objectContaining({ ttft_ms: 120 }) })
        );
        expect(queries.updateSessionTurnUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                usagePatch: expect.objectContaining({ first_text_ms: 180 }),
            })
        );
    });

    it('user sees a missing first-answer delay left empty rather than guessed', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [createCall()],
        });

        expect(queries.updateSessionTurnAttemptUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({ usagePatch: expect.objectContaining({ ttft_ms: null }) })
        );
        expect(queries.updateSessionTurnUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                usagePatch: expect.objectContaining({ first_text_ms: null }),
            })
        );
    });

    it('user sees no per-call rows when the answer recorded no calls', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCompleted({ durationMs: 900, outputParts: [] });

        expect(usage.insertLlmCallParts).not.toHaveBeenCalled();
        expect(queries.updateSessionTurnUsage).toHaveBeenCalledTimes(1);
    });

    it('user sees the reply reused when it was already streamed to the panel', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await projector.persistOutputProgress([{ type: 'text', content: 'Streamed' }]);
        queries.createMessage.mockClear();

        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Final' }],
        });

        // The streamed message is updated in place instead of creating a second reply.
        expect(queries.createMessage).not.toHaveBeenCalled();
        expect(queries.updateMessage).toHaveBeenCalledWith(
            11,
            expect.objectContaining({ role: 'assistant' }),
            expect.anything()
        );
    });

    it('user sees the reply id kept when the turn closes with no further output', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await projector.markCompleted({
            durationMs: 900,
            outputParts: [{ type: 'text', content: 'Answer' }],
        });

        await projector.markCompleted({ durationMs: 950, outputParts: [] });

        expect(queries.updateSessionTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                turnPatch: expect.objectContaining({ response_message_id: 11 }),
            })
        );
    });

    it('user sees the failure reported when the completion cannot be saved', async () => {
        queries.syncOutputParts.mockRejectedValue(new Error('disk full'));
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await expect(
            projector.markCompleted({
                durationMs: 900,
                outputParts: [{ type: 'text', content: 'Answer' }],
            })
        ).rejects.toThrow('disk full');
    });
});

describe('user sees a failed turn recorded with its usage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({ ...draft, id: 3 }));
        queries.updateSessionTurnUsage.mockResolvedValue(undefined);
        queries.updateSessionTurnAttemptUsage.mockResolvedValue(undefined);
        queries.syncOutputParts.mockResolvedValue(undefined);
        queries.updateSessionTurn.mockResolvedValue(undefined);
        queries.updateSessionTurnAttempt.mockResolvedValue(undefined);
        queries.refreshSessionMetadata.mockResolvedValue(undefined);
        queries.findAllMcpTools.mockResolvedValue([]);
        queries.findAllBuiltInTools.mockResolvedValue([]);
        usage.resolveCalls.mockImplementation(async (calls) => calls);
        usage.sumUsage.mockReturnValue({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        });
        usage.sumCost.mockReturnValue({ totalCostMicros: 1234 });
        usage.countUnpriced.mockReturnValue(1);
        usage.insertLlmCallParts.mockResolvedValue(undefined);
    });

    it('user sees the error code and retry scope saved with the failure', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markFailed('offline', [], {
            calls: [createCall()],
            errorCode: 'NETWORK_ERROR',
            retryScope: 'checkpoint',
        });

        expect(queries.updateSessionTurnUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                usagePatch: expect.objectContaining({
                    error_code: 'NETWORK_ERROR',
                    retry_scope: 'checkpoint',
                }),
            })
        );
    });

    it('user sees the failure cleared of error metadata on a plain failure', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markFailed('offline', [], { calls: [createCall()] });

        expect(queries.updateSessionTurnUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                usagePatch: expect.objectContaining({ error_code: null, retry_scope: null }),
            })
        );
    });

    it('user sees the failure reported when it cannot be saved', async () => {
        queries.updateSessionTurnAttempt.mockRejectedValue(new Error('disk full'));
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await expect(projector.markFailed('offline')).rejects.toThrow('disk full');
    });
});

describe('user cancels a turn that is being recorded', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({ ...draft, id: 3 }));
        queries.updateSessionTurnUsage.mockResolvedValue(undefined);
        queries.updateSessionTurnAttemptUsage.mockResolvedValue(undefined);
        queries.syncOutputParts.mockResolvedValue(undefined);
        queries.updateSessionTurn.mockResolvedValue(undefined);
        queries.updateSessionTurnAttempt.mockResolvedValue(undefined);
        queries.refreshSessionMetadata.mockResolvedValue(undefined);
        queries.findAllMcpTools.mockResolvedValue([]);
        queries.findAllBuiltInTools.mockResolvedValue([]);
        usage.resolveCalls.mockImplementation(async (calls) => calls);
        usage.sumUsage.mockReturnValue({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        });
        usage.sumCost.mockReturnValue({ totalCostMicros: 1234 });
        usage.countUnpriced.mockReturnValue(0);
        usage.insertLlmCallParts.mockResolvedValue(undefined);
    });

    it('user sees the turn recorded as cancelled by them', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCancelled([{ type: 'text', content: 'Half' }], {
            calls: [createCall()],
            errorCode: 'REQUEST_CANCELLED',
        });

        expect(queries.updateSessionTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                turnPatch: expect.objectContaining({
                    status: 'cancelled',
                    error_message: 'Cancelled by user',
                }),
            })
        );
    });

    it('user sees the cancellation reported when it cannot be saved', async () => {
        queries.updateSessionTurnAttempt.mockRejectedValue(new Error('disk full'));
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await expect(projector.markCancelled()).rejects.toThrow('disk full');
    });
});

describe('user waits through a retry of the same turn', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({
            ...draft,
            id: (draft.attempt_index ?? 1) + 2,
        }));
        queries.updateSessionTurnUsage.mockResolvedValue(undefined);
        queries.updateSessionTurnAttemptUsage.mockResolvedValue(undefined);
        queries.syncOutputParts.mockResolvedValue(undefined);
        queries.updateSessionTurn.mockResolvedValue(undefined);
        queries.updateSessionTurnAttempt.mockResolvedValue(undefined);
        queries.refreshSessionMetadata.mockResolvedValue(undefined);
        queries.findAllMcpTools.mockResolvedValue([]);
        queries.findAllBuiltInTools.mockResolvedValue([]);
        usage.resolveCalls.mockImplementation(async (calls) => calls);
        usage.sumUsage.mockReturnValue({
            inputTokens: 10,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        });
        usage.sumCost.mockReturnValue({ totalCostMicros: 1234 });
        usage.countUnpriced.mockReturnValue(0);
        usage.insertLlmCallParts.mockResolvedValue(undefined);
    });

    it('user sees the failed attempt keep the tokens it already burned', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.beginNextAttempt('offline', createCheckpoint(), {
            calls: [createCall()],
            ttftMs: 90,
        });

        expect(queries.updateSessionTurnAttemptUsage).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 3,
                usagePatch: expect.objectContaining({ input_tokens: 10, ttft_ms: 90 }),
            })
        );
    });

    it('user sees the failed attempt recorded without a delay it never measured', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.beginNextAttempt('offline', createCheckpoint(), { calls: [createCall()] });

        expect(queries.updateSessionTurnAttemptUsage).toHaveBeenCalledWith(
            expect.objectContaining({ usagePatch: expect.objectContaining({ ttft_ms: null }) })
        );
    });

    it('user sees the next attempt numbered after the one that failed', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.beginNextAttempt('offline', createCheckpoint(), { calls: [createCall()] });

        expect(queries.createSessionTurnAttempt).toHaveBeenLastCalledWith(
            expect.objectContaining({ attempt_index: 2, max_retries: 3 }),
            expect.anything()
        );
    });

    it('user sees the turn put back to running after the retry starts', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        // The first attempt already closed the turn as failed.
        await projector.markFailed('offline');
        queries.updateSessionTurn.mockClear();

        await projector.beginNextAttempt('offline', createCheckpoint(), { calls: [createCall()] });

        expect(queries.updateSessionTurn).toHaveBeenCalledWith(
            expect.objectContaining({
                turnPatch: { status: 'streaming', error_message: null },
            })
        );
    });

    it('user sees the turn usage refreshed to include the failed attempt', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.updateSessionTurnUsage.mockClear();

        await projector.beginNextAttempt('offline', createCheckpoint(), {
            calls: [createCall()],
            modelSwitchCount: 1,
            toolArgumentErrors: 2,
            hitModelSwitchCeiling: true,
        });

        expect(queries.updateSessionTurnUsage).toHaveBeenLastCalledWith(
            expect.objectContaining({
                usagePatch: expect.objectContaining({
                    model_switch_count: 1,
                    tool_argument_error_count: 2,
                    hit_iteration_ceiling: 1,
                }),
            })
        );
    });

    it('user sees the retry refused before the turn was ever recorded', async () => {
        const projector = createProjector();

        // No recordTurnStart: there is no attempt to close, so the retry cannot start.
        await expect(
            projector.beginNextAttempt('offline', createCheckpoint(), { calls: [createCall()] })
        ).rejects.toThrow();
        expect(queries.updateSessionTurnUsage).not.toHaveBeenCalled();
    });

    it('user sees the retry reported when it cannot be saved', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        // Only the retry attempt insert fails; the first attempt was saved normally.
        queries.createSessionTurnAttempt.mockRejectedValueOnce(new Error('disk full'));

        await expect(projector.beginNextAttempt('offline', createCheckpoint())).rejects.toThrow(
            'disk full'
        );
    });
});

describe('user sends attachments with the prompt and through tools', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({ ...draft, id: 3 }));
        queries.updateSessionTurnUsage.mockResolvedValue(undefined);
        queries.updateSessionTurnAttemptUsage.mockResolvedValue(undefined);
        queries.syncOutputParts.mockResolvedValue(undefined);
        queries.updateSessionTurn.mockResolvedValue(undefined);
        queries.updateSessionTurnAttempt.mockResolvedValue(undefined);
        queries.refreshSessionMetadata.mockResolvedValue(undefined);
        queries.createMessageAttachment.mockResolvedValue({ id: 99 });
        queries.mergeMessagePartData.mockResolvedValue({
            id: 42,
            message_id: 11,
            tool_call_id: 'call-1',
            tool_kind: 'builtin',
        });
        queries.findAllMcpTools.mockResolvedValue([]);
        queries.findAllBuiltInTools.mockResolvedValue([]);
        usage.resolveCalls.mockImplementation(async (calls) => calls);
        usage.sumUsage.mockReturnValue({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        });
        usage.sumCost.mockReturnValue({ totalCostMicros: 0 });
        usage.countUnpriced.mockReturnValue(0);
        usage.insertLlmCallParts.mockResolvedValue(undefined);
    });

    function attachmentIndex() {
        return {
            id: 'attachment-1',
            attachmentId: 7,
            hash: 'hash-7',
            type: 'file',
            path: 'D:/cache/seven.txt',
            originPath: 'D:/origin/seven.txt',
            name: 'seven.txt',
        } as never;
    }

    function attachmentEntity() {
        return {
            id: 8,
            hash: 'hash-8',
            type: 'file',
            original_name: 'eight.txt',
            origin_path: 'D:/origin/eight.txt',
            mime_type: 'text/plain',
            size: 5,
            created_at: '2026-10-08T00:00:00Z',
        } as never;
    }

    it('user sees the attachment they sent linked to their message', async () => {
        const projector = createProjector({ attachments: [attachmentIndex()] });

        await projector.recordTurnStart(createCheckpoint());

        expect(queries.createMessageAttachment).toHaveBeenCalledWith(
            expect.objectContaining({ message_id: 10, origin_path: 'D:/origin/seven.txt' }),
            expect.anything()
        );
    });

    it('user sees an attachment that was already saved linked without being saved twice', async () => {
        const projector = createProjector({ attachments: [attachmentEntity()] });

        await projector.recordTurnStart(createCheckpoint());

        expect(queries.createMessageAttachment).toHaveBeenCalledWith(
            expect.objectContaining({ message_id: 10, attachment_id: 8 }),
            expect.anything()
        );
    });

    it('user sees the delivery record kept up to date as attachments are planned', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.syncDeliveryManifestRequest({
            requestIndex: 0,
            providerDriver: 'openai',
            providerId: 1,
            modelId: 'test-model',
            createdAt: '2026-10-08T00:00:00Z',
            entries: [],
        });

        expect(queries.updateSessionTurnAttempt).toHaveBeenLastCalledWith(
            expect.objectContaining({
                attemptPatch: expect.objectContaining({
                    delivery_manifest_json: expect.any(String),
                }),
            })
        );
    });

    it('user sees no delivery record written before the turn exists', async () => {
        const projector = createProjector();

        await expect(
            projector.syncDeliveryManifestRequest({
                requestIndex: 0,
                providerDriver: 'openai',
                providerId: 1,
                modelId: 'test-model',
                createdAt: '2026-10-08T00:00:00Z',
                entries: [],
            })
        ).resolves.toBeUndefined();
        expect(queries.updateSessionTurnAttempt).not.toHaveBeenCalled();
    });
});

describe('user reopens a turn whose bookkeeping was interrupted', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        let messageId = 10;
        queries.createMessage.mockImplementation(async (draft) => ({ ...draft, id: messageId++ }));
        queries.createSessionTurn.mockImplementation(async (draft) => ({ ...draft, id: 2 }));
        queries.createSessionTurnAttempt.mockImplementation(async (draft) => ({ ...draft, id: 3 }));
        queries.updateSessionTurnUsage.mockResolvedValue(undefined);
        queries.updateSessionTurnAttemptUsage.mockResolvedValue(undefined);
        queries.syncOutputParts.mockResolvedValue(undefined);
        queries.updateSessionTurn.mockResolvedValue(undefined);
        queries.updateSessionTurnAttempt.mockResolvedValue(undefined);
        queries.refreshSessionMetadata.mockResolvedValue(undefined);
        queries.findAllMcpTools.mockResolvedValue([]);
        queries.findAllBuiltInTools.mockResolvedValue([]);
        usage.resolveCalls.mockImplementation(async (calls) => calls);
        usage.sumUsage.mockReturnValue({
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        });
        usage.sumCost.mockReturnValue({ totalCostMicros: 0 });
        usage.countUnpriced.mockReturnValue(0);
        usage.insertLlmCallParts.mockResolvedValue(undefined);
    });

    it('user sees the progress saved before the turn record exists skipped quietly', async () => {
        const projector = createProjector();

        await expect(
            projector.persistOutputProgress([{ type: 'text', content: 'typing' }])
        ).resolves.toBeUndefined();
        expect(queries.syncOutputParts).not.toHaveBeenCalled();
    });

    it('user sees empty progress ignored instead of writing an empty reply', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.persistOutputProgress([]);

        expect(queries.syncOutputParts).not.toHaveBeenCalled();
    });

    it('user sees the checkpoint saved without a turn record skipped quietly', async () => {
        const projector = createProjector();

        await expect(projector.persistCheckpoint(createCheckpoint())).resolves.toBeUndefined();
        expect(queries.updateSessionTurnAttempt).not.toHaveBeenCalled();
    });

    it('user sees the turn kept when its status update is refused', async () => {
        queries.updateSessionTurn.mockRejectedValue(new Error('database is locked'));
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await expect(
            projector.markCompleted({
                durationMs: 100,
                outputParts: [{ type: 'text', content: 'Answer' }],
            })
        ).resolves.toBeUndefined();
        // The turn is still readable even though the status write failed.
        expect(projector.getTurn()).not.toBeNull();
    });

    it('user sees the turn created on demand when the first status update arrives early', async () => {
        const projector = createProjector();

        await projector
            .persistOutputProgress([{ type: 'text', content: 'typing' }])
            .catch(() => {});

        expect(projector.getTurn()).toBeNull();
    });

    it('user sees a cancelled turn keep the reply that already streamed', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        await projector.persistOutputProgress([{ type: 'text', content: 'Half an ans' }]);
        queries.createMessage.mockClear();

        await projector.markCancelled();

        // Cancelling without new parts must not create a second reply message.
        expect(queries.createMessage).not.toHaveBeenCalled();
        expect(queries.updateSessionTurn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                turnPatch: expect.objectContaining({ response_message_id: 11 }),
            })
        );
    });

    it('user sees usage saved without a turn id when no turn row exists yet', async () => {
        const projector = createProjector();

        // Completion without a prior recordTurnStart: no turn row exists while usage is written.
        await projector.markCompleted({
            durationMs: 100,
            outputParts: [{ type: 'text', content: 'Answer' }],
            calls: [createCall()],
        });

        const call = usage.insertLlmCallParts.mock.calls[0]!;
        expect(call[0]).toBe(10);
        // The call rows are still saved; only the turn link is absent.
        expect(call[3]).toBeNull();
        expect(projector.getTurn()).not.toBeNull();
    });

    it('user sees progress with no visible content ignored', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());
        queries.syncOutputParts.mockClear();

        await projector.persistOutputProgress([{ type: 'text', content: '' }]);

        expect(queries.syncOutputParts).not.toHaveBeenCalled();
    });

    it('user sees a thinking fragment without a start time saved as unknown timing', async () => {
        const projector = createProjector();
        await projector.recordTurnStart(createCheckpoint());

        await projector.markCompleted({
            durationMs: 100,
            outputParts: [{ type: 'reasoning', content: 'Thought' }],
        });

        expect(queries.syncOutputParts).toHaveBeenLastCalledWith(
            11,
            [
                expect.objectContaining({
                    type: 'reasoning',
                    content: 'Thought',
                    started_at: null,
                    ended_at: null,
                }),
            ],
            expect.anything()
        );
    });

    it('user sees one conversation created when two writes race at the start', async () => {
        const projector = createProjector({ sessionId: null });

        await Promise.all([
            projector.recordTurnStart(createCheckpoint()),
            projector.recordTurnStart(createCheckpoint()),
        ]);

        // The lazy creation is locked to a single instance.
        expect(queries.createSession).toHaveBeenCalledTimes(1);
    });
});
