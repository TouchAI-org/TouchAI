import type { ModelWithProvider } from '@database/queries/models';
import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import { builtInToolService } from '@/services/BuiltInToolService/service';

const {
    createBuiltInToolLogMock,
    findBuiltInToolByToolIdMock,
    findEnabledBuiltInToolsMock,
    readEffectiveSettingValueMock,
    touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByIdMock,
} = vi.hoisted(() => ({
    createBuiltInToolLogMock: vi.fn(),
    findBuiltInToolByToolIdMock: vi.fn(),
    findEnabledBuiltInToolsMock: vi.fn(),
    readEffectiveSettingValueMock: vi.fn(),
    touchBuiltInToolLastUsedMock: vi.fn(),
    updateBuiltInToolLogByIdMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createBuiltInToolLog: createBuiltInToolLogMock,
    findBuiltInToolByToolId: findBuiltInToolByToolIdMock,
    findEnabledBuiltInTools: findEnabledBuiltInToolsMock,
    touchBuiltInToolLastUsed: touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogById: updateBuiltInToolLogByIdMock,
}));

vi.mock('@/services/BuiltInToolService/settingsReader', () => ({
    readEffectiveSettingValue: readEffectiveSettingValueMock,
}));

const currentModel = {
    id: 1,
    model_id: 'gpt-4o',
    name: 'GPT-4o',
    provider_id: 1,
    provider_name: 'OpenAI',
} as ModelWithProvider;

function createBrowserRow() {
    return {
        id: 21,
        tool_id: 'browser',
        display_name: 'Browser',
        description: null,
        enabled: 1,
        risk_level: 'medium',
        config_json: null,
        last_used_at: null,
        created_at: '2026-05-24T00:00:00.000Z',
        updated_at: '2026-05-24T00:00:00.000Z',
    };
}

describe('user runs a browser tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createBuiltInToolLogMock.mockResolvedValue({ id: 11 });
        updateBuiltInToolLogByIdMock.mockResolvedValue(undefined);
        touchBuiltInToolLastUsedMock.mockResolvedValue(undefined);
        findBuiltInToolByToolIdMock.mockResolvedValue(createBrowserRow());
        findEnabledBuiltInToolsMock.mockResolvedValue([{ tool_id: 'browser' }]);
        readEffectiveSettingValueMock.mockResolvedValue(null);
    });

    it('user sees a missing browser operation refused without approval or browser access', async () => {
        const emitToolEvent = vi.fn();
        const requestToolApproval = vi.fn();
        mockTauriCommand('browser_act', { ok: true, action: 'click' });

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'tool-call-1',
                name: 'builtin__browser',
                arguments: '{}',
            },
            toolArgs: { ref: 'submit-button', navigationToken: 'obs-1' },
            iteration: 1,
            currentModel,

            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval,
            emitToolEvent,
        });

        expect(result).toMatchObject({
            builtInToolId: 'browser',
            isError: true,
        });
        expect(result?.result).toContain('Missing required browser operation');
        expect(requestToolApproval).not.toHaveBeenCalled();
        expect(getLastTauriInvokeCall('browser_act')).toBeUndefined();
        expect(emitToolEvent).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'approval_required' })
        );
    });

    it('user approves a browser action once and it runs without a second question', async () => {
        mockTauriCommand('browser_navigate', { ok: true });
        const emitToolEvent = vi.fn();
        const requestToolApproval = vi.fn(async () => true);
        const requestUserQuestions = vi.fn();

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'tool-call-2',
                name: 'builtin__browser',
                arguments: '{}',
            },
            toolArgs: {
                operation: 'navigate',
                url: 'https://example.test/docs',
                description: '打开官方文档',
            },
            iteration: 1,
            currentModel,
            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval,
            requestUserQuestions,
            emitToolEvent,
        });

        expect(result).toMatchObject({
            builtInToolId: 'browser',
            isError: false,
        });
        expect(requestToolApproval).toHaveBeenCalledTimes(1);
        expect(requestUserQuestions).not.toHaveBeenCalled();
        expect(getLastTauriInvokeCall('browser_navigate')?.payload).toEqual({
            request: { url: 'https://example.test/docs' },
        });
        expect(
            emitToolEvent.mock.calls.filter(([event]) => event.type === 'approval_required')
        ).toHaveLength(1);
    });

    it('user rejects a browser action once and it never reaches the native browser', async () => {
        mockTauriCommand('browser_navigate', { ok: true });
        const requestToolApproval = vi.fn(async () => false);
        const requestUserQuestions = vi.fn();

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'tool-call-3',
                name: 'builtin__browser',
                arguments: '{}',
            },
            toolArgs: {
                operation: 'navigate',
                url: 'https://example.test/private',
                description: '打开私有页面',
            },
            iteration: 1,
            currentModel,
            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval,
            requestUserQuestions,
            emitToolEvent: vi.fn(),
        });

        expect(result).toMatchObject({ isError: true });
        expect(requestToolApproval).toHaveBeenCalledTimes(1);
        expect(requestUserQuestions).not.toHaveBeenCalled();
        expect(getLastTauriInvokeCall('browser_navigate')).toBeUndefined();
    });

    it('user sees an approved browser action stop when cancelled while approval is persisted', async () => {
        mockTauriCommand('browser_navigate', { ok: true });
        const controller = new AbortController();
        updateBuiltInToolLogByIdMock.mockImplementation(
            async (_id: number, patch: { status?: string }) => {
                if (patch.status === 'approved') {
                    controller.abort();
                }
            }
        );

        await expect(
            builtInToolService.executeTool({
                toolCall: {
                    id: 'tool-call-3',
                    name: 'builtin__browser',
                    arguments: '{}',
                },
                toolArgs: {
                    operation: 'navigate',
                    url: 'https://example.test/cancelled',
                    description: '打开已取消页面',
                },
                iteration: 1,
                currentModel,
                signal: controller.signal,
                sessionId: 1,
                toolCallMessageId: 2,
                requestToolApproval: vi.fn(async () => true),
                emitToolEvent: vi.fn(),
            })
        ).rejects.toMatchObject({ code: AiErrorCode.REQUEST_CANCELLED });

        expect(getLastTauriInvokeCall('browser_navigate')).toBeUndefined();
        expect(updateBuiltInToolLogByIdMock).toHaveBeenCalledWith(
            11,
            expect.objectContaining({ status: 'cancelled' })
        );
    });

    it('user sees an approved browser action stop when cancelled during browser settings loading', async () => {
        mockTauriCommand('browser_navigate', { ok: true });
        const controller = new AbortController();
        let settingReads = 0;
        readEffectiveSettingValueMock.mockImplementation(async () => {
            settingReads += 1;
            if (settingReads === 2) {
                controller.abort();
            }
            return null;
        });

        await expect(
            builtInToolService.executeTool({
                toolCall: {
                    id: 'tool-call-4',
                    name: 'builtin__browser',
                    arguments: '{}',
                },
                toolArgs: {
                    operation: 'navigate',
                    url: 'https://example.test/cancelled-during-settings',
                    description: '打开取消时正在读取设置的页面',
                },
                iteration: 1,
                currentModel,
                signal: controller.signal,
                sessionId: 1,
                toolCallMessageId: 2,
                requestToolApproval: vi.fn(async () => true),
                emitToolEvent: vi.fn(),
            })
        ).rejects.toMatchObject({ code: AiErrorCode.REQUEST_CANCELLED });

        expect(getLastTauriInvokeCall('browser_navigate')).toBeUndefined();
    });

    it('user sees no approval when browser settings already allow the action', async () => {
        readEffectiveSettingValueMock.mockResolvedValue(
            JSON.stringify({
                permissions: {
                    navigate: 'allow',
                },
            })
        );
        mockTauriCommand('browser_navigate', { ok: true });
        const requestToolApproval = vi.fn(async () => true);
        const requestUserQuestions = vi.fn();

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'tool-call-4',
                name: 'builtin__browser',
                arguments: '{}',
            },
            toolArgs: {
                operation: 'navigate',
                url: 'https://example.test/allowed',
                description: '打开允许的页面',
            },
            iteration: 1,
            currentModel,
            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval,
            requestUserQuestions,
            emitToolEvent: vi.fn(),
        });

        expect(result).toMatchObject({ isError: false });
        expect(requestToolApproval).not.toHaveBeenCalled();
        expect(requestUserQuestions).not.toHaveBeenCalled();
        expect(getLastTauriInvokeCall('browser_navigate')?.payload).toEqual({
            request: { url: 'https://example.test/allowed' },
        });
    });

    it('user chooses an existing browser session once without a separate approval', async () => {
        mockTauriCommand('browser_discover_existing', [
            {
                id: '127.0.0.1:9222',
                label: 'Chrome - example.test',
                endpoint: 'http://127.0.0.1:9222',
                browserName: 'Google Chrome',
                currentUrl: 'https://example.test',
                title: 'Example',
                tabs: [],
            },
        ]);
        mockTauriCommand('browser_connect_existing', {
            status: { status: 'connected', managed: false },
            session: { label: 'Chrome - example.test' },
        });
        const requestToolApproval = vi.fn(async () => true);
        const requestUserQuestions = vi.fn(async () => [
            {
                questionIndex: 0,
                selectedLabels: ['1. Chrome - example.test'],
                skipped: false,
            },
        ]);

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'tool-call-5',
                name: 'builtin__browser',
                arguments: '{}',
            },
            toolArgs: {
                operation: 'connect_existing',
                description: '连接已有浏览器',
            },
            iteration: 1,
            currentModel,
            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval,
            requestUserQuestions,
            emitToolEvent: vi.fn(),
        });

        expect(result).toMatchObject({ builtInToolId: 'browser', isError: false });
        expect(requestToolApproval).not.toHaveBeenCalled();
        expect(requestUserQuestions).toHaveBeenCalledTimes(1);
        expect(getLastTauriInvokeCall('browser_connect_existing')?.payload).toEqual({
            request: { endpoint: 'http://127.0.0.1:9222' },
        });
    });

    it('user cancels the existing-session chooser and gets a cancelled call instead of an error result', async () => {
        mockTauriCommand('browser_discover_existing', [
            {
                id: '127.0.0.1:9222',
                label: 'Chrome - example.test',
                endpoint: 'http://127.0.0.1:9222',
                browserName: 'Google Chrome',
                currentUrl: 'https://example.test',
                title: 'Example',
                tabs: [],
            },
        ]);
        mockTauriCommand('browser_connect_existing', {
            status: { status: 'connected', managed: false },
        });
        const controller = new AbortController();
        const emitToolEvent = vi.fn();

        await expect(
            builtInToolService.executeTool({
                toolCall: {
                    id: 'tool-call-6',
                    name: 'builtin__browser',
                    arguments: '{}',
                },
                toolArgs: {
                    operation: 'connect_existing',
                    description: '连接已有浏览器',
                },
                iteration: 1,
                currentModel,
                signal: controller.signal,
                sessionId: 1,
                toolCallMessageId: 2,
                requestToolApproval: vi.fn(async () => true),
                requestUserQuestions: vi.fn(async () => {
                    controller.abort();
                    return null;
                }),
                emitToolEvent,
            })
        ).rejects.toMatchObject({ code: AiErrorCode.REQUEST_CANCELLED });

        expect(getLastTauriInvokeCall('browser_connect_existing')).toBeUndefined();
        expect(updateBuiltInToolLogByIdMock).toHaveBeenCalledWith(
            11,
            expect.objectContaining({ status: 'cancelled' })
        );
        expect(emitToolEvent).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'call_end', finalStatus: 'error' })
        );
    });
});
