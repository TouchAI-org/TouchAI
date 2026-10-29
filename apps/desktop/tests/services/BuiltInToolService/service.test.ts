import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
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

function createRegistryTool(overrides: Record<string, unknown> = {}) {
    return {
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
        buildConversationSemanticWithContext: vi.fn(async () => ({
            action: 'run',
            target: 'Write-Output "alpha"',
        })),
        buildApprovalRequest: vi.fn(async () => null),
        execute: vi.fn(async () => ({
            result: 'alpha',
            isError: false,
            status: 'success',
        })),
        ...overrides,
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    createBuiltInToolLogMock.mockResolvedValue({ id: 21 });
    findBuiltInToolByToolIdMock.mockResolvedValue({
        tool_id: 'bash',
        enabled: 1,
        config_json: null,
    });
    touchBuiltInToolLastUsedMock.mockResolvedValue(undefined);
    updateBuiltInToolLogByCallIdMock.mockResolvedValue(undefined);
    registryGetMock.mockReturnValue(createRegistryTool());
});

function executeBuiltInTool(
    builtInToolService: Awaited<ReturnType<typeof loadBuiltInToolService>>,
    overrides: Record<string, unknown> = {}
) {
    return builtInToolService.executeTool({
        toolCall: createToolCall(),
        toolArgs: {
            command: 'Write-Output "alpha"',
        },
        iteration: 0,
        currentModel: {} as never,
        hasExecutedBuiltInTool: vi.fn(() => false),
        sessionId: null,
        toolCallMessageId: null,
        emitToolEvent: vi.fn(),
        ...overrides,
    } as never);
}

describe('user runs a built-in tool', () => {
    it('user does not see api keys in a built-in tool log entry', async () => {
        createBuiltInToolLogMock.mockResolvedValue({ id: 19 });
        registryGetMock.mockReturnValue(
            createRegistryTool({
                execute: vi.fn(async () => ({
                    result: 'failed with sk-live-secret-123456',
                    isError: false,
                    status: 'success',
                })),
            })
        );

        const builtInToolService = await loadBuiltInToolService();
        await executeBuiltInTool(builtInToolService, {
            toolArgs: { command: 'deploy', apiKey: 'sk-live-secret-123456' },
        });

        expect(createBuiltInToolLogMock).toHaveBeenCalledWith(
            expect.objectContaining({
                input: expect.not.stringContaining('sk-live-secret-123456'),
            })
        );
        expect(updateBuiltInToolLogByCallIdMock).toHaveBeenLastCalledWith(
            'call-builtin-1',
            expect.objectContaining({
                output: expect.not.stringContaining('sk-live-secret-123456'),
            })
        );
    });

    it('user gets the same tool card back when the stored payload holds a query string', async () => {
        const conversationSemantic = {
            action: 'search',
            target: 'https://api.example.test/v1?token=semantic-secret',
        };
        const structuredPayload = {
            sources: [{ url: 'https://example.test/a?q=1#frag' }],
        };
        registryGetMock.mockReturnValue(
            createRegistryTool({
                execute: vi.fn(async () => ({
                    result: 'alpha',
                    isError: false,
                    status: 'success',
                    conversationSemantic,
                    structuredPayload,
                })),
            })
        );

        await executeBuiltInTool(await loadBuiltInToolService());

        const payload = updateBuiltInToolLogByCallIdMock.mock.lastCall?.[1] as {
            conversation_semantic_json: string;
            structured_payload_json: string;
        };
        expect(JSON.parse(payload.conversation_semantic_json)).toEqual(conversationSemantic);
        expect(JSON.parse(payload.structured_payload_json)).toEqual(structuredPayload);
    });

    it('user sees the tool call start reported with its start time before the tool runs', async () => {
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

    it('user sees the tool call start reported before slow preparation finishes', async () => {
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

describe('user still runs a built-in tool when bookkeeping fails', () => {
    it('user gets the fallback description when the tool cannot build a richer one', async () => {
        registryGetMock.mockReturnValue(
            createRegistryTool({
                buildConversationSemanticWithContext: vi.fn(async () => {
                    throw new Error('context unavailable');
                }),
            })
        );
        const builtInToolService = await loadBuiltInToolService();

        const result = await executeBuiltInTool(builtInToolService);

        expect(result?.isError).toBe(false);
    });

    it('user gets the tool result when its log row cannot be created', async () => {
        createBuiltInToolLogMock.mockRejectedValue(new Error('disk full'));
        const builtInToolService = await loadBuiltInToolService();

        const result = await executeBuiltInTool(builtInToolService);

        expect(result).toMatchObject({ result: 'alpha', toolLogId: null });
    });

    it('user gets the approval request even when its pending state cannot be saved', async () => {
        registryGetMock.mockReturnValue(
            createRegistryTool({
                buildApprovalRequest: vi.fn(async () => ({ reason: 'needs approval' })),
            })
        );
        updateBuiltInToolLogByCallIdMock.mockImplementation(
            async (_callId: string, patch: { status?: string }) => {
                if (patch.status === 'awaiting_approval') {
                    throw new Error('database is locked');
                }
            }
        );
        const builtInToolService = await loadBuiltInToolService();
        const emitToolEvent = vi.fn();

        const result = await executeBuiltInTool(builtInToolService, {
            requestToolApproval: vi.fn(async () => true),
            emitToolEvent,
        });

        expect(result?.isError).toBe(false);
        expect(emitToolEvent).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'approval_required' })
        );
    });

    it('user gets the rejection reported even when the rejected state cannot be saved', async () => {
        registryGetMock.mockReturnValue(
            createRegistryTool({
                buildApprovalRequest: vi.fn(async () => ({ reason: 'needs approval' })),
            })
        );
        updateBuiltInToolLogByCallIdMock.mockImplementation(
            async (_callId: string, patch: { status?: string }) => {
                if (patch.status === 'rejected') {
                    throw new Error('database is locked');
                }
            }
        );
        const builtInToolService = await loadBuiltInToolService();

        const result = await executeBuiltInTool(builtInToolService, {
            requestToolApproval: vi.fn(async () => false),
        });

        expect(result?.isError).toBe(true);
    });

    it('user gets the approved run even when the approved state cannot be saved', async () => {
        registryGetMock.mockReturnValue(
            createRegistryTool({
                buildApprovalRequest: vi.fn(async () => ({ reason: 'needs approval' })),
            })
        );
        updateBuiltInToolLogByCallIdMock.mockImplementation(
            async (_callId: string, patch: { status?: string }) => {
                if (patch.status === 'approved') {
                    throw new Error('database is locked');
                }
            }
        );
        const builtInToolService = await loadBuiltInToolService();

        const result = await executeBuiltInTool(builtInToolService, {
            requestToolApproval: vi.fn(async () => true),
        });

        expect(result?.isError).toBe(false);
    });

    it('user gets the tool result when the final log update fails', async () => {
        updateBuiltInToolLogByCallIdMock.mockRejectedValue(new Error('database is locked'));
        const builtInToolService = await loadBuiltInToolService();

        const result = await executeBuiltInTool(builtInToolService);

        expect(result).toMatchObject({ result: 'alpha', isError: false });
    });

    it('user gets the cancellation reported when the cancelled state cannot be saved', async () => {
        registryGetMock.mockReturnValue(
            createRegistryTool({
                execute: vi.fn(async () => {
                    throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                }),
            })
        );
        updateBuiltInToolLogByCallIdMock.mockRejectedValue(new Error('database is locked'));
        const builtInToolService = await loadBuiltInToolService();

        await expect(executeBuiltInTool(builtInToolService)).rejects.toMatchObject({
            code: AiErrorCode.REQUEST_CANCELLED,
        });
    });
});
