import { describe, expect, it, vi } from 'vitest';

import type { AiToolCall } from '@/services/AgentService/contracts/tooling';

const {
    createBuiltInToolLogMock,
    findBuiltInToolByToolIdMock,
    touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallIdMock,
    registryGetMock,
} = vi.hoisted(() => ({
    createBuiltInToolLogMock: vi.fn(),
    findBuiltInToolByToolIdMock: vi.fn(),
    touchBuiltInToolLastUsedMock: vi.fn(),
    updateBuiltInToolLogByCallIdMock: vi.fn(),
    registryGetMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createBuiltInToolLog: createBuiltInToolLogMock,
    findBuiltInToolByToolId: findBuiltInToolByToolIdMock,
    findEnabledBuiltInTools: vi.fn(),
    touchBuiltInToolLastUsed: touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallId: updateBuiltInToolLogByCallIdMock,
}));

vi.mock('@/services/BuiltInToolService/registry', () => ({
    builtInToolRegistry: {
        get: registryGetMock,
    },
}));

async function loadBuiltInToolService() {
    return (await import('@/services/BuiltInToolService/service')).builtInToolService;
}

function createToolCall(): AiToolCall {
    return {
        id: 'call-builtin-1',
        name: 'builtin__bash',
        arguments: '{}',
    };
}

describe('BuiltInToolService.executeTool', () => {
    it('emits call_start with startedAt before executing the builtin tool', async () => {
        createBuiltInToolLogMock.mockResolvedValue({ id: 17 });
        findBuiltInToolByToolIdMock.mockResolvedValue({
            tool_id: 'bash',
            enabled: 1,
            config_json: null,
        });
        touchBuiltInToolLastUsedMock.mockResolvedValue(undefined);
        updateBuiltInToolLogByCallIdMock.mockResolvedValue(undefined);
        registryGetMock.mockReturnValue({
            id: 'bash',
            displayName: 'Bash',
            description: 'Run a PowerShell command',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            defaultConfig: {},
            parseConfig: vi.fn(() => ({})),
            buildConversationSemantic: vi.fn(() => ({
                action: 'run',
                target: 'Write-Output "alpha"',
            })),
            buildConversationSemanticWithContext: vi.fn(() => ({
                action: 'run',
                target: 'Write-Output "alpha"',
            })),
            buildApprovalRequest: vi.fn(async () => null),
            execute: vi.fn(async () => ({
                result: 'alpha',
                isError: false,
                status: 'success',
            })),
        });

        const builtInToolService = await loadBuiltInToolService();
        const emitToolEvent = vi.fn();

        const result = await builtInToolService.executeTool({
            toolCall: createToolCall(),
            toolArgs: {
                command: 'Write-Output "alpha"',
            },
            iteration: 0,
            currentModel: {} as never,
            hasExecutedBuiltInTool: vi.fn(() => false),
            sessionId: null,
            toolCallMessageId: null,
            emitToolEvent,
        });

        expect(result).toMatchObject({
            builtInToolId: 'bash',
            isError: false,
        });

        const callStartEvent = emitToolEvent.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'call_start');

        expect(callStartEvent).toMatchObject({
            type: 'call_start',
            callId: 'call-builtin-1',
            toolName: 'Bash',
            namespacedName: 'builtin__bash',
            source: 'builtin',
            arguments: {
                command: 'Write-Output "alpha"',
            },
            startedAt: expect.any(Number),
        });
    });

    it('emits an immediate call_start before async semantic preparation finishes', async () => {
        createBuiltInToolLogMock.mockResolvedValue({ id: 18 });
        updateBuiltInToolLogByCallIdMock.mockResolvedValue(undefined);
        findBuiltInToolByToolIdMock.mockResolvedValue({
            tool_id: 'bash',
            enabled: 1,
            config_json: null,
        });
        touchBuiltInToolLastUsedMock.mockResolvedValue(undefined);

        let resolveSemantic: ((value: { action: 'run'; target: string }) => void) | null = null;
        registryGetMock.mockReturnValue({
            id: 'bash',
            displayName: 'Bash',
            description: 'Run a PowerShell command',
            inputSchema: {
                type: 'object',
                properties: {},
            },
            defaultConfig: {},
            parseConfig: vi.fn(() => ({})),
            buildConversationSemantic: vi.fn(() => ({
                action: 'run',
                target: 'fallback target',
            })),
            buildConversationSemanticWithContext: vi.fn(
                () =>
                    new Promise((resolve) => {
                        resolveSemantic = resolve;
                    })
            ),
            buildApprovalRequest: vi.fn(async () => null),
            execute: vi.fn(async () => ({
                result: 'alpha',
                isError: false,
                status: 'success',
            })),
        });

        const builtInToolService = await loadBuiltInToolService();
        const emitToolEvent = vi.fn();
        const executionPromise = builtInToolService.executeTool({
            toolCall: createToolCall(),
            toolArgs: {
                command: 'Write-Output "alpha"',
            },
            iteration: 0,
            currentModel: {} as never,
            hasExecutedBuiltInTool: vi.fn(() => false),
            sessionId: null,
            toolCallMessageId: null,
            emitToolEvent,
        });

        await vi.waitFor(() => {
            expect(emitToolEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'call_start',
                    callId: 'call-builtin-1',
                    builtinConversationSemantic: {
                        action: 'run',
                        target: 'fallback target',
                    },
                })
            );
        });

        expect(resolveSemantic).not.toBeNull();
        resolveSemantic!({
            action: 'run',
            target: 'resolved target',
        });
        await executionPromise;
    });
});
