import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiStreamChunk } from '@/services/AgentService/contracts/protocol';
import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';

const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

const {
    createMcpToolLogMock,
    executeBuiltInToolMock,
    executeMcpToolMock,
    resolveMcpToolCallMock,
    resolveToolDefinitionsMock,
} = vi.hoisted(() => ({
    createMcpToolLogMock: vi.fn(async () => ({ id: 1 })),
    executeBuiltInToolMock: vi.fn(async () => null),
    executeMcpToolMock: vi.fn(async () => ({ result: 'ok', isError: false })),
    resolveMcpToolCallMock: vi.fn(async () => ({
        serverId: 1,
        originalName: 'search',
        toolTimeout: 30000,
    })),
    resolveToolDefinitionsMock: vi.fn<() => Promise<AiToolDefinition[]>>(async () => []),
}));

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: vi.fn(() => providerMock),
    resolveToolDefinitions: resolveToolDefinitionsMock,
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
    createMcpToolLog: createMcpToolLogMock,
    updateMcpToolLogByCallId: vi.fn(async () => undefined),
}));

const MCP_TOOL_NAME = 'mcp__1__search';

function adaptiveToolDefinition(name: string): AiToolDefinition {
    return {
        name,
        description: 'search',
        input_schema: {
            type: 'object' as const,
            properties: { query: { type: 'string' } },
        },
        adaptiveTimeoutCeilingMs: 600000,
    };
}

function plainToolDefinition(name: string): AiToolDefinition {
    return {
        name,
        description: 'search',
        input_schema: {
            type: 'object' as const,
            properties: { query: { type: 'string' } },
        },
    };
}

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

function streamToolCallThenFinish(args: string) {
    providerMock.stream
        .mockImplementationOnce(async function* () {
            yield {
                content: '',
                done: true,
                finishReason: 'tool_calls',
                toolCalls: [{ id: 'call-1', name: MCP_TOOL_NAME, arguments: args }],
            };
        })
        .mockImplementationOnce(async function* () {
            yield { content: 'Done', done: true };
        });
}

function collectToolEvents() {
    const events: Array<Record<string, unknown>> = [];
    return {
        events,
        onChunk: (chunk: AiStreamChunk) => {
            if (chunk.toolEvent) {
                events.push(chunk.toolEvent as unknown as Record<string, unknown>);
            }
        },
    };
}

describe('AiRequestExecutor adaptive tool timeout wiring', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        executeBuiltInToolMock.mockResolvedValue(null);
        executeMcpToolMock.mockResolvedValue({ result: 'ok', isError: false });
        resolveMcpToolCallMock.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        resolveToolDefinitionsMock.mockResolvedValue([adaptiveToolDefinition(MCP_TOOL_NAME)]);
    });

    it('forwards the requested timeout to the MCP executor and strips _meta from arguments', async () => {
        streamToolCallThenFinish(JSON.stringify({ query: 'hi', _meta: { timeoutMs: 45000 } }));

        const result = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister(),
        });

        expect(result.type).toBe('completed');
        expect(executeMcpToolMock).toHaveBeenCalledWith(
            MCP_TOOL_NAME,
            { query: 'hi' },
            expect.objectContaining({ requestedTimeoutMs: 45000 })
        );
        expect(executeBuiltInToolMock).toHaveBeenCalledWith(
            expect.objectContaining({ toolArgs: { query: 'hi' }, requestedTimeoutMs: 45000 })
        );
    });

    it('keeps _meta out of the MCP call_start event and tool log input', async () => {
        streamToolCallThenFinish(JSON.stringify({ query: 'hi', _meta: { timeoutMs: 45000 } }));
        const { events, onChunk } = collectToolEvents();

        await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister(),
            onChunk,
        });

        const callStart = events.find(
            (event) => event.type === 'call_start' && event.namespacedName === MCP_TOOL_NAME
        );
        expect(callStart?.arguments).toEqual({ query: 'hi' });
        expect(createMcpToolLogMock).toHaveBeenCalledWith(
            expect.objectContaining({ input: JSON.stringify({ query: 'hi' }) })
        );
    });

    it('does not forward a timeout when the model omits _meta', async () => {
        streamToolCallThenFinish(JSON.stringify({ query: 'hi' }));

        await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister(),
        });

        expect(executeMcpToolMock).toHaveBeenCalledWith(
            MCP_TOOL_NAME,
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
            MCP_TOOL_NAME,
            { query: 'hi' },
            expect.objectContaining({ requestedTimeoutMs: undefined })
        );
    });

    it('preserves a business _meta argument for tools that do not support adaptive timeouts', async () => {
        resolveToolDefinitionsMock.mockResolvedValue([plainToolDefinition(MCP_TOOL_NAME)]);
        streamToolCallThenFinish(JSON.stringify({ query: 'hi', _meta: { timeoutMs: 45000 } }));

        await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persister(),
        });

        expect(executeMcpToolMock).toHaveBeenCalledWith(
            MCP_TOOL_NAME,
            { query: 'hi', _meta: { timeoutMs: 45000 } },
            expect.objectContaining({ requestedTimeoutMs: undefined })
        );
    });
});
