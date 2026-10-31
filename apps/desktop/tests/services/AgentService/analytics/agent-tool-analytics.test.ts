/*
 * Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { AiRequestExecutor } from '@/services/AgentService/execution';
import type { AttemptCheckpoint } from '@/services/AgentService/execution/executor';
import { createAgentRequestAnalytics } from '@/services/AgentService/infrastructure/analytics';

import { getTauriInvokeCalls, mockTauriCommand } from '../../../utils/tauri';

const providerMock = vi.hoisted(() => ({
    stream: vi.fn(),
    classifyError: vi.fn(),
}));

const { createMcpToolLogMock, updateMcpToolLogByCallIdMock } = vi.hoisted(() => ({
    createMcpToolLogMock: vi.fn(),
    updateMcpToolLogByCallIdMock: vi.fn(),
}));

const { builtInExecuteToolMock, resolveToolDefinitionsMock, createProviderForModelMock } =
    vi.hoisted(() => ({
        builtInExecuteToolMock: vi.fn(),
        resolveToolDefinitionsMock: vi.fn(async () => []),
        createProviderForModelMock: vi.fn(),
    }));

vi.mock('@database/queries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database/queries')>()),
    createMcpToolLog: createMcpToolLogMock,
    updateMcpToolLogByCallId: updateMcpToolLogByCallIdMock,
    findMcpServerById: async () => ({
        id: 1,
        name: 'controlled-server',
        enabled: 1,
        tool_timeout: 30_000,
    }),
    findMcpToolByServerIdAndName: async () => ({ name: 'search', enabled: 1 }),
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: {
        executeTool: builtInExecuteToolMock,
    },
}));

vi.mock('@/services/AgentService/catalog', () => ({
    createProviderForModel: createProviderForModelMock,
    createProviderInstance: vi.fn(),
    resolveToolDefinitions: resolveToolDefinitionsMock,
    getModel: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/providers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/AgentService/infrastructure/providers')>()),
    createProviderFromRegistry: vi.fn(),
}));

function createCheckpoint(): AttemptCheckpoint {
    return {
        activeModel: {
            id: 1,
            created_at: '',
            updated_at: '',
            provider_id: 12,
            model_id: 'mimo-v2.5',
            name: 'mimo-v2.5',
            is_default: 1,
            last_used_at: null,
            attachment: 0,
            modalities: null,
            open_weights: 0,
            reasoning: 0,
            reasoning_options: null,
            release_date: null,
            temperature: 1,
            tool_call: 1,
            knowledge: null,
            context_limit: null,
            output_limit: null,
            is_custom_metadata: 0,
            upstream_metadata: null,
            provider_name: 'Xiaomi MiMo',
            provider_driver: 'mimo',
            api_endpoint: 'https://example.test/v1',
            api_key: 'ta_live_test',
            provider_config_json: null,
            provider_enabled: 1,
            provider_logo: '',
        },
        messages: [{ role: 'user', content: 'hello' }],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        modelLanguageContext: { locale: 'zh-CN', label: 'Simplified Chinese' },
        executedBuiltInToolIds: [],
    };
}

function persisterStub() {
    return {
        persistOutputProgress: vi.fn().mockResolvedValue(undefined),
        getSessionId: vi.fn(() => 1),
        persistToolCallMessage: vi.fn().mockResolvedValue(1),
        persistToolResult: vi.fn().mockResolvedValue(undefined),
        persistCheckpoint: vi.fn().mockResolvedValue(undefined),
    };
}

interface TrackedEvent {
    eventName: string;
    attributes: Record<string, unknown>;
}

function toolCompletedEvents(): TrackedEvent[] {
    return getTauriInvokeCalls('analytics_track')
        .map((call) => {
            const payload = call.payload as {
                request: { eventName: string; attributes: Record<string, unknown> };
            };
            return payload.request;
        })
        .filter((tracked) => tracked.eventName === 'agent.tool_completed');
}

function enableAnalytics() {
    mockTauriCommand('analytics_begin_operation', () => ({
        operationId: 'op-tool-1',
        enabled: true,
        consentEpoch: 3,
    }));
    mockTauriCommand('analytics_complete_operation', () => undefined);
    mockTauriCommand('analytics_track', () => ({ status: 'persisted', eventId: 'event-1' }));
}

describe('user runs a tool call', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        enableAnalytics();
        providerMock.stream.mockReset();
        createProviderForModelMock.mockReturnValue(providerMock);
        resolveToolDefinitionsMock.mockResolvedValue([]);
        createMcpToolLogMock.mockResolvedValue({ id: 23 });
        updateMcpToolLogByCallIdMock.mockResolvedValue(undefined);
        vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    });

    afterEach(() => vi.restoreAllMocks());

    function streamOneToolCall(name: string) {
        return async function* () {
            yield { content: 'Checking', done: false };
            yield {
                content: '',
                done: true,
                finishReason: 'tool_calls',
                toolCalls: [{ id: 'call-1', name, arguments: '{}' }],
            };
        };
    }

    async function runTool(name: string, signal?: AbortSignal) {
        providerMock.stream
            .mockImplementationOnce(streamOneToolCall(name))
            .mockImplementationOnce(async function* () {
                yield { content: 'Done', done: true };
            });

        const analytics = createAgentRequestAnalytics();
        const outcome = await new AiRequestExecutor().runAttempt({
            startCheckpoint: createCheckpoint(),
            persister: persisterStub() as never,
            analytics,
            signal,
        });
        analytics.complete({
            result:
                outcome.type === 'completed'
                    ? 'success'
                    : outcome.error.is(AiErrorCode.REQUEST_CANCELLED)
                      ? 'cancelled'
                      : 'failure',
            retryCount: 0,
            modelSwitchCount: outcome.modelSwitchCount,
            persistenceResult: 'not_applicable',
            calls: outcome.calls,
            usageReportedCalls: outcome.usageReportedCalls,
        });
        await vi.waitFor(() =>
            expect(getTauriInvokeCalls('analytics_complete_operation')).toHaveLength(1)
        );
        return outcome;
    }

    it('user gets a command category when a built-in command tool finishes', async () => {
        builtInExecuteToolMock.mockResolvedValue({
            toolCall: { id: 'call-1', name: 'builtin__bash', arguments: '{}' },
            builtInToolId: 'bash',
            result: 'ok',
            isError: false,
            toolLogId: 5,
            toolLogKind: 'builtin',
        });

        const outcome = await runTool('builtin__bash');
        expect(outcome.type).toBe('completed');

        await vi.waitFor(() => {
            expect(toolCompletedEvents()).toHaveLength(1);
        });
        expect(toolCompletedEvents()[0]!.attributes).toMatchObject({
            tool_category: 'command',
            result: 'success',
        });
        // The tool id is a fresh analysis id, never the provider call id.
        expect(toolCompletedEvents()[0]!.attributes.tool_id).not.toBe('call-1');
    });

    it('user gets an mcp category when an mcp tool finishes', async () => {
        builtInExecuteToolMock.mockResolvedValue(null);
        mockTauriCommand('mcp_call_tool', () => ({
            success: true,
            content: [{ type: 'text', text: 'done' }],
            is_error: false,
        }));

        const outcome = await runTool('mcp__1__search');
        expect(outcome.type).toBe('completed');

        await vi.waitFor(() => {
            expect(toolCompletedEvents()).toHaveLength(1);
        });
        expect(toolCompletedEvents()[0]!.attributes).toMatchObject({
            tool_category: 'mcp',
            result: 'success',
        });
    });

    it('user gets a failure result when a built-in tool ends in error', async () => {
        builtInExecuteToolMock.mockResolvedValue({
            toolCall: { id: 'call-1', name: 'builtin__bash', arguments: '{}' },
            builtInToolId: 'bash',
            result: 'boom',
            isError: true,
            toolLogId: 5,
            toolLogKind: 'builtin',
        });

        await runTool('builtin__bash');

        await vi.waitFor(() => {
            expect(toolCompletedEvents()).toHaveLength(1);
        });
        expect(toolCompletedEvents()[0]!.attributes.result).toBe('failure');
    });

    it('user gets a cancelled result when the request is cancelled during the tool', async () => {
        builtInExecuteToolMock.mockRejectedValue(new AiError(AiErrorCode.REQUEST_CANCELLED));

        await runTool('builtin__bash');

        await vi.waitFor(() => {
            expect(toolCompletedEvents()).toHaveLength(1);
        });
        expect(toolCompletedEvents()[0]!.attributes.result).toBe('cancelled');
    });

    it('user gets a failed MCP tool result without cancellation when the server reports its own cancelled work', async () => {
        builtInExecuteToolMock.mockResolvedValue(null);
        mockTauriCommand('mcp_call_tool', () => {
            throw new Error('controlled server cancelled its own job');
        });

        const outcome = await runTool('mcp__1__search');

        expect(outcome.type).toBe('completed');
        expect(toolCompletedEvents()).toHaveLength(1);
        expect(toolCompletedEvents()[0]!.attributes).toMatchObject({
            tool_category: 'mcp',
            result: 'failure',
        });
    });

    it('user gets cancelled MCP telemetry and a cancellation outcome when aborting a real MCP wait', async () => {
        builtInExecuteToolMock.mockResolvedValue(null);
        const controller = new AbortController();
        let nativeStarted!: () => void;
        const started = new Promise<void>((resolve) => {
            nativeStarted = resolve;
        });
        let finishNative!: (value: unknown) => void;
        mockTauriCommand('mcp_call_tool', () => {
            nativeStarted();
            return new Promise((resolve) => {
                finishNative = resolve;
            });
        });

        const pending = runTool('mcp__1__search', controller.signal);
        await started;
        controller.abort();
        const outcome = await pending;
        finishNative({ success: true, content: [], is_error: false });

        expect(outcome.type).toBe('failed');
        if (outcome.type !== 'failed') throw new Error('expected cancellation');
        expect(outcome.error.code).toBe(AiErrorCode.REQUEST_CANCELLED);
        await vi.waitFor(() => expect(toolCompletedEvents()).toHaveLength(1));
        expect(toolCompletedEvents()[0]!.attributes).toMatchObject({
            tool_category: 'mcp',
            result: 'cancelled',
        });
        expect(JSON.stringify(toolCompletedEvents())).not.toContain('mcp__1__search');
    });
});
