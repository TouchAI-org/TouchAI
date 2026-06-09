import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    persisterOptions: [] as unknown[],
}));

vi.mock('@database/queries', () => ({
    updateModelLastUsed: vi.fn(),
}));

vi.mock('@/services/AgentService/catalog', () => ({
    resolveToolDefinitions: vi.fn(),
}));

vi.mock('@/services/AgentService/prompt/builtin', () => ({
    buildBuiltInPromptContext: vi.fn(),
}));

vi.mock('@/services/AgentService/prompt/composer', () => ({
    composePromptSnapshot: vi.fn(),
}));

vi.mock('@/services/AgentService/prompt/transport', () => ({
    buildPromptTransportMessages: vi.fn(),
}));

vi.mock('@/services/AgentService/languageContext', () => ({
    getCurrentModelLanguageContext: vi.fn(() => ({
        locale: 'en-US',
        label: 'English (en-US)',
    })),
}));

vi.mock('@/services/AgentService/outputs/persistence', () => ({
    PersistenceProjector: class {
        constructor(options: unknown) {
            testState.persisterOptions.push(options);
        }

        recordTurnStart = vi.fn(async () => undefined);
        getSessionId = () => 9;
        getTurn = () => ({ id: 21 });
        markCompleted = vi.fn(async () => undefined);
        markCancelled = vi.fn(async () => undefined);
        markFailed = vi.fn(async () => undefined);
        beginNextAttempt = vi.fn(async () => undefined);
    },
}));

const { updateModelLastUsed } = await import('@database/queries');
const { resolveToolDefinitions } = await import('@/services/AgentService/catalog');
const { buildBuiltInPromptContext } = await import('@/services/AgentService/prompt/builtin');
const { composePromptSnapshot } = await import('@/services/AgentService/prompt/composer');
const { buildPromptTransportMessages } = await import('@/services/AgentService/prompt/transport');
const { AiConversationRuntime } = await import('@/services/AgentService/execution/runtime');

function createModel(overrides: Partial<ModelWithProvider> = {}): ModelWithProvider {
    return {
        id: 1,
        created_at: '2026-06-08T00:00:00.000Z',
        updated_at: '2026-06-08T00:00:00.000Z',
        provider_id: 7,
        model_id: 'touchai-test-model',
        name: 'TouchAI Test Model',
        is_default: 1,
        last_used_at: null,
        attachment: 1,
        modalities: null,
        open_weights: 0,
        reasoning: 1,
        release_date: null,
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        provider_name: 'TouchAI Provider',
        provider_driver: 'openai',
        api_endpoint: 'https://example.com',
        api_key: null,
        provider_config_json: null,
        provider_enabled: 1,
        provider_logo: '',
        ...overrides,
    };
}

function createExecutor(model = createModel()) {
    return {
        getModel: vi.fn(async () => model),
        createInitialCheckpoint: vi.fn(() => ({
            activeModel: model,
            iteration: 0,
        })),
        runAttempt: vi.fn(async () => ({
            type: 'completed',
            finalStepResponse: 'Done',
            finalStepReasoning: 'Reasoned',
            model,
            response: 'Done',
            reasoning: 'Reasoned',
        })),
    };
}

beforeEach(() => {
    testState.persisterOptions = [];
    vi.clearAllMocks();

    vi.mocked(updateModelLastUsed).mockResolvedValue(undefined);
    vi.mocked(resolveToolDefinitions).mockResolvedValue([{ name: 'builtin__memory' }] as never);
    vi.mocked(buildBuiltInPromptContext).mockResolvedValue({
        availability: {
            hasMemoryTool: true,
            hasSearchConversationTool: false,
        },
        platform: ['memory-aware system prompt'],
        sessionMemory: ['Memory directory entry'],
    });
    vi.mocked(composePromptSnapshot).mockResolvedValue({
        modelLanguageContext: {
            locale: 'en-US',
            label: 'English (en-US)',
        },
        sessionMemory: ['Memory directory entry'],
    } as never);
    vi.mocked(buildPromptTransportMessages).mockResolvedValue([
        { role: 'user', content: 'Remember this desktop workflow.' },
    ] as never);
});

describe('AiConversationRuntime prompt context loading', () => {
    it('builds built-in prompt context from the resolved tool definitions', async () => {
        const model = createModel();
        const executor = createExecutor(model);
        const runtime = new AiConversationRuntime(executor as never, {
            prompt: 'Remember this desktop workflow.',
            sessionId: 1,
        });

        await runtime.run();

        expect(resolveToolDefinitions).toHaveBeenCalledWith(model);
        expect(buildBuiltInPromptContext).toHaveBeenCalledWith([{ name: 'builtin__memory' }]);
        expect(composePromptSnapshot).toHaveBeenCalledWith(
            expect.objectContaining({
                platform: ['memory-aware system prompt'],
                sessionMemory: ['Memory directory entry'],
            })
        );
        expect(updateModelLastUsed).toHaveBeenCalledWith({ id: model.id });
    });

    it('skips loading built-in prompt context when a prompt snapshot is already provided', async () => {
        const model = createModel({ id: 2 });
        const executor = createExecutor(model);
        const promptSnapshot = {
            modelLanguageContext: {
                locale: 'zh-CN',
                label: '简体中文 (zh-CN)',
            },
            sessionMemory: [],
        };
        const runtime = new AiConversationRuntime(executor as never, {
            prompt: 'Reuse the existing prompt snapshot.',
            sessionId: 2,
            promptSnapshot: promptSnapshot as never,
        });

        await runtime.run();

        expect(resolveToolDefinitions).not.toHaveBeenCalled();
        expect(buildBuiltInPromptContext).not.toHaveBeenCalled();
        expect(composePromptSnapshot).not.toHaveBeenCalled();
        expect(buildPromptTransportMessages).toHaveBeenCalledWith(
            expect.objectContaining({
                snapshot: promptSnapshot,
            })
        );
    });
});
