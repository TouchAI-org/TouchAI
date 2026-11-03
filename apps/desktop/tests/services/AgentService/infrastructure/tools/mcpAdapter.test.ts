import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tt } from '@/i18n';
import type { ToolEvent } from '@/services/AgentService/contracts/tooling';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';
import type { ToolCallContext } from '@/services/AgentService/infrastructure/tools';
import { executeMcpTool } from '@/services/AgentService/infrastructure/tools/mcpAdapter';

const mocks = vi.hoisted(() => ({
    resolveToolCall: vi.fn(),
    mcpExecuteTool: vi.fn(),
    createMcpToolLog: vi.fn(),
    updateMcpToolLogByCallId: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: { resolveToolCall: mocks.resolveToolCall, executeTool: mocks.mcpExecuteTool },
}));

vi.mock('@database/queries', () => ({
    createMcpToolLog: mocks.createMcpToolLog,
    updateMcpToolLogByCallId: mocks.updateMcpToolLogByCallId,
}));

function createContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
    return {
        toolCall: { id: 'call-1', name: 'mcp__1__search', arguments: '{"query":"alpha"}' },
        iteration: 0,
        currentModel: {} as unknown as ModelWithProvider,
        hasExecutedBuiltInTool: () => false,
        sessionId: null,
        toolCallMessageId: null,
        emitToolEvent: () => {},
        ...overrides,
    };
}

describe('user runs an MCP tool call', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createMcpToolLog.mockResolvedValue({ id: 42 });
        mocks.updateMcpToolLogByCallId.mockResolvedValue(undefined);
    });

    it('user sees the call start and end reported around a logged result', async () => {
        mocks.resolveToolCall.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        mocks.mcpExecuteTool.mockResolvedValue({ result: 'found', isError: false });
        const events: ToolEvent[] = [];

        const outcome = await executeMcpTool({
            context: createContext({ emitToolEvent: (event) => events.push(event) }),
            toolArgs: { query: 'alpha' },
        });

        expect(events[0]).toMatchObject({
            type: 'call_start',
            callId: 'call-1',
            toolName: 'search',
            namespacedName: 'mcp__1__search',
            source: 'mcp',
            serverId: 1,
            arguments: { query: 'alpha' },
        });
        expect(events[events.length - 1]).toMatchObject({
            type: 'call_end',
            callId: 'call-1',
            result: 'found',
            isError: false,
            finalStatus: 'completed',
        });
        expect(mocks.createMcpToolLog).toHaveBeenCalledWith(
            expect.objectContaining({
                server_id: 1,
                tool_name: 'search',
                tool_call_id: 'call-1',
                status: 'pending',
            })
        );
        expect(mocks.updateMcpToolLogByCallId).toHaveBeenCalledWith(
            'call-1',
            expect.objectContaining({ output: 'found', status: 'success' })
        );
        expect(outcome).toMatchObject({ result: 'found', isError: false, toolLogId: 42 });
    });

    it('user sees a not-found tool reported without any execution or log', async () => {
        mocks.resolveToolCall.mockResolvedValue(null);
        const events: ToolEvent[] = [];

        const outcome = await executeMcpTool({
            context: createContext({
                emitToolEvent: (event) => events.push(event),
                toolCall: { id: 'call-2', name: 'mcp__1__missing', arguments: '{}' },
            }),
            toolArgs: {},
        });

        expect(outcome).toEqual({
            result: tt('未找到工具：{toolName}', { toolName: 'mcp__1__missing' }),
            isError: true,
            toolLogId: null,
        });
        expect(events).toEqual([
            expect.objectContaining({
                type: 'call_end',
                callId: 'call-2',
                isError: true,
                finalStatus: 'error',
            }),
        ]);
        expect(mocks.mcpExecuteTool).not.toHaveBeenCalled();
        expect(mocks.createMcpToolLog).not.toHaveBeenCalled();
    });

    it('user sees a localized failure when the MCP call rejects', async () => {
        mocks.resolveToolCall.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        mocks.mcpExecuteTool.mockRejectedValue(new Error('socket closed'));
        const events: ToolEvent[] = [];

        const outcome = await executeMcpTool({
            context: createContext({ emitToolEvent: (event) => events.push(event) }),
            toolArgs: { query: 'alpha' },
        });

        expect(outcome).toMatchObject({
            result: tt('工具执行失败：{error}', { error: 'socket closed' }),
            isError: true,
            toolLogId: 42,
        });
        expect(events[events.length - 1]).toMatchObject({
            type: 'call_end',
            isError: true,
            finalStatus: 'error',
        });
        expect(mocks.updateMcpToolLogByCallId).toHaveBeenCalledWith(
            'call-1',
            expect.objectContaining({ status: 'error' })
        );
    });

    it('user receives the attachments the tool produced', async () => {
        mocks.resolveToolCall.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        const attachments = [{ id: 5 }] as unknown as AttachmentIndex[];
        mocks.mcpExecuteTool.mockResolvedValue({ result: 'image', isError: false, attachments });

        const outcome = await executeMcpTool({
            context: createContext(),
            toolArgs: { query: 'alpha' },
        });

        expect(outcome.attachments).toBe(attachments);
    });

    it('user sees the cancellation signal forwarded to the MCP call', async () => {
        mocks.resolveToolCall.mockResolvedValue({
            serverId: 1,
            originalName: 'search',
            toolTimeout: 30000,
        });
        mocks.mcpExecuteTool.mockResolvedValue({ result: 'found', isError: false });
        const controller = new AbortController();

        await executeMcpTool({
            context: createContext({ signal: controller.signal }),
            toolArgs: { query: 'alpha' },
            requestedTimeoutMs: 4000,
        });

        expect(mocks.mcpExecuteTool).toHaveBeenCalledWith(
            'mcp__1__search',
            { query: 'alpha' },
            expect.objectContaining({ signal: controller.signal, requestedTimeoutMs: 4000 })
        );
    });
});
