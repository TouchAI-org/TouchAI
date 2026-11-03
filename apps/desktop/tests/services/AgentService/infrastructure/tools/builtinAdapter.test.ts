import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolEvent } from '@/services/AgentService/contracts/tooling';
import type { ToolCallContext } from '@/services/AgentService/infrastructure/tools';
import { executeBuiltinTool } from '@/services/AgentService/infrastructure/tools/builtinAdapter';

const mocks = vi.hoisted(() => ({ builtinExecuteTool: vi.fn() }));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: { executeTool: mocks.builtinExecuteTool },
}));

function createContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
    return {
        toolCall: { id: 'call-1', name: 'builtin__bash', arguments: '{}' },
        iteration: 0,
        currentModel: {} as unknown as ModelWithProvider,
        hasExecutedBuiltInTool: () => false,
        sessionId: null,
        toolCallMessageId: null,
        emitToolEvent: () => {},
        ...overrides,
    };
}

describe('user runs a built-in tool call', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('user sees the tool run with the signal, arguments and callbacks the request supplied', async () => {
        const controller = new AbortController();
        const events: ToolEvent[] = [];
        const requestToolApproval = vi.fn().mockResolvedValue(true);
        const requestUserQuestions = vi.fn().mockResolvedValue([]);
        const captured: { options?: Record<string, unknown> } = {};
        mocks.builtinExecuteTool.mockImplementation(async (options: Record<string, unknown>) => {
            captured.options = options;
            (options.emitToolEvent as (event: ToolEvent) => void)({
                type: 'call_end',
                callId: 'call-1',
                result: 'ok',
                isError: false,
                durationMs: 3,
                finalStatus: 'completed',
            });
            return {
                builtInToolId: 'bash',
                result: 'ok',
                isError: false,
                toolLogId: 7,
                toolLogKind: 'builtin',
                controlSignal: { type: 'upgrade_model', restartCurrentRequest: false },
            };
        });

        const outcome = await executeBuiltinTool({
            context: createContext({
                signal: controller.signal,
                emitToolEvent: (event) => events.push(event),
                requestToolApproval,
                requestUserQuestions,
            }),
            toolArgs: { command: 'ls' },
            requestedTimeoutMs: 4000,
        });

        expect(captured.options).toMatchObject({
            toolArgs: { command: 'ls' },
            requestedTimeoutMs: 4000,
            signal: controller.signal,
            requestToolApproval,
            requestUserQuestions,
        });
        expect(events).toEqual([
            expect.objectContaining({ type: 'call_end', callId: 'call-1', result: 'ok' }),
        ]);
        expect(outcome).toMatchObject({
            builtInToolId: 'bash',
            result: 'ok',
            isError: false,
            toolLogId: 7,
            controlSignal: { type: 'upgrade_model' },
        });
    });

    it('user sees a non-built-in tool reported as unhandled', async () => {
        mocks.builtinExecuteTool.mockResolvedValue(null);

        const outcome = await executeBuiltinTool({
            context: createContext({
                toolCall: { id: 'call-2', name: 'mcp__1__search', arguments: '{}' },
            }),
            toolArgs: {},
        });

        expect(outcome).toBeNull();
    });
});
