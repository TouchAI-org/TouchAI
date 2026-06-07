import type { ModelWithProvider } from '@database/queries/models';
import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { builtInToolService } from '@/services/BuiltInToolService/service';

const {
    createBuiltInToolLogMock,
    findBuiltInToolByToolIdMock,
    findEnabledBuiltInToolsMock,
    touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallIdMock,
} = vi.hoisted(() => ({
    createBuiltInToolLogMock: vi.fn(),
    findBuiltInToolByToolIdMock: vi.fn(),
    findEnabledBuiltInToolsMock: vi.fn(),
    touchBuiltInToolLastUsedMock: vi.fn(),
    updateBuiltInToolLogByCallIdMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createBuiltInToolLog: createBuiltInToolLogMock,
    findBuiltInToolByToolId: findBuiltInToolByToolIdMock,
    findEnabledBuiltInTools: findEnabledBuiltInToolsMock,
    touchBuiltInToolLastUsed: touchBuiltInToolLastUsedMock,
    updateBuiltInToolLogByCallId: updateBuiltInToolLogByCallIdMock,
}));

const currentModel = {
    id: 1,
    model_id: 'gpt-4o',
    name: 'GPT-4o',
    provider_id: 1,
    provider_name: 'OpenAI',
} as ModelWithProvider;

function createBrowserActRow() {
    return {
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
    };
}

describe('BuiltInToolService browser execution safety', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        createBuiltInToolLogMock.mockResolvedValue({ id: 11 });
        updateBuiltInToolLogByCallIdMock.mockResolvedValue(undefined);
        touchBuiltInToolLastUsedMock.mockResolvedValue(undefined);
        findBuiltInToolByToolIdMock.mockResolvedValue(createBrowserActRow());
        findEnabledBuiltInToolsMock.mockResolvedValue([
            { tool_id: 'browser_session' },
            { tool_id: 'browser_observe' },
            { tool_id: 'browser_act' },
        ]);
    });

    it('fails closed for missing browser_act operation without approval or native action', async () => {
        const emitToolEvent = vi.fn();
        const requestToolApproval = vi.fn();
        mockTauriCommand('browser_act', { ok: true, action: 'click' });

        const result = await builtInToolService.executeTool({
            toolCall: {
                id: 'tool-call-1',
                name: 'builtin__browser_act',
                arguments: '{}',
            },
            toolArgs: { ref: 'submit-button', navigationToken: 'obs-1' },
            iteration: 1,
            currentModel,
            hasExecutedBuiltInTool: vi.fn(() => false),
            sessionId: 1,
            toolCallMessageId: 2,
            requestToolApproval,
            emitToolEvent,
        });

        expect(result).toMatchObject({
            builtInToolId: 'browser_act',
            isError: true,
        });
        expect(result?.result).toContain('Missing required browser_act operation');
        expect(requestToolApproval).not.toHaveBeenCalled();
        expect(getLastTauriInvokeCall('browser_act')).toBeUndefined();
        expect(emitToolEvent).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'approval_required' })
        );
    });
});
