import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_TIMEOUT_MAX_MS } from '@/utils/timeouts';

const { callToolMock } = vi.hoisted(() => ({ callToolMock: vi.fn() }));

vi.mock('@database', () => ({ db: {} }));
vi.mock('@database/queries', () => ({
    findEnabledMcpServers: vi.fn(async () => []),
    findEnabledMcpToolsByServerId: vi.fn(async () => []),
    findMcpServerById: vi.fn(),
    findMcpToolByServerIdAndName: vi.fn(),
    findMcpToolsByServerId: vi.fn(async () => []),
    updateMcpServer: vi.fn(),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { MCP_STATUS: 'mcp-status' },
    eventService: { emit: vi.fn() },
}));

vi.mock('@services/NativeService', () => ({
    mcp: { callTool: callToolMock },
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    base64ToUint8Array: vi.fn(),
    createPersistedAttachmentFromData: vi.fn(),
}));

const SUCCESS_RESPONSE = {
    success: true,
    content: [{ type: 'text', text: 'ok' }],
    is_error: false,
};

describe('McpManager.executeTool adaptive timeout', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function manager() {
        return import('@/services/AgentService/infrastructure/mcp/McpManager').then(
            ({ McpManager }) => new McpManager()
        );
    }

    const resolved = { serverId: 1, originalName: 'search', toolTimeout: 30000 };

    it('uses the server timeout when the model requests nothing', async () => {
        callToolMock.mockResolvedValue(SUCCESS_RESPONSE);
        const mcpManager = await manager();

        await expect(
            mcpManager.executeTool('mcp__1__search', {}, { resolved })
        ).resolves.toMatchObject({ isError: false });
    });

    it('applies a shorter model-requested timeout', async () => {
        callToolMock.mockReturnValue(new Promise(() => undefined));
        const mcpManager = await manager();

        const pending = mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved,
                requestedTimeoutMs: 5000,
            }
        );
        const assertion = expect(pending).rejects.toThrow('5000ms');

        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });

    it('caps a model-requested timeout at the shared maximum', async () => {
        callToolMock.mockReturnValue(new Promise(() => undefined));
        const mcpManager = await manager();

        const pending = mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved,
                requestedTimeoutMs: TOOL_TIMEOUT_MAX_MS * 10,
            }
        );
        const assertion = expect(pending).rejects.toThrow(`${TOOL_TIMEOUT_MAX_MS}ms`);

        await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_MAX_MS);
        await assertion;
    });

    it('falls back to the server timeout for an out-of-range low request', async () => {
        callToolMock.mockReturnValue(new Promise(() => undefined));
        const mcpManager = await manager();

        const pending = mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved,
                requestedTimeoutMs: -1,
            }
        );
        // -1 is clamped up to the 1s floor rather than falling back.
        const assertion = expect(pending).rejects.toThrow('1000ms');

        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });
});
