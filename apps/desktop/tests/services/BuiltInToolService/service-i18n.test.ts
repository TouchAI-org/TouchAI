import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { builtInToolService } from '@/services/BuiltInToolService/service';

const {
    createBuiltInToolMock,
    createBuiltInToolLogMock,
    fakeTool,
    findAllBuiltInToolsMock,
    findBuiltInToolByToolIdMock,
    findEnabledBuiltInToolsMock,
    touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallIdMock,
} = vi.hoisted(() => {
    const fakeTool = {
        id: 'setting',
        displayName: 'Setting',
        description: 'Setting tool',
        inputSchema: { type: 'object', properties: {} },
        parseConfig: vi.fn(() => ({})),
        buildConversationSemanticWithContext: vi.fn(() => ({
            action: 'process',
            target: 'Setting',
        })),
        buildApprovalRequest: vi.fn(() => null),
        execute: vi.fn(),
    };

    return {
        createBuiltInToolMock: vi.fn(),
        createBuiltInToolLogMock: vi.fn(),
        fakeTool,
        findAllBuiltInToolsMock: vi.fn(),
        findBuiltInToolByToolIdMock: vi.fn(),
        findEnabledBuiltInToolsMock: vi.fn(),
        touchBuiltInToolLastUsedMock: vi.fn(),
        updateBuiltInToolLogByCallIdMock: vi.fn(),
    };
});

vi.mock('@database/queries', () => ({
    createBuiltInTool: createBuiltInToolMock,
    createBuiltInToolLog: createBuiltInToolLogMock,
    findAllBuiltInTools: findAllBuiltInToolsMock,
    findBuiltInToolByToolId: findBuiltInToolByToolIdMock,
    findEnabledBuiltInTools: findEnabledBuiltInToolsMock,
    touchBuiltInToolLastUsed: touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallId: updateBuiltInToolLogByCallIdMock,
}));

vi.mock('@/services/BuiltInToolService/registry', () => ({
    builtInToolRegistry: {
        list: vi.fn(() => [
            {
                ...fakeTool,
                id: 'setting',
                displayName: 'Setting',
                description: 'Setting description',
                defaultConfig: {},
            },
            {
                ...fakeTool,
                id: 'web_search',
                displayName: 'WebSearch',
                description: 'WebSearch description',
                defaultConfig: {},
            },
            {
                ...fakeTool,
                id: 'bash',
                displayName: 'Bash',
                description: 'Bash description',
                defaultConfig: {},
            },
        ]),
        get: vi.fn((toolId: string) =>
            ['setting', 'browser'].includes(toolId)
                ? {
                      ...fakeTool,
                      id: toolId,
                      displayName: toolId,
                      description: `${toolId} description`,
                  }
                : toolId === 'ask_user_question'
                  ? {
                        ...fakeTool,
                        id: toolId,
                        displayName: toolId,
                        description: `${toolId} description`,
                    }
                  : undefined
        ),
    },
}));

const currentModel = {
    id: 1,
    model_id: 'gpt-4o',
    name: 'GPT-4o',
    provider_id: 1,
    provider_name: 'OpenAI',
} as ModelWithProvider;

function createExecutionOptions(signal?: AbortSignal) {
    return {
        toolCall: {
            id: 'tool-call-1',
            name: 'builtin__setting',
            arguments: '{}',
        },
        toolArgs: {},
        iteration: 1,
        currentModel,
        hasExecutedBuiltInTool: vi.fn(() => false),
        signal,
        sessionId: 1,
        toolCallMessageId: 2,
        emitToolEvent: vi.fn(),
    };
}

describe('BuiltInToolService i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setLocale('zh-CN');
        findBuiltInToolByToolIdMock.mockResolvedValue({
            id: 1,
            tool_id: 'setting',
            display_name: 'Setting',
            description: null,
            enabled: 1,
            risk_level: 'medium',
            config_json: null,
            last_used_at: null,
            created_at: '2026-05-24T00:00:00.000Z',
            updated_at: '2026-05-24T00:00:00.000Z',
        });
        createBuiltInToolLogMock.mockResolvedValue({ id: 11 });
        createBuiltInToolMock.mockResolvedValue({ id: 12 });
        updateBuiltInToolLogByCallIdMock.mockResolvedValue(undefined);
        findAllBuiltInToolsMock.mockResolvedValue([]);
        findEnabledBuiltInToolsMock.mockResolvedValue([]);
    });

    it('syncs registered built-in tools into existing databases without overwriting existing rows', async () => {
        findAllBuiltInToolsMock.mockResolvedValueOnce([
            {
                id: 1,
                tool_id: 'setting',
                display_name: 'Setting',
                description: null,
                enabled: 0,
                risk_level: 'medium',
                config_json: null,
                last_used_at: null,
                created_at: '2026-05-24T00:00:00.000Z',
                updated_at: '2026-05-24T00:00:00.000Z',
            },
        ]);

        await builtInToolService.syncRegisteredTools();

        expect(createBuiltInToolMock).toHaveBeenCalledTimes(2);
        expect(createBuiltInToolMock).toHaveBeenCalledWith(
            expect.objectContaining({
                tool_id: 'web_search',
                display_name: 'WebSearch',
                enabled: 1,
                risk_level: 'low',
            })
        );
        expect(createBuiltInToolMock).toHaveBeenCalledWith(
            expect.objectContaining({
                tool_id: 'bash',
                display_name: 'Bash',
                enabled: 1,
                risk_level: 'high',
            })
        );
    });

    it('exposes only the consolidated browser tool to the model', async () => {
        findEnabledBuiltInToolsMock.mockResolvedValueOnce([
            { tool_id: 'browser' },
            { tool_id: 'setting' },
        ]);

        const definitions = await builtInToolService.getEnabledToolDefinitions();
        expect(definitions.map((definition) => definition.name).sort()).toEqual([
            'builtin__browser',
            'builtin__setting',
        ]);
    });

    it('exposes the ask-user built-in tool to the model when enabled', async () => {
        findEnabledBuiltInToolsMock.mockResolvedValueOnce([{ tool_id: 'ask_user_question' }]);

        const definitions = await builtInToolService.getEnabledToolDefinitions();

        expect(definitions).toHaveLength(1);
        expect(definitions[0]?.name).toBe('builtin__ask_user_question');
    });

    it('does not resolve unregistered partial browser tool calls', async () => {
        findBuiltInToolByToolIdMock.mockResolvedValueOnce({
            id: 21,
            tool_id: 'browser_act',
            display_name: 'BrowserAct',
            description: null,
            enabled: 1,
            risk_level: 'high',
            config_json: null,
            last_used_at: null,
            created_at: '2026-05-24T00:00:00.000Z',
            updated_at: '2026-05-24T00:00:00.000Z',
        });

        await expect(
            builtInToolService.resolveToolCall('builtin__browser_act')
        ).resolves.toBeNull();
    });

    it('localizes generic execution failures before storing tool output', async () => {
        fakeTool.execute.mockRejectedValueOnce(new Error('boom'));

        const result = await builtInToolService.executeTool(createExecutionOptions());

        expect(result).toMatchObject({
            result: '工具执行失败：boom',
            isError: true,
        });
        expect(updateBuiltInToolLogByCallIdMock).toHaveBeenLastCalledWith(
            'tool-call-1',
            expect.objectContaining({
                output: '工具执行失败：boom',
                error_message: 'boom',
                status: 'error',
            })
        );
    });

    it('localizes cancellation errors stored in built-in tool logs', async () => {
        const controller = new AbortController();
        fakeTool.execute.mockImplementationOnce(() => {
            controller.abort();
            throw new Error('cancelled by user');
        });

        await expect(
            builtInToolService.executeTool(createExecutionOptions(controller.signal))
        ).rejects.toThrow('请求已取消');

        expect(updateBuiltInToolLogByCallIdMock).toHaveBeenCalledWith(
            'tool-call-1',
            expect.objectContaining({
                status: 'cancelled',
                error_message: '请求已取消',
            })
        );
    });
});
