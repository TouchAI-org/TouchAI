import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolEvent } from '@/services/AgentService/contracts/tooling';

vi.mock('@database/queries', () => ({
    createBuiltInToolLog: vi.fn(),
    findBuiltInToolByToolId: vi.fn(),
    findEnabledBuiltInTools: vi.fn(),
    touchBuiltInToolLastUsed: vi.fn(),
    updateBuiltInToolLogByCallId: vi.fn(),
}));

vi.mock('@/database/queries/searchConversation', () => ({
    searchConversationSessions: vi.fn(),
}));

vi.mock('@/database/queries/messages', () => ({
    findMessagesBySessionId: vi.fn(),
}));

const {
    createBuiltInToolLog,
    findBuiltInToolByToolId,
    touchBuiltInToolLastUsed,
    updateBuiltInToolLogByCallId,
} = await import('@database/queries');
const { searchConversationSessions } = await import('@/database/queries/searchConversation');
const { builtInToolService } = await import('@/services/BuiltInToolService');

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
    vi.clearAllMocks();
    vi.mocked(findBuiltInToolByToolId).mockImplementation(async (toolId) => ({
        id: 1,
        tool_id: toolId,
        display_name: toolId === 'search_conversation' ? 'SearchConversation' : 'Memory',
        description:
            toolId === 'search_conversation'
                ? 'Search past conversation sessions'
                : 'Read and maintain durable memories',
        enabled: 1,
        risk_level: 'medium',
        config_json: null,
        last_used_at: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
    }));
    vi.mocked(createBuiltInToolLog).mockResolvedValue({
        id: 10,
        tool_id: 'memory',
        tool_call_id: 'call-secret',
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
    vi.mocked(touchBuiltInToolLastUsed).mockResolvedValue();
    vi.mocked(updateBuiltInToolLogByCallId).mockResolvedValue(undefined);
    vi.mocked(searchConversationSessions).mockResolvedValue([]);
});

describe('builtInToolService memory sanitization', () => {
    it('rejects secret-like memory writes before raw content reaches events or logs', async () => {
        const events: ToolEvent[] = [];
        const secret = 'OPENAI_API_KEY=sk-test-secret-value';

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'call-secret',
                name: 'builtin__memory',
                arguments: '',
            },
            toolArgs: {
                action: 'upsert',
                title: 'API key',
                applicability: 'When calling external services.',
                content: secret,
            },
            iteration: 0,
            currentModel: model,
            hasExecutedBuiltInTool: () => false,
            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval: vi.fn().mockResolvedValue(true),
            emitToolEvent: (event) => events.push(event),
        });

        expect(result).toMatchObject({
            builtInToolId: 'memory',
            isError: true,
            toolLogId: null,
        });
        expect(result?.result).toContain('Refusing to store secret-like content');
        expect(createBuiltInToolLog).not.toHaveBeenCalled();
        expect(touchBuiltInToolLastUsed).not.toHaveBeenCalled();
        expect(JSON.stringify(events)).not.toContain(secret);
        const callStart = events.find((event) => event.type === 'call_start');
        expect(
            callStart && 'arguments' in callStart ? callStart.arguments.content : undefined
        ).toBe('[REDACTED_MEMORY_CONTENT]');
    });

    it('redacts secret-like search terms from events, logs, and conversation semantics', async () => {
        const events: ToolEvent[] = [];
        const githubToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB';
        const awsAccessKey = 'AKIAIOSFODNN7EXAMPLE';

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'call-search-secret',
                name: 'builtin__search_conversation',
                arguments: '',
            },
            toolArgs: {
                query: githubToken,
                keywords: [awsAccessKey, 'memory'],
            },
            iteration: 0,
            currentModel: model,
            hasExecutedBuiltInTool: () => false,
            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval: vi.fn().mockResolvedValue(true),
            emitToolEvent: (event) => events.push(event),
        });

        expect(result).toMatchObject({
            builtInToolId: 'search_conversation',
            isError: false,
        });
        expect(createBuiltInToolLog).toHaveBeenCalled();

        const callStart = events.find((event) => event.type === 'call_start');
        expect(callStart?.type).toBe('call_start');
        if (!callStart || callStart.type !== 'call_start') {
            throw new Error('Expected call_start event');
        }

        expect(JSON.stringify(callStart.arguments)).not.toContain(githubToken);
        expect(JSON.stringify(callStart.arguments)).not.toContain(awsAccessKey);
        expect(callStart.arguments).toMatchObject({
            query: '[REDACTED_SECRET_LIKE_CONTENT]',
            keywords: ['[REDACTED_SECRET_LIKE_CONTENT]', 'memory'],
        });
        expect(callStart.builtinConversationSemantic?.target).not.toContain(githubToken);
        expect(callStart.builtinConversationSemantic?.target).not.toContain(awsAccessKey);
        expect(callStart.builtinConversationSemantic?.target).toContain(
            '[REDACTED_SECRET_LIKE_CONTENT]'
        );

        const createLogCalls = vi.mocked(createBuiltInToolLog).mock.calls;
        const logInput = createLogCalls[createLogCalls.length - 1]?.[0].input ?? '';
        expect(logInput).not.toContain(githubToken);
        expect(logInput).not.toContain(awsAccessKey);
        expect(logInput).toContain('[REDACTED_SECRET_LIKE_CONTENT]');
    });

    it('sanitizes built-in tool call arguments before they enter assistant history', async () => {
        const githubToken = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB';
        const awsAccessKey = 'AKIAIOSFODNN7EXAMPLE';
        const memorySecret = 'OPENAI_API_KEY=sk-history-memory-secret';

        const sanitizedSearch = await builtInToolService.sanitizeToolCallForHistory({
            id: 'call-history-search',
            name: 'builtin__search_conversation',
            arguments: JSON.stringify({
                query: githubToken,
                keywords: [awsAccessKey, 'memory'],
            }),
        });
        const sanitizedMemory = await builtInToolService.sanitizeToolCallForHistory({
            id: 'call-history-memory',
            name: 'builtin__memory',
            arguments: JSON.stringify({
                action: 'upsert',
                title: 'Desktop Agent preferences',
                applicability: 'When remembering durable user preferences.',
                content: memorySecret,
            }),
        });

        const searchArgs = JSON.parse(sanitizedSearch.arguments) as Record<string, unknown>;
        const memoryArgs = JSON.parse(sanitizedMemory.arguments) as Record<string, unknown>;

        expect(searchArgs).toMatchObject({
            query: '[REDACTED_SECRET_LIKE_CONTENT]',
            keywords: ['[REDACTED_SECRET_LIKE_CONTENT]', 'memory'],
        });
        expect(memoryArgs).toMatchObject({
            content: '[REDACTED_MEMORY_CONTENT]',
        });
    });
});
