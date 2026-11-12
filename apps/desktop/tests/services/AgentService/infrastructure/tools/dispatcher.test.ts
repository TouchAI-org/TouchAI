import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { tt } from '@/i18n';
import type { AiToolDefinition, ToolEvent } from '@/services/AgentService/contracts/tooling';
import type { ToolDispatchRequest } from '@/services/AgentService/infrastructure/tools';
import { dispatchToolCall } from '@/services/AgentService/infrastructure/tools';

const mocks = vi.hoisted(() => ({
    builtinExecuteTool: vi.fn(),
    resolveToolCall: vi.fn(),
    mcpExecuteTool: vi.fn(),
    createMcpToolLog: vi.fn(),
    updateMcpToolLogById: vi.fn(),
    createToolPart: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: { executeTool: mocks.builtinExecuteTool },
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: { resolveToolCall: mocks.resolveToolCall, executeTool: mocks.mcpExecuteTool },
}));

vi.mock('@database/queries', () => ({
    createMcpToolLog: mocks.createMcpToolLog,
    updateMcpToolLogById: mocks.updateMcpToolLogById,
}));

vi.mock('@database/queries/toolParts', () => ({
    createToolPart: mocks.createToolPart,
}));

function createRequest(overrides: Partial<ToolDispatchRequest> = {}): ToolDispatchRequest {
    return {
        toolCall: { id: 'call-1', name: 'builtin__bash', arguments: '{}' },
        iteration: 0,
        currentModel: {} as unknown as ModelWithProvider,
        sessionId: null,
        toolCallMessageId: null,
        emitToolEvent: () => {},
        ...overrides,
    };
}

function builtinResult(overrides: Record<string, unknown> = {}) {
    return {
        toolCall: { id: 'call-1', name: 'builtin__bash', arguments: '{}' },
        builtInToolId: 'bash',
        result: 'ok',
        isError: false,
        toolLogId: 7,
        toolLogKind: 'builtin',
        ...overrides,
    };
}

function mcpMapping() {
    return { serverId: 1, originalName: 'search', toolTimeout: 30000 };
}

describe('user runs a tool call requested by the model', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createMcpToolLog.mockResolvedValue({ id: 9 });
        mocks.updateMcpToolLogById.mockResolvedValue(undefined);
        mocks.createToolPart.mockResolvedValue({ id: 55 });
    });

    describe('given the tool name matches an enabled built-in tool', () => {
        it('user sees the built-in tool run and the MCP lookup skipped', async () => {
            mocks.builtinExecuteTool.mockResolvedValue(builtinResult());

            const result = await dispatchToolCall(
                createRequest({
                    toolCall: { id: 'call-1', name: 'builtin__bash', arguments: '{}' },
                })
            );

            expect(result).toMatchObject({
                input: '{}',
                result: 'ok',
                isError: false,
                toolLogId: 7,
                builtInToolId: 'bash',
            });
            expect(result.toolCall.name).toBe('builtin__bash');
            expect(mocks.builtinExecuteTool).toHaveBeenCalledTimes(1);
            expect(mocks.resolveToolCall).not.toHaveBeenCalled();
            expect(mocks.mcpExecuteTool).not.toHaveBeenCalled();
        });
    });

    describe('given the tool name is not a built-in tool', () => {
        it('user sees the MCP tool run as a fallback', async () => {
            mocks.builtinExecuteTool.mockResolvedValue(null);
            mocks.resolveToolCall.mockResolvedValue(mcpMapping());
            mocks.mcpExecuteTool.mockResolvedValue({ result: 'found', isError: false });

            const result = await dispatchToolCall(
                createRequest({
                    toolCall: { id: 'call-2', name: 'mcp__1__search', arguments: '{"query":"x"}' },
                })
            );

            expect(result).toMatchObject({ result: 'found', isError: false, toolLogId: 9 });
            expect(result.builtInToolId).toBeUndefined();
            expect(mocks.resolveToolCall).toHaveBeenCalledWith('mcp__1__search');
            expect(mocks.mcpExecuteTool).toHaveBeenCalledTimes(1);
        });
    });

    describe('given the tool declares an adaptive timeout ceiling', () => {
        it('user sees the suggested timeout applied and stripped from the arguments', async () => {
            mocks.builtinExecuteTool.mockResolvedValue(builtinResult());
            const toolDefinitions: AiToolDefinition[] = [
                {
                    name: 'builtin__bash',
                    description: '',
                    input_schema: { type: 'object', properties: {} },
                    adaptiveTimeoutCeilingMs: 60000,
                },
            ];

            const result = await dispatchToolCall(
                createRequest({
                    toolDefinitions,
                    toolCall: {
                        id: 'call-1',
                        name: 'builtin__bash',
                        arguments: '{"command":"ls","_meta":{"timeoutMs":5000}}',
                    },
                })
            );

            expect(mocks.builtinExecuteTool).toHaveBeenCalledWith(
                expect.objectContaining({
                    toolArgs: { command: 'ls' },
                    requestedTimeoutMs: 5000,
                })
            );
            expect(result.input).toBe('{"command":"ls"}');
        });
    });

    describe('given the tool has no adaptive timeout support', () => {
        it('user sees the arguments passed through untouched and the call still dispatched', async () => {
            mocks.builtinExecuteTool.mockResolvedValue(null);
            mocks.resolveToolCall.mockResolvedValue(mcpMapping());
            mocks.mcpExecuteTool.mockResolvedValue({ result: 'found', isError: false });
            const toolDefinitions: AiToolDefinition[] = [
                {
                    name: 'mcp__1__search',
                    description: '',
                    input_schema: { type: 'object', properties: {} },
                },
            ];
            const args = { query: 'x', _meta: { timeoutMs: 5000 } };

            await dispatchToolCall(
                createRequest({
                    toolDefinitions,
                    toolCall: {
                        id: 'call-3',
                        name: 'mcp__1__search',
                        arguments: JSON.stringify(args),
                    },
                })
            );

            expect(mocks.builtinExecuteTool).toHaveBeenCalledWith(
                expect.objectContaining({ toolArgs: args, requestedTimeoutMs: undefined })
            );
            expect(mocks.mcpExecuteTool).toHaveBeenCalledTimes(1);
        });

        it('user sees the meta object preserved when the catalog does not describe the tool', async () => {
            mocks.builtinExecuteTool.mockResolvedValue(builtinResult());
            const args = { command: 'ls', _meta: { timeoutMs: 5000 } };

            await dispatchToolCall(
                createRequest({
                    toolCall: {
                        id: 'call-4',
                        name: 'builtin__bash',
                        arguments: JSON.stringify(args),
                    },
                })
            );

            expect(mocks.builtinExecuteTool).toHaveBeenCalledWith(
                expect.objectContaining({ toolArgs: args, requestedTimeoutMs: undefined })
            );
        });
    });

    describe('given the tool arguments are not valid JSON', () => {
        it('user sees the rejected call kept in history with its original name', async () => {
            const result = await dispatchToolCall(
                createRequest({
                    sessionId: 3,
                    toolCallMessageId: 8,
                    toolCall: {
                        id: 'call-rejected',
                        name: 'unknown.tool',
                        arguments: '{"secret":"value"',
                    },
                })
            );

            expect(mocks.createToolPart).toHaveBeenCalledWith(
                'mcp',
                expect.objectContaining({
                    tool_call_id: 'call-rejected',
                    session_id: 3,
                    message_id: 8,
                    requestedName: 'unknown.tool',
                    input: '{"secret":"[redacted]"',
                    status: 'error',
                })
            );
            expect(result).toMatchObject({
                input: '{"secret":"[redacted]"',
                isError: true,
                toolLogId: 55,
                argumentParseFailed: true,
            });
        });

        it('user sees a protocol error reported instead of running any tool', async () => {
            const events: ToolEvent[] = [];
            const expected = tt('工具参数协议错误：{toolName} 返回了无效的 JSON 参数。', {
                toolName: 'builtin__bash',
            });

            const result = await dispatchToolCall(
                createRequest({
                    emitToolEvent: (event) => events.push(event),
                    toolCall: { id: 'call-5', name: 'builtin__bash', arguments: '{' },
                })
            );

            expect(result.result).toBe(expected);
            expect(result.isError).toBe(true);
            expect(result.toolLogId).toBeNull();
            expect(result.argumentParseFailed).toBe(true);
            expect(mocks.builtinExecuteTool).not.toHaveBeenCalled();
            expect(mocks.mcpExecuteTool).not.toHaveBeenCalled();
            expect(events).toEqual([
                expect.objectContaining({
                    type: 'call_end',
                    callId: 'call-5',
                    result: expected,
                    isError: true,
                    durationMs: 0,
                    finalStatus: 'error',
                }),
            ]);
        });
    });

    describe('given the tool arguments are valid JSON but not an object', () => {
        it('user sees a shape error reported instead of running any tool', async () => {
            const result = await dispatchToolCall(
                createRequest({
                    toolCall: { id: 'call-6', name: 'builtin__bash', arguments: '123' },
                })
            );

            expect(result.isError).toBe(true);
            expect(result.argumentParseFailed).toBe(true);
            expect(result.result).toContain(
                tt('工具参数协议错误：{toolName} 必须接收 JSON 对象。', {
                    toolName: 'builtin__bash',
                })
            );
            expect(mocks.builtinExecuteTool).not.toHaveBeenCalled();
        });
    });

    describe('given the request was already cancelled', () => {
        it('user sees the tool call cancelled before any tool runs', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                dispatchToolCall(
                    createRequest({
                        signal: controller.signal,
                        toolCall: { id: 'call-7', name: 'builtin__bash', arguments: '{}' },
                    })
                )
            ).rejects.toThrow();
            expect(mocks.builtinExecuteTool).not.toHaveBeenCalled();
            expect(mocks.mcpExecuteTool).not.toHaveBeenCalled();
        });
    });

    describe('given the caller provides a cancellation signal', () => {
        it('user sees the signal forwarded to the built-in tool so a cancel can stop it', async () => {
            mocks.builtinExecuteTool.mockResolvedValue(builtinResult());
            const controller = new AbortController();

            await dispatchToolCall(
                createRequest({
                    signal: controller.signal,
                    toolCall: { id: 'call-8', name: 'builtin__bash', arguments: '{}' },
                })
            );

            expect(mocks.builtinExecuteTool).toHaveBeenCalledWith(
                expect.objectContaining({ signal: controller.signal })
            );
        });
    });
});
