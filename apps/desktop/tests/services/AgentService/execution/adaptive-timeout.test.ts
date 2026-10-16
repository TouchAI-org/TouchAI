import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';

const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

const { executeBuiltInToolMock, resolveMcpToolCallMock, executeMcpToolMock } = vi.hoisted(() => ({
    executeBuiltInToolMock: vi.fn(async () => null),
    resolveMcpToolCallMock: vi.fn(async () => ({
        serverId: 1,
        originalName: 'search',
        toolTimeout: 30000,
    })),
    executeMcpToolMock: vi.fn(async () => ({ result: 'ok', isError: false })),
}));

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: vi.fn(() => providerMock),
    resolveToolDefinitions: vi.fn(() => Promise.resolve([])),
    getModel: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: { executeTool: executeBuiltInToolMock },
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        executeTool: executeMcpToolMock,
        resolveToolCall: resolveMcpToolCallMock,
    },
}));

vi.mock('@database/queries', () => ({
    createMcpToolLog: vi.fn(async () => ({ id: 1 })),
    updateMcpToolLogByCallId: vi.fn(async () => undefined),
}));

function createCheckpoint(): AttemptCheckpoint {
    return {
        activeModel: {
            id: 1,
            provider_id: 1,
            model_id: 'test-model',
            name: 'Test',
            tool_call: 1,
        },
        messages: [{ role: 'user', content: 'hello' }],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
        executedBuiltInToolIds: [],
    } as unknown as AttemptCheckpoint;
}

function persister() {
    return {
        persistOutputProgress: vi.fn().mockResolvedValue(undefined),
        persistToolCallMessage: vi.fn().mockResolvedValue(1),
        persistToolResultMessage: vi.fn().mockResolvedValue(undefined),
        persistCheckpoint: vi.fn().mockResolvedValue(undefined),
        getSessionId: vi.fn(() => 1),
    } as never;
}

describe('AiRequestExecutor adaptive tool timeout wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        executeBuiltInToolMock.mockResolvedValue(null);
        resolveMcpToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        executeMcpToolMock.mockResolvedValue({ result: 'ok', isError: false });
    });

    function streamToolCallThenFinish(args: string) {
        providerMock.stream
            .mockImplementationOnce(async function* () {
                yield {
                    content: '',
                    done: true,
                    finishReason: 'tool_calls',
                    toolCalls: [{ id: 'call-1', name: 'mcp__1__search', arguments: args }],
                };
            })
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });
    }

    it('forwards the requested timeout to the MCP executor and strips _meta from arguments', async () => {
        streamToolCallThenFinish(JSON.stringify({ query: 'hi', _meta: { timeoutMs: 45000 } }));

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister(),
        });

        expect(result.type).toBe('completed');
        expect(executeMcpToolMock).toHaveBeenCalledWith(
            'mcp__1__search',
            { query: 'hi' },
            expect.objectContaining({ requestedTimeoutMs: 45000 })
        );
        expect(executeBuiltInToolMock).toHaveBeenCalledWith(
            expect.objectContaining({ toolArgs: { query: 'hi' }, requestedTimeoutMs: 45000 })
        );
    });

    it('does not forward a timeout when the model omits _meta', async () => {
        streamToolCallThenFinish(JSON.stringify({ query: 'hi' }));

        await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister(),
        });

        expect(executeMcpToolMock).toHaveBeenCalledWith(
            'mcp__1__search',
            { query: 'hi' },
            expect.objectContaining({ requestedTimeoutMs: undefined })
        );
    });

    it('discards malformed _meta while preserving valid business arguments', async () => {
        streamToolCallThenFinish(JSON.stringify({ query: 'hi', _meta: 'not-an-object' }));

        await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister(),
        });

        expect(executeMcpToolMock).toHaveBeenCalledWith(
            'mcp__1__search',
            { query: 'hi' },
            expect.objectContaining({ requestedTimeoutMs: undefined })
        );
    });
});
