import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiRequestOptions } from '../contracts/protocol';
import { AiRequestExecutor } from './executor';

const {
    mockCreateProviderForModel,
    mockResolveToolDefinitions,
    mockProviderStream,
    capturedRequestOptions,
} = vi.hoisted(() => ({
    mockCreateProviderForModel: vi.fn(),
    mockResolveToolDefinitions: vi.fn(),
    mockProviderStream: vi.fn(),
    capturedRequestOptions: [] as AiRequestOptions[],
}));

vi.mock('@database/queries', () => ({
    createMcpToolLog: vi.fn(),
    updateMcpToolLogByCallId: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: {
        executeTool: vi.fn(),
    },
}));

vi.mock('../catalog', () => ({
    createProviderForModel: mockCreateProviderForModel,
    getModel: vi.fn(),
    resolveToolDefinitions: mockResolveToolDefinitions,
}));

vi.mock('../infrastructure/attachments', () => ({
    buildAttachmentParts: vi.fn(),
}));

vi.mock('../infrastructure/mcp', () => ({
    mcpManager: {
        resolveToolCall: vi.fn(),
        executeTool: vi.fn(),
    },
}));

vi.mock('../infrastructure/providers', () => ({
    createProviderFromRegistry: vi.fn(),
    parseProviderConfigJson: vi.fn(() => ({})),
}));

/**
 * 创建测试用模型记录。
 */
function createModel(overrides: Partial<ModelWithProvider> = {}): ModelWithProvider {
    return {
        id: 1,
        created_at: '2026-05-08T00:00:00.000Z',
        updated_at: '2026-05-08T00:00:00.000Z',
        provider_id: 10,
        model_id: 'gpt-5.5',
        name: 'GPT-5.5',
        is_default: 1,
        last_used_at: null,
        attachment: 0,
        modalities: null,
        open_weights: 0,
        reasoning: 1,
        release_date: null,
        temperature: 1,
        tool_call: 0,
        knowledge: null,
        context_limit: 131072,
        output_limit: 131100,
        is_custom_metadata: 0,
        provider_name: 'OpenAI Gateway',
        provider_driver: 'openai',
        api_endpoint: 'https://gateway.example/v1',
        api_key: 'test-key',
        provider_config_json: null,
        provider_enabled: 1,
        provider_logo: 'openai',
        ...overrides,
    };
}

/**
 * 创建 runAttempt 所需的最小持久化桩。
 */
function createNoopPersister() {
    return {
        syncDeliveryManifestRequest: vi.fn(),
        getTurn: vi.fn(() => null),
        getSessionId: vi.fn(() => null),
    };
}

describe('AiRequestExecutor', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        capturedRequestOptions.length = 0;

        mockProviderStream.mockImplementation(async function* (options: AiRequestOptions) {
            capturedRequestOptions.push(options);
            yield { content: 'ok', done: false };
            yield { content: '', done: true, finishReason: 'stop' };
        });
        mockCreateProviderForModel.mockReturnValue({
            name: 'mock-provider',
            driver: 'openai',
            request: vi.fn(),
            stream: mockProviderStream,
            testConnection: vi.fn(),
            listModels: vi.fn(),
            getApiTargets: vi.fn(),
            classifyError: vi.fn(),
        });
        mockResolveToolDefinitions.mockResolvedValue([]);
    });

    it('does not use model metadata output_limit as request maxTokens', async () => {
        const executor = new AiRequestExecutor();
        const model = createModel({ output_limit: 131100 });
        const checkpoint = executor.createInitialCheckpoint({
            initialModel: model,
            baseMessages: [{ role: 'user', content: 'hello' }],
        });

        const result = await executor.runAttempt({
            startCheckpoint: checkpoint,
            persister: createNoopPersister() as never,
        });

        expect(result.type).toBe('completed');
        expect(capturedRequestOptions).toHaveLength(1);
        expect(capturedRequestOptions[0]).not.toHaveProperty('maxTokens');
    });
});
