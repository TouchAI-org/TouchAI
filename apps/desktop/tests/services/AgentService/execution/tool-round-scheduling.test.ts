import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiStreamChunk } from '@/services/AgentService/contracts/protocol';
import { AiRequestExecutor } from '@/services/AgentService/execution/executor';
import type { AiProvider } from '@/services/AgentService/infrastructure/providers';
import type { PersistenceProjector } from '@/services/AgentService/outputs/persistence';
import type { BuiltInToolId } from '@/services/BuiltInToolService';
import { builtInToolService } from '@/services/BuiltInToolService';

const { provider, streamedChunks } = vi.hoisted(() => {
    const streamedChunks: { value: AiStreamChunk[][]; requestIndex: number } = {
        value: [],
        requestIndex: 0,
    };
    const provider: AiProvider = {
        name: 'test-provider',
        driver: 'openai',
        async request() {
            return {
                content: '',
            };
        },
        async *stream() {
            const chunks = streamedChunks.value[streamedChunks.requestIndex] ?? [];
            streamedChunks.requestIndex += 1;
            for (const chunk of chunks) {
                yield chunk;
            }
        },
        async testConnection() {
            return true;
        },
        async listModels() {
            return [];
        },
        getApiTargets() {
            return {
                normalizedBaseUrl: 'https://example.test',
                sdkBaseUrl: 'https://example.test',
                generationTarget: 'https://example.test',
                discoveryTarget: 'https://example.test',
            };
        },
    };

    return { provider, streamedChunks };
});

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: vi.fn(() => provider),
    getModel: vi.fn(),
    resolveToolDefinitions: vi.fn(async () => []),
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: {
        executeTool: vi.fn(),
    },
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        resolveToolCall: vi.fn(async () => null),
    },
}));

vi.mock('@database/queries', () => ({
    createMcpToolLog: vi.fn(),
    updateMcpToolLogByCallId: vi.fn(),
}));

const model = {
    id: 1,
    provider_id: 1,
    model_id: 'test-model',
    name: 'Test Model',
    is_default: 0,
    last_used_at: null,
    attachment: 0,
    modalities: null,
    open_weights: 0,
    reasoning: 0,
    release_date: null,
    temperature: 1,
    tool_call: 1,
    knowledge: null,
    context_limit: null,
    output_limit: null,
    is_custom_metadata: 0,
    created_at: '',
    updated_at: '',
    provider_name: 'Test Provider',
    provider_driver: 'openai',
    api_endpoint: 'https://example.test',
    api_key: null,
    provider_config_json: null,
    provider_enabled: 1,
    provider_logo: '',
} satisfies ModelWithProvider;

function createPersister(): PersistenceProjector {
    return {
        getSessionId: vi.fn(() => 1),
        persistToolCallMessage: vi.fn(async () => 10),
        persistToolResultMessage: vi.fn(async () => 20),
        persistCheckpoint: vi.fn(async () => undefined),
        syncDeliveryManifestRequest: vi.fn(async () => undefined),
    } as unknown as PersistenceProjector;
}

function createStartCheckpoint() {
    return {
        activeModel: model,
        messages: [],
        response: '',
        reasoning: '',
        iteration: 0,
        modelSwitchCount: 0,
        modelLanguageContext: {
            locale: 'zh-CN' as const,
            label: 'Simplified Chinese (zh-CN)',
        },
        executedBuiltInToolIds: [],
    };
}

describe('AiRequestExecutor tool round scheduling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        streamedChunks.value = [];
        streamedChunks.requestIndex = 0;
    });

    it('runs computer_act calls sequentially so later calls observe the first successful execution', async () => {
        streamedChunks.value = [
            [
                {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [
                        { id: 'call-1', name: 'builtin__computer_act', arguments: '{}' },
                        { id: 'call-2', name: 'builtin__computer_act', arguments: '{}' },
                    ],
                },
            ],
            [
                {
                    content: 'done',
                    done: true,
                    finishReason: 'stop',
                },
            ],
        ];

        const hasExecutedSnapshots: boolean[] = [];
        vi.mocked(builtInToolService.executeTool).mockImplementation(async (options) => {
            hasExecutedSnapshots.push(options.hasExecutedBuiltInTool('computer_act'));
            return {
                toolCall: options.toolCall,
                result: 'ok',
                isError: false,
                toolLogId: null,
                toolLogKind: 'builtin',
                builtInToolId: 'computer_act' as BuiltInToolId,
            };
        });

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createStartCheckpoint(),
            persister: createPersister(),
        });

        expect(result.type).toBe('completed');
        expect(builtInToolService.executeTool).toHaveBeenCalledTimes(2);
        expect(hasExecutedSnapshots).toEqual([false, true]);
    });

    it('allows one successful computer_act in each model tool round', async () => {
        streamedChunks.value = [
            [
                {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'call-1', name: 'builtin__computer_act', arguments: '{}' }],
                },
            ],
            [
                {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'call-2', name: 'builtin__computer_act', arguments: '{}' }],
                },
            ],
            [
                {
                    content: 'done',
                    done: true,
                    finishReason: 'stop',
                },
            ],
        ];

        const hasExecutedSnapshots: boolean[] = [];
        vi.mocked(builtInToolService.executeTool).mockImplementation(async (options) => {
            hasExecutedSnapshots.push(options.hasExecutedBuiltInTool('computer_act'));
            return {
                toolCall: options.toolCall,
                result: 'ok',
                isError: false,
                toolLogId: null,
                toolLogKind: 'builtin',
                builtInToolId: 'computer_act' as BuiltInToolId,
            };
        });

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createStartCheckpoint(),
            persister: createPersister(),
        });

        expect(result.type).toBe('completed');
        expect(builtInToolService.executeTool).toHaveBeenCalledTimes(2);
        expect(hasExecutedSnapshots).toEqual([false, false]);
    });

    it('keeps non-computer_act tool calls parallel', async () => {
        streamedChunks.value = [
            [
                {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [
                        { id: 'call-1', name: 'builtin__setting', arguments: '{}' },
                        { id: 'call-2', name: 'builtin__ask_user_question', arguments: '{}' },
                    ],
                },
            ],
            [
                {
                    content: 'done',
                    done: true,
                    finishReason: 'stop',
                },
            ],
        ];

        let firstToolResolved = false;
        let secondToolStartedBeforeFirstResolved = false;
        let resolveFirstTool: (() => void) | null = null;

        vi.mocked(builtInToolService.executeTool).mockImplementation(async (options) => {
            if (options.toolCall.id === 'call-1') {
                await new Promise<void>((resolve) => {
                    resolveFirstTool = resolve;
                });
                firstToolResolved = true;
            } else {
                secondToolStartedBeforeFirstResolved = !firstToolResolved;
                resolveFirstTool?.();
            }

            return {
                toolCall: options.toolCall,
                result: 'ok',
                isError: false,
                toolLogId: null,
                toolLogKind: 'builtin',
                builtInToolId:
                    options.toolCall.name === 'builtin__setting'
                        ? ('setting' as BuiltInToolId)
                        : ('ask_user_question' as BuiltInToolId),
            };
        });

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createStartCheckpoint(),
            persister: createPersister(),
        });

        expect(result.type).toBe('completed');
        expect(builtInToolService.executeTool).toHaveBeenCalledTimes(2);
        expect(secondToolStartedBeforeFirstResolved).toBe(true);
    });
});
