import { describe, expect, it, vi } from 'vitest';

/**
 * The task snapshot and completion result are built by the real runtime. This
 * test drives `AiConversationRuntime.run()` to `completed` with a fake executor
 * that carries a credential-bearing model, and mocks only the provider/database
 * boundaries, to prove the real pipeline never emits credentials.
 */

const credentialModel = {
    id: 7,
    provider_id: 3,
    model_id: 'mimo-v2.5',
    name: 'MiMo v2.5',
    provider_name: 'Xiaomi MiMo',
    api_key: 'ta_live_secret_key',
    provider_config_json: '{"token":"secret"}',
};

vi.mock('@/services/AgentService/outputs/persistence', () => {
    class PersistenceProjector {
        async recordTurnStart() {
            return undefined;
        }
        getSessionId() {
            return 1;
        }
        getTurn() {
            // A real row carries prompt internals; the public result must not.
            return {
                id: 9,
                session_id: 1,
                status: 'completed',
                model_id: 'mimo-v2.5',
                task_id: 'task-1',
                prompt_snapshot_json:
                    '{"systemPrompt":"SECRET_SYSTEM_PROMPT","fragments":[{"text":"SECRET_FRAGMENT"}]}',
                prompt_breakdown_json: '{"SECRET_BREAKDOWN":true}',
            };
        }
        async markCompleted() {
            return undefined;
        }
        async markFailed() {
            return undefined;
        }
        async markCancelled() {
            return undefined;
        }
        async beginNextAttempt() {
            return undefined;
        }
    }
    return { PersistenceProjector };
});

vi.mock('@/services/AgentService/prompt/composer', () => ({
    composePromptSnapshot: vi.fn(async () => ({
        id: 'prompt-1',
        createdAt: '2026-10-08T00:00:00Z',
        systemPrompt: '',
        executionMode: 'foreground',
        fragments: [],
        userPrompt: 'Hi',
        attachments: [],
        modelLanguageContext: { locale: 'en-US', label: 'English' },
    })),
}));

vi.mock('@/services/AgentService/prompt/transport', () => ({
    buildPromptTransportMessages: vi.fn(async () => []),
}));

vi.mock('@/services/AgentService/session/transport', () => ({
    findUnsupportedSessionAttachmentTypes: vi.fn(async () => []),
}));

vi.mock('@/services/UsageService/liveUsage', () => ({
    LiveUsageTracker: class {
        start() {}
        stop() {}
        consume() {}
        finish() {}
    },
}));

vi.mock('@database/queries', () => ({
    updateModelLastUsed: vi.fn(async () => undefined),
}));

vi.mock('@database/queries/llmMetadata', () => ({
    findModelPricing: vi.fn(async () => null),
}));

const { AiConversationRuntime } = await import('@/services/AgentService/execution/runtime');
const { toPublicTaskEvent } = await import('@/services/AgentService/contracts/task');

const MODEL_SUMMARY_KEYS = ['modelDbId', 'modelId', 'modelName', 'providerId', 'providerName'];

function createFakeExecutor(options: { runAttemptError?: Error } = {}) {
    return {
        getModel: vi.fn(async () => credentialModel),
        createInitialCheckpoint: vi.fn(() => ({
            activeModel: credentialModel,
            messages: [],
            response: '',
            reasoning: '',
            iteration: 0,
            modelSwitchCount: 0,
            modelLanguageContext: { locale: 'en-US', label: 'English' },
            executedBuiltInToolIds: [],
            outputParts: [],
        })),
        runAttempt: vi.fn(async () => {
            if (options.runAttemptError) {
                // The attempt can throw before producing any result, e.g. when
                // tool-definition resolution rejects.
                throw options.runAttemptError;
            }
            return {
                type: 'completed' as const,
                model: credentialModel,
                response: 'All done',
                reasoning: '',
                finalStepOutputParts: [],
                calls: [],
                totalUsage: {
                    inputTokens: 1,
                    outputTokens: 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                },
                firstTtftMs: null,
                firstTextMs: null,
                toolArgumentErrors: 0,
                modelSwitchCount: 0,
                hitModelSwitchCeiling: false,
            };
        }),
    };
}

describe('user runs a conversation turn to completion', () => {
    it('user gets a completion result and events without provider credentials', async () => {
        const events: Array<{ type: string } & Record<string, unknown>> = [];
        const executor = createFakeExecutor();
        const runtime = new AiConversationRuntime(executor as never, {
            taskId: 'task-1',
            prompt: 'Hi',
            modelId: 'mimo-v2.5',
            providerId: 3,
            sessionId: 1,
            environment: { reportPersistenceIssue: vi.fn() },
            onTurnEvent: (event) => events.push(event as never),
        });

        const result = await runtime.run();

        expect(result.response).toBe('All done');
        expect(Object.keys(result.model).sort()).toEqual([...MODEL_SUMMARY_KEYS].sort());
        // The turn is a whitelist summary; no prompt snapshot/breakdown internals.
        expect(result.turn).toEqual({ id: 9, sessionId: 1, status: 'completed' });
        expect(Object.keys(result.turn ?? {}).sort()).toEqual(['id', 'sessionId', 'status'].sort());

        const serialized = JSON.stringify(result) + JSON.stringify(events);
        expect(serialized).not.toContain('api_key');
        expect(serialized).not.toContain('provider_config_json');
        expect(serialized).not.toContain('ta_live_secret_key');
        expect(serialized).not.toContain('checkpoint');
        expect(serialized).not.toContain('prompt_snapshot_json');
        expect(serialized).not.toContain('prompt_breakdown_json');
        expect(serialized).not.toContain('SECRET_SYSTEM_PROMPT');
        expect(serialized).not.toContain('SECRET_FRAGMENT');

        const completed = events.find((event) => event.type === 'task_completed');
        expect(completed).toBeTruthy();
        // The public projection of every emitted event is credential-free too.
        for (const event of events) {
            const publicEvent = toPublicTaskEvent(event);
            if (publicEvent) {
                expect(JSON.stringify(publicEvent)).not.toContain('api_key');
                expect(JSON.stringify(publicEvent)).not.toContain('ta_live_secret_key');
            }
        }
    });
});

function createRuntimeWithEvents(executor: ReturnType<typeof createFakeExecutor>) {
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const runtime = new AiConversationRuntime(executor as never, {
        taskId: 'task-1',
        prompt: 'Hi',
        modelId: 'mimo-v2.5',
        providerId: 3,
        sessionId: 1,
        environment: { reportPersistenceIssue: vi.fn() },
        onTurnEvent: (event) => events.push(event as never),
    });
    return { runtime, events };
}

describe('user runs a conversation attempt that closes its boundary', () => {
    it('user still gets attempt_finished and task_failed when the attempt throws before returning', async () => {
        const executor = createFakeExecutor({
            runAttemptError: new Error('tool definitions failed'),
        });
        const { runtime, events } = createRuntimeWithEvents(executor);

        await expect(runtime.run()).rejects.toThrow();

        const types = events.map((event) => event.type);
        const startedAt = types.indexOf('attempt_started');
        const finishedAt = types.indexOf('attempt_finished');
        expect(startedAt).toBeGreaterThanOrEqual(0);
        expect(finishedAt).toBeGreaterThan(startedAt);
        expect(types.filter((type) => type === 'attempt_finished')).toHaveLength(1);
        expect(types).toContain('task_failed');
    });

    it('user gets exactly one attempt_finished before completion on the normal path', async () => {
        const { runtime, events } = createRuntimeWithEvents(createFakeExecutor());

        await runtime.run();

        const types = events.map((event) => event.type);
        expect(types.filter((type) => type === 'attempt_finished')).toHaveLength(1);
        expect(types.indexOf('attempt_finished')).toBeLessThan(types.indexOf('task_completed'));
    });
});

describe('user subscribes to the public task event stream', () => {
    it('user does not see internal fields even when an event carries them', () => {
        const polluted = {
            type: 'task_started',
            taskId: 'task-1',
            sessionId: 1,
            turnId: 9,
            executionMode: 'foreground',
            model: {
                modelDbId: 7,
                providerId: 3,
                providerName: 'Xiaomi MiMo',
                modelId: 'mimo-v2.5',
                modelName: 'MiMo v2.5',
                api_key: 'ta_live_secret_key',
                provider_config_json: '{"token":"secret"}',
            },
            checkpoint: { activeModel: credentialModel },
            attemptToken: 'attempt-1',
        };

        const publicEvent = toPublicTaskEvent(polluted);

        expect(publicEvent).not.toBeNull();
        expect(Object.keys(publicEvent ?? {}).sort()).toEqual(
            ['executionMode', 'model', 'sessionId', 'taskId', 'turnId', 'type'].sort()
        );
        expect(
            publicEvent?.type === 'task_started' && Object.keys(publicEvent.model).sort()
        ).toEqual([...MODEL_SUMMARY_KEYS].sort());
        const serialized = JSON.stringify(publicEvent);
        expect(serialized).not.toContain('api_key');
        expect(serialized).not.toContain('checkpoint');
        expect(serialized).not.toContain('attemptToken');
    });
});
