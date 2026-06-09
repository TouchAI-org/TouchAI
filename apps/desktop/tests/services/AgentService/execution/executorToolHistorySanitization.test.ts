import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiProvider } from '@/services/AgentService/infrastructure/providers';

const testState = vi.hoisted(() => ({
    capturedMessages: [] as unknown[],
    streamCalls: 0,
}));

vi.mock('@database/queries', () => ({
    createBuiltInToolLog: vi.fn(),
    findBuiltInToolByToolId: vi.fn(),
    findEnabledBuiltInTools: vi.fn(),
    touchBuiltInToolLastUsed: vi.fn(),
    updateBuiltInToolLogByCallId: vi.fn(),
    createMcpToolLog: vi.fn(),
    updateMcpToolLogByCallId: vi.fn(),
}));

vi.mock('@/database/queries/searchConversation', () => ({
    searchConversationSessions: vi.fn(),
}));

vi.mock('@/database/queries/messages', () => ({
    findMessagesBySessionId: vi.fn(),
}));

vi.mock('@/services/AgentService/catalog', () => {
    const fakeProvider: AiProvider = {
        name: 'FakeProvider',
        driver: 'openai',
        request: vi.fn(),
        async *stream(options) {
            testState.capturedMessages.push(options.messages);
            testState.streamCalls += 1;
            if (testState.streamCalls === 1) {
                yield {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [
                        {
                            id: 'call-history-search',
                            name: 'builtin__search_conversation',
                            arguments: JSON.stringify({
                                query: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB',
                                keywords: ['AKIAIOSFODNN7EXAMPLE', 'memory'],
                            }),
                        },
                    ],
                };
                return;
            }

            yield {
                content: 'done',
                done: true,
                finishReason: 'stop',
            };
        },
        testConnection: vi.fn(),
        listModels: vi.fn(),
        getApiTargets: vi.fn(),
    };

    return {
        createProviderForModel: vi.fn(() => fakeProvider),
        createProviderInstance: vi.fn(() => fakeProvider),
        getModel: vi.fn(),
        resolveToolDefinitions: vi.fn(async () => [
            {
                name: 'builtin__search_conversation',
                description: 'Search conversations',
                input_schema: {
                    type: 'object',
                    properties: {},
                },
            },
        ]),
    };
});

const {
    createBuiltInToolLog,
    findBuiltInToolByToolId,
    touchBuiltInToolLastUsed,
    updateBuiltInToolLogByCallId,
} = await import('@database/queries');
const { searchConversationSessions } = await import('@/database/queries/searchConversation');
const { AiRequestExecutor } = await import('@/services/AgentService/execution/executor');

const model: ModelWithProvider = {
    id: 1,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
    provider_id: 1,
    model_id: 'gpt-5.5',
    name: 'GPT-5.5',
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
    provider_name: 'OpenAI',
    provider_driver: 'openai',
    api_endpoint: '',
    api_key: null,
    provider_config_json: null,
    provider_enabled: 1,
    provider_logo: '',
};

beforeEach(() => {
    testState.capturedMessages = [];
    testState.streamCalls = 0;
    vi.mocked(findBuiltInToolByToolId).mockResolvedValue({
        id: 1,
        tool_id: 'search_conversation',
        display_name: 'SearchConversation',
        description: '搜索历史会话',
        enabled: 1,
        risk_level: 'medium',
        config_json: null,
        last_used_at: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
    });
    vi.mocked(createBuiltInToolLog).mockResolvedValue({
        id: 10,
        tool_id: 'search_conversation',
        tool_call_id: 'call-history-search',
        session_id: 1,
        message_id: 2,
        iteration: 0,
        input: '{}',
        output: null,
        status: 'pending',
        approval_state: 'none',
        approval_summary: null,
        duration_ms: null,
        error_message: null,
        created_at: '2026-05-22T00:00:00.000Z',
    });
    vi.mocked(updateBuiltInToolLogByCallId).mockResolvedValue(undefined);
    vi.mocked(touchBuiltInToolLastUsed).mockResolvedValue();
    vi.mocked(searchConversationSessions).mockResolvedValue([]);
});

describe('AiRequestExecutor tool history sanitization', () => {
    it('uses sanitized built-in tool call arguments for model history and checkpoints', async () => {
        const executor = new AiRequestExecutor();
        const checkpoint = executor.createInitialCheckpoint({
            initialModel: model,
            baseMessages: [{ role: 'user', content: 'Find prior memory discussions.' }],
            modelLanguageContext: {
                locale: 'en-US',
                label: 'English (en-US)',
            },
        });
        const persistedCheckpoints: unknown[] = [];
        const persister = {
            getSessionId: () => 1,
            persistToolCallMessage: vi.fn(async () => 2),
            persistToolResultMessage: vi.fn(async () => undefined),
            persistCheckpoint: vi.fn(async (value: unknown) => {
                persistedCheckpoints.push(value);
            }),
        };

        const result = await executor.runAttempt({
            startCheckpoint: checkpoint,
            persister: persister as never,
        });

        expect(result.type).toBe('completed');
        expect(testState.capturedMessages).toHaveLength(2);
        expect(persistedCheckpoints).toHaveLength(1);

        const serializedSecondRequest = JSON.stringify(testState.capturedMessages[1]);
        const serializedCheckpoint = JSON.stringify(persistedCheckpoints[0]);

        expect(serializedSecondRequest).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyzAB');
        expect(serializedSecondRequest).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(serializedSecondRequest).toContain('[REDACTED_SECRET_LIKE_CONTENT]');
        expect(serializedCheckpoint).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwxyzAB');
        expect(serializedCheckpoint).not.toContain('AKIAIOSFODNN7EXAMPLE');
        expect(serializedCheckpoint).toContain('[REDACTED_SECRET_LIKE_CONTENT]');
    });
});
