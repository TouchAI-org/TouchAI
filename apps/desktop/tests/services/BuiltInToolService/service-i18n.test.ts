import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { builtInToolService } from '@/services/BuiltInToolService/service';

const {
    createBuiltInToolLogMock,
    fakeTool,
    findBuiltInToolByToolIdMock,
    touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallIdMock,
} = vi.hoisted(() => {
    const fakeTool = {
        id: 'setting',
        displayName: 'Setting',
        parseConfig: vi.fn(() => ({})),
        prepareForExecution: vi.fn(async (args) => args),
        sanitizeLogInput: vi.fn((args) => args),
        buildConversationSemanticWithContext: vi.fn(() => ({
            action: 'process',
            target: 'Setting',
        })),
        buildApprovalRequest: vi.fn(() => null),
        execute: vi.fn(),
    };

    return {
        createBuiltInToolLogMock: vi.fn(),
        fakeTool,
        findBuiltInToolByToolIdMock: vi.fn(),
        touchBuiltInToolLastUsedMock: vi.fn(),
        updateBuiltInToolLogByCallIdMock: vi.fn(),
    };
});

vi.mock('@database/queries', () => ({
    createBuiltInToolLog: createBuiltInToolLogMock,
    findBuiltInToolByToolId: findBuiltInToolByToolIdMock,
    findEnabledBuiltInTools: vi.fn(async () => []),
    touchBuiltInToolLastUsed: touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallId: updateBuiltInToolLogByCallIdMock,
}));

vi.mock('@/services/BuiltInToolService/registry', () => ({
    builtInToolRegistry: {
        get: vi.fn(() => fakeTool),
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
        updateBuiltInToolLogByCallIdMock.mockResolvedValue(undefined);
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
