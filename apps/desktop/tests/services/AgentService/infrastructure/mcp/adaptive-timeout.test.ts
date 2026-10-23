import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { MCP_TIMEOUT_GUARD_GRACE_MS } from '@/services/AgentService/infrastructure/mcp/utils';
import { TOOL_TIMEOUT_MAX_MS } from '@/utils/timeouts';

const { callToolMock, findEnabledMcpServersMock, findEnabledMcpToolsByServerIdMock } = vi.hoisted(
    () => ({
        callToolMock: vi.fn(),
        findEnabledMcpServersMock: vi.fn(async (): Promise<unknown[]> => []),
        findEnabledMcpToolsByServerIdMock: vi.fn(async (): Promise<unknown[]> => []),
    })
);

vi.mock('@database', () => ({ db: {} }));
vi.mock('@database/queries', () => ({
    findEnabledMcpServers: findEnabledMcpServersMock,
    findEnabledMcpToolsByServerId: findEnabledMcpToolsByServerIdMock,
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

const RESOLVED = { serverId: 1, originalName: 'search', toolTimeout: 30000 };

function never<T>(): Promise<T> {
    return new Promise<T>(() => undefined);
}

describe('user lets the model choose how long an MCP tool may run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        setLocale('zh-CN');
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    async function manager() {
        const { McpManager } =
            await import('@/services/AgentService/infrastructure/mcp/McpManager');
        return new McpManager();
    }

    it('user sees the server timeout used when the model asks for no change', async () => {
        callToolMock.mockReturnValue(never());
        const mcpManager = await manager();

        const pending = mcpManager.executeTool('mcp__1__search', {}, { resolved: RESOLVED });
        const settled = vi.fn();
        void pending.then(settled, settled);

        // The local guard fires one grace window after the effective deadline.
        const guardDeadline = RESOLVED.toolTimeout + MCP_TIMEOUT_GUARD_GRACE_MS;
        await vi.advanceTimersByTimeAsync(guardDeadline - 1);
        expect(settled).not.toHaveBeenCalled();

        const assertion = expect(pending).rejects.toThrow(`${RESOLVED.toolTimeout}ms`);
        await vi.advanceTimersByTimeAsync(1);
        await assertion;
    });

    it('user sees a shorter timeout end the call at exactly the requested deadline', async () => {
        callToolMock.mockReturnValue(never());
        const mcpManager = await manager();

        const pending = mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved: RESOLVED,
                requestedTimeoutMs: 5000,
            }
        );
        const settled = vi.fn();
        void pending.then(settled, settled);

        await vi.advanceTimersByTimeAsync(5000 + MCP_TIMEOUT_GUARD_GRACE_MS - 1);
        expect(settled).not.toHaveBeenCalled();

        const assertion = expect(pending).rejects.toThrow('5000ms');
        await vi.advanceTimersByTimeAsync(1);
        await assertion;
    });

    it('user never sees a model-requested timeout exceed the server ceiling', async () => {
        callToolMock.mockReturnValue(never());
        const mcpManager = await manager();

        const pending = mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved: RESOLVED,
                requestedTimeoutMs: TOOL_TIMEOUT_MAX_MS * 10,
            }
        );
        const settled = vi.fn();
        void pending.then(settled, settled);

        // The server configuration is a hard ceiling: the model may only tighten it.
        const guardDeadline = RESOLVED.toolTimeout + MCP_TIMEOUT_GUARD_GRACE_MS;
        await vi.advanceTimersByTimeAsync(guardDeadline - 1);
        expect(settled).not.toHaveBeenCalled();

        const assertion = expect(pending).rejects.toThrow(`${RESOLVED.toolTimeout}ms`);
        await vi.advanceTimersByTimeAsync(1);
        await assertion;

        expect(callToolMock).toHaveBeenCalledWith(1, 'search', {}, RESOLVED.toolTimeout);
    });

    it('user sees a below-minimum request ignored instead of cutting the call short', async () => {
        callToolMock.mockReturnValue(never());
        const mcpManager = await manager();

        const pending = mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved: RESOLVED,
                requestedTimeoutMs: -1,
            }
        );
        const settled = vi.fn();
        void pending.then(settled, settled);

        // A suggestion below the 1s floor must not shorten the call to 1s; the
        // configured timeout (RESOLVED.toolTimeout) stays in effect.
        const guardDeadline = RESOLVED.toolTimeout + MCP_TIMEOUT_GUARD_GRACE_MS;
        await vi.advanceTimersByTimeAsync(guardDeadline - 1);
        expect(settled).not.toHaveBeenCalled();

        const assertion = expect(pending).rejects.toThrow(`${RESOLVED.toolTimeout}ms`);
        await vi.advanceTimersByTimeAsync(1);
        await assertion;

        expect(callToolMock).toHaveBeenCalledWith(1, 'search', {}, RESOLVED.toolTimeout);
    });

    it('user sees the effective timeout passed to the server so the call can be cancelled', async () => {
        callToolMock.mockResolvedValue(SUCCESS_RESPONSE);
        const mcpManager = await manager();

        await mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved: RESOLVED,
                requestedTimeoutMs: 5000,
            }
        );

        expect(callToolMock).toHaveBeenCalledWith(1, 'search', {}, 5000);
    });

    it('user sees the server timeout passed when the model asks for no change', async () => {
        callToolMock.mockResolvedValue(SUCCESS_RESPONSE);
        const mcpManager = await manager();

        await mcpManager.executeTool('mcp__1__search', {}, { resolved: RESOLVED });

        expect(callToolMock).toHaveBeenCalledWith(1, 'search', {}, RESOLVED.toolTimeout);
    });

    it('user gets the tool result when it arrives before the deadline', async () => {
        callToolMock.mockResolvedValue(SUCCESS_RESPONSE);
        const mcpManager = await manager();

        await expect(
            mcpManager.executeTool(
                'mcp__1__search',
                {},
                {
                    resolved: RESOLVED,
                    requestedTimeoutMs: 5000,
                }
            )
        ).resolves.toMatchObject({ isError: false });
    });

    it.each([0, -1])(
        'user sees a timeout of %i treated as disabled and kept away from the native boundary',
        async (toolTimeout) => {
            callToolMock.mockResolvedValue(SUCCESS_RESPONSE);
            const mcpManager = await manager();

            await expect(
                mcpManager.executeTool(
                    'mcp__1__search',
                    {},
                    {
                        resolved: { ...RESOLVED, toolTimeout },
                    }
                )
            ).resolves.toMatchObject({ isError: false });

            expect(callToolMock).toHaveBeenCalledWith(1, 'search', {}, undefined);
        }
    );

    it('user sees no model timeout honored when the server disables timeouts', async () => {
        callToolMock.mockResolvedValue(SUCCESS_RESPONSE);
        const mcpManager = await manager();

        await mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved: { ...RESOLVED, toolTimeout: 0 },
                requestedTimeoutMs: TOOL_TIMEOUT_MAX_MS * 10,
            }
        );

        expect(callToolMock).toHaveBeenCalledWith(1, 'search', {}, undefined);
    });

    it('user reads the timeout failure in their own language', async () => {
        callToolMock.mockRejectedValue(new Error('Tool execution timed out (5000ms)'));
        const mcpManager = await manager();

        await expect(
            mcpManager.executeTool(
                'mcp__1__search',
                {},
                {
                    resolved: RESOLVED,
                    requestedTimeoutMs: 5000,
                }
            )
        ).rejects.toThrow('工具执行超时（5000ms）');
    });

    it('user sees an out-of-range timeout reported as a configuration error', async () => {
        callToolMock.mockResolvedValue(SUCCESS_RESPONSE);
        const mcpManager = await manager();

        await expect(
            mcpManager.executeTool(
                'mcp__1__search',
                {},
                {
                    resolved: { ...RESOLVED, toolTimeout: 1e20 },
                }
            )
        ).rejects.toThrow('服务器工具超时配置无效');

        expect(callToolMock).not.toHaveBeenCalled();
    });

    it('user is not cut off early by the local guard for a very long timeout', async () => {
        // 2^31 ms overflows setTimeout: a naive timer would reject almost immediately.
        callToolMock.mockReturnValue(never());
        const mcpManager = await manager();

        const pending = mcpManager.executeTool(
            'mcp__1__search',
            {},
            {
                resolved: { ...RESOLVED, toolTimeout: 2_147_483_648 },
            }
        );
        const settled = vi.fn();
        void pending.then(settled, settled);

        await vi.advanceTimersByTimeAsync(2_147_483_647);
        expect(settled).not.toHaveBeenCalled();
    });
});

describe('user sees each MCP tool advertise its own timeout ceiling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        findEnabledMcpToolsByServerIdMock.mockResolvedValue([
            {
                name: 'search',
                description: 'search',
                input_schema: JSON.stringify({ type: 'object', properties: {} }),
            },
        ]);
    });

    function serverEntity(toolTimeout: number) {
        return {
            id: 1,
            name: 'srv',
            transport_type: 'stdio',
            command: null,
            args: null,
            env: null,
            cwd: null,
            url: null,
            headers: null,
            enabled: 1,
            tool_timeout: toolTimeout,
            version: null,
            last_error: null,
            last_connected_at: null,
            created_at: '',
            updated_at: '',
        };
    }

    async function ceilingFor(toolTimeout: number): Promise<number | undefined> {
        findEnabledMcpServersMock.mockResolvedValue([serverEntity(toolTimeout)]);

        const { McpManager } =
            await import('@/services/AgentService/infrastructure/mcp/McpManager');
        const mcpManager = new McpManager();
        mcpManager.setStatusFromEvent(1, 'connected');

        const definitions = await mcpManager.getEnabledToolDefinitions();
        return definitions[0]?.adaptiveTimeoutCeilingMs;
    }

    it('user sees the server timeout advertised as the ceiling', async () => {
        await expect(ceilingFor(30000)).resolves.toBe(30000);
    });

    it('user sees no timeout hint when the server disables timeouts', async () => {
        await expect(ceilingFor(0)).resolves.toBeUndefined();
    });

    it('user sees no timeout hint when the configured timeout leaves no valid range', async () => {
        // 500ms < 1s minimum: advertising [1s, 500ms] would be an invalid schema.
        await expect(ceilingFor(500)).resolves.toBeUndefined();
    });
});
