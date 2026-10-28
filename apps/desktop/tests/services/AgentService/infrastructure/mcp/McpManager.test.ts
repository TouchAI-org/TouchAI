// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { McpServerEntity } from '@database/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { McpManager } from '@/services/AgentService/infrastructure/mcp/McpManager';

/**
 * The MCP manager owns the connection state the settings page and the agent both read. A status
 * that is wrong in the cache makes the UI lie, and a tool definition built for a disconnected
 * server makes the model call something that cannot answer.
 */
const mocks = vi.hoisted(() => ({
    findEnabledMcpServers: vi.fn(),
    findEnabledMcpToolsByServerId: vi.fn(),
    findMcpServerById: vi.fn(),
    findMcpToolByServerIdAndName: vi.fn(),
    findMcpToolsByServerId: vi.fn(),
    updateMcpServer: vi.fn(),
    connectServer: vi.fn(),
    disconnectServer: vi.fn(),
    disconnectAll: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    getServerStatus: vi.fn(),
    getAllServerStatuses: vi.fn(),
    emit: vi.fn(),
    extractMcpToolAttachments: vi.fn(),
}));

vi.mock('@database', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database')>()),
    db: {
        transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
            callback({
                delete: () => ({ where: () => ({ run: async () => undefined }) }),
                insert: () => ({ values: () => ({ run: async () => undefined }) }),
            }),
    },
}));

vi.mock('@database/queries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@database/queries')>()),
    findEnabledMcpServers: mocks.findEnabledMcpServers,
    findEnabledMcpToolsByServerId: mocks.findEnabledMcpToolsByServerId,
    findMcpServerById: mocks.findMcpServerById,
    findMcpToolByServerIdAndName: mocks.findMcpToolByServerIdAndName,
    findMcpToolsByServerId: mocks.findMcpToolsByServerId,
    updateMcpServer: mocks.updateMcpServer,
}));

vi.mock('@services/NativeService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@services/NativeService')>()),
    mcp: {
        connectServer: mocks.connectServer,
        disconnectServer: mocks.disconnectServer,
        disconnectAll: mocks.disconnectAll,
        listTools: mocks.listTools,
        callTool: mocks.callTool,
        getServerStatus: mocks.getServerStatus,
        getAllServerStatuses: mocks.getAllServerStatuses,
    },
}));

vi.mock('@services/EventService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@services/EventService')>()),
    eventService: { emit: mocks.emit },
}));

vi.mock('@/services/AgentService/infrastructure/mcp/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/services/AgentService/infrastructure/mcp/utils')>()),
    extractMcpToolAttachments: mocks.extractMcpToolAttachments,
}));

function server(overrides: Partial<McpServerEntity> = {}): McpServerEntity {
    return {
        id: 1,
        name: 'filesystem',
        transport_type: 'stdio',
        command: 'npx',
        args: '["-y","server"]',
        env: '{"TOKEN":"x"}',
        cwd: null,
        url: null,
        headers: null,
        enabled: 1,
        tool_timeout: 30,
        version: null,
        last_error: null,
        last_connected_at: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        ...overrides,
    };
}

beforeEach(() => {
    vi.resetAllMocks();
    mocks.updateMcpServer.mockResolvedValue(undefined);
    mocks.findMcpToolsByServerId.mockResolvedValue([]);
    mocks.findEnabledMcpToolsByServerId.mockResolvedValue([]);
    mocks.disconnectAll.mockResolvedValue(undefined);
    mocks.getServerStatus.mockImplementation(async () => ({ status: 'connected', version: null }));
    mocks.getAllServerStatuses.mockResolvedValue([]);
    // Connecting syncs the tool list, so it has to resolve by default.
    mocks.listTools.mockResolvedValue([]);
    mocks.extractMcpToolAttachments.mockResolvedValue(undefined);
});

describe('user sees a server connection state', () => {
    it('user gets a server reported disconnected before anything connects', () => {
        // The UI must not claim a connection it has not made.
        expect(new McpManager().getServerStatus(9)).toBe('disconnected');
    });

    it('user gets the connecting state visible while the connection is opening', async () => {
        let releaseConnect: () => void = () => undefined;
        mocks.connectServer.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    releaseConnect = resolve;
                })
        );
        const manager = new McpManager();

        const pending = manager.connectServer(server());

        expect(manager.getServerStatus(1)).toBe('connecting');
        releaseConnect();
        await pending;
    });

    it('user gets the connected state after a successful connect', async () => {
        const manager = new McpManager();

        await manager.connectServer(server());

        expect(manager.getServerStatus(1)).toBe('connected');
        expect(manager.getServerError(1)).toBeNull();
    });

    it('user gets the failure reason shown when a connect fails', async () => {
        mocks.connectServer.mockRejectedValue(new Error('spawn ENOENT'));
        const manager = new McpManager();

        await expect(manager.connectServer(server())).rejects.toThrow();

        // The user has to see why the server did not start, not just that it is red.
        expect(manager.getServerStatus(1)).toBe('error');
        expect(manager.getServerError(1)).toContain('spawn ENOENT');
    });

    it('user gets the error persisted so it survives a restart', async () => {
        mocks.connectServer.mockRejectedValue(new Error('spawn ENOENT'));
        const manager = new McpManager();

        await expect(manager.connectServer(server())).rejects.toThrow();

        expect(mocks.updateMcpServer).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ last_error: expect.stringContaining('spawn ENOENT') })
        );
    });

    it('user gets a cleared error after a later successful connect', async () => {
        const manager = new McpManager();
        manager.setStatusFromEvent(1, 'error', 'old failure');

        await manager.connectServer(server());

        expect(manager.getServerError(1)).toBeNull();
    });

    it('user gets the disconnected state after disconnecting', async () => {
        const manager = new McpManager();
        await manager.connectServer(server());

        await manager.disconnectServer(1);

        expect(manager.getServerStatus(1)).toBe('disconnected');
    });

    it('user gets a failed disconnect reported rather than swallowed', async () => {
        mocks.disconnectServer.mockRejectedValue(new Error('still running'));
        const manager = new McpManager();

        await expect(manager.disconnectServer(1)).rejects.toThrow('still running');
    });

    it('user gets the state from another window applied', () => {
        const manager = new McpManager();

        manager.setStatusFromEvent(3, 'error', 'bridge lost');

        expect(manager.getServerStatus(3)).toBe('error');
        expect(manager.getServerError(3)).toBe('bridge lost');
    });

    it('user gets the state refreshed from the backend', async () => {
        mocks.getServerStatus.mockResolvedValue({ status: 'connected', error: null });
        const manager = new McpManager();

        const status = await manager.refreshServerStatus(1);

        expect(status).toBe('connected');
        expect(manager.getServerStatus(1)).toBe('connected');
    });

    it('user gets a disconnected state when the refresh itself fails', async () => {
        mocks.getServerStatus.mockRejectedValue(new Error('bridge down'));
        const manager = new McpManager();

        // An unreachable backend must not leave the last known state looking healthy.
        await expect(manager.refreshServerStatus(1)).resolves.toBe('disconnected');
    });

    it('user gets every server status refreshed in one call', async () => {
        mocks.getAllServerStatuses.mockResolvedValue([
            { server_id: 1, status: 'connected', error: null },
            { server_id: 2, status: 'error', error: 'boom' },
        ]);
        const manager = new McpManager();

        await manager.refreshAllServerStatuses();

        expect(manager.getServerStatus(1)).toBe('connected');
        expect(manager.getServerStatus(2)).toBe('error');
        expect(manager.getServerError(2)).toBe('boom');
    });
});

describe('user starts the app with saved servers', () => {
    it('user gets every enabled server connected', async () => {
        mocks.findEnabledMcpServers.mockResolvedValue([server({ id: 1 }), server({ id: 2 })]);
        const manager = new McpManager();

        await manager.autoConnect();

        expect(mocks.connectServer).toHaveBeenCalledTimes(2);
    });

    it('user gets the remaining servers still connected when one fails', async () => {
        mocks.findEnabledMcpServers.mockResolvedValue([server({ id: 1 }), server({ id: 2 })]);
        mocks.connectServer
            .mockRejectedValueOnce(new Error('first fails'))
            .mockResolvedValueOnce(undefined);
        const manager = new McpManager();

        await manager.autoConnect();

        // One broken server must not stop the rest from starting.
        expect(mocks.connectServer).toHaveBeenCalledTimes(2);
        expect(manager.getServerStatus(2)).toBe('connected');
    });

    it('user gets no connection attempted when nothing is enabled', async () => {
        mocks.findEnabledMcpServers.mockResolvedValue([]);
        const manager = new McpManager();

        await manager.autoConnect();

        expect(mocks.connectServer).not.toHaveBeenCalled();
    });

    it('user gets the failure raised when the server list cannot be read', async () => {
        mocks.findEnabledMcpServers.mockRejectedValue(new Error('db locked'));
        const manager = new McpManager();

        await expect(manager.autoConnect()).rejects.toThrow('db locked');
    });
});

describe('user sends the tool definitions to the model', () => {
    it('user gets tools only from servers that are actually connected', async () => {
        mocks.findEnabledMcpServers.mockResolvedValue([server({ id: 1 }), server({ id: 2 })]);
        mocks.findEnabledMcpToolsByServerId.mockResolvedValue([
            { name: 'read_file', description: 'Read', input_schema: '{"type":"object"}' },
        ]);
        const manager = new McpManager();
        await manager.connectServer(server({ id: 1 }));

        const tools = await manager.getEnabledToolDefinitions();

        // Server 2 never connected, so its tools must not be offered to the model.
        expect(tools).toHaveLength(1);
        expect(tools[0]!.name).toBe('mcp__1__read_file');
    });

    it('user gets the tool name namespaced by its server', async () => {
        mocks.findEnabledMcpServers.mockResolvedValue([server({ id: 7 })]);
        mocks.findEnabledMcpToolsByServerId.mockResolvedValue([
            { name: 'query', description: 'Query', input_schema: '{"type":"object"}' },
        ]);
        const manager = new McpManager();
        await manager.connectServer(server({ id: 7 }));

        const tools = await manager.getEnabledToolDefinitions();

        // Two servers may both expose `query`; the namespace keeps them apart.
        expect(tools[0]!.name).toBe('mcp__7__query');
    });

    it('user gets a fallback description when the tool has none', async () => {
        mocks.findEnabledMcpServers.mockResolvedValue([server({ id: 1 })]);
        mocks.findEnabledMcpToolsByServerId.mockResolvedValue([
            { name: 'query', description: null, input_schema: '{"type":"object"}' },
        ]);
        const manager = new McpManager();
        await manager.connectServer(server({ id: 1 }));

        const tools = await manager.getEnabledToolDefinitions();

        expect(tools[0]!.description).toBeTruthy();
    });

    it('user gets no tools at all when the server list cannot be read', async () => {
        mocks.findEnabledMcpServers.mockRejectedValue(new Error('db locked'));
        const manager = new McpManager();

        // A failed read must degrade to "no tools", not break the whole request.
        await expect(manager.getEnabledToolDefinitions()).resolves.toEqual([]);
    });

    it('user gets the other servers kept when one server fails to list its tools', async () => {
        mocks.findEnabledMcpServers.mockResolvedValue([server({ id: 1 }), server({ id: 2 })]);
        mocks.findEnabledMcpToolsByServerId
            .mockRejectedValueOnce(new Error('bad schema'))
            .mockResolvedValueOnce([
                { name: 'ok', description: 'OK', input_schema: '{"type":"object"}' },
            ]);
        const manager = new McpManager();
        await manager.connectServer(server({ id: 1 }));
        await manager.connectServer(server({ id: 2 }));

        const tools = await manager.getEnabledToolDefinitions();

        expect(tools).toHaveLength(1);
        expect(tools[0]!.name).toBe('mcp__2__ok');
    });
});

describe('user calls a tool on a server', () => {
    it('user gets the tool result returned unchanged', async () => {
        const response = { content: [{ type: 'text', text: 'ok' }] };
        mocks.callTool.mockResolvedValue(response);
        const manager = new McpManager();

        await expect(manager.callTool(1, 'read_file', { path: 'a' })).resolves.toBe(response);
    });

    it('user gets a tool failure raised rather than turned into a result', async () => {
        mocks.callTool.mockRejectedValue(new Error('tool exploded'));
        const manager = new McpManager();

        // The caller decides how to report a failed call; swallowing it here hides it.
        await expect(manager.callTool(1, 'read_file', {})).rejects.toThrow('tool exploded');
    });

    it('user gets a listing failure raised as well', async () => {
        mocks.listTools.mockRejectedValue(new Error('server gone'));
        const manager = new McpManager();

        await expect(manager.listTools(1)).rejects.toThrow('server gone');
    });
});

describe('user keeps working when mcp bookkeeping fails', () => {
    it('user gets the original connection failure when the error cannot be saved', async () => {
        mocks.connectServer.mockRejectedValue(new Error('spawn ENOENT'));
        mocks.updateMcpServer.mockRejectedValue(new Error('database is locked'));
        const manager = new McpManager();

        // A bookkeeping failure must not replace the reason the server did not start.
        await expect(manager.connectServer(server())).rejects.toThrow('spawn ENOENT');
        expect(manager.getServerStatus(1)).toBe('error');
    });

    it('user gets a connected server when its version cannot be read', async () => {
        mocks.getServerStatus.mockRejectedValue(new Error('status unavailable'));
        const manager = new McpManager();

        await manager.connectServer(server());

        expect(manager.getServerStatus(1)).toBe('connected');
        expect(mocks.updateMcpServer).not.toHaveBeenCalledWith(
            1,
            expect.objectContaining({ version: expect.anything() })
        );
    });

    it('user gets a connected server when its tool list cannot be saved', async () => {
        const { db } = await import('@database');
        vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
        const manager = new McpManager();

        await manager.connectServer(server());

        expect(manager.getServerStatus(1)).toBe('connected');
    });

    it('user gets every status cleared after a normal disconnect', async () => {
        const manager = new McpManager();
        manager.setStatusFromEvent(1, 'connected', null);

        await manager.disconnectAll();

        expect(manager.getServerStatus(1)).toBe('disconnected');
    });

    it('user gets a disconnect timeout and the late success still clears state', async () => {
        vi.useFakeTimers();
        let releaseDisconnect: () => void = () => undefined;
        mocks.disconnectAll.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    releaseDisconnect = resolve;
                })
        );
        const manager = new McpManager();
        manager.setStatusFromEvent(1, 'connected', null);

        const pending = manager.disconnectAll(50);
        const expectation = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(50);
        await expectation;

        releaseDisconnect();
        await Promise.resolve();
        await Promise.resolve();

        expect(manager.getServerStatus(1)).toBe('disconnected');
        vi.useRealTimers();
    });

    it('user keeps the last known statuses when the backend refresh fails', async () => {
        mocks.getAllServerStatuses.mockRejectedValue(new Error('bridge down'));
        const manager = new McpManager();
        manager.setStatusFromEvent(1, 'connected', null);

        await expect(manager.refreshAllServerStatuses()).resolves.toBeUndefined();

        expect(manager.getServerStatus(1)).toBe('connected');
    });

    it('user gets a late disconnect rejection contained after the timeout', async () => {
        vi.useFakeTimers();
        let rejectDisconnect: (error: Error) => void = () => undefined;
        mocks.disconnectAll.mockImplementation(
            () =>
                new Promise<void>((_, reject) => {
                    rejectDisconnect = reject;
                })
        );
        const manager = new McpManager();

        const pending = manager.disconnectAll(50);
        const expectation = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(50);
        await expectation;

        rejectDisconnect(new Error('bridge closed'));
        await Promise.resolve();
        await Promise.resolve();

        expect(manager.getServerStatus(1)).toBe('disconnected');
        vi.useRealTimers();
    });

    it('user gets no tool resolved when the server no longer has it', async () => {
        mocks.findMcpServerById.mockResolvedValue(server());
        mocks.findMcpToolByServerIdAndName.mockResolvedValue(undefined);
        const manager = new McpManager();

        await expect(manager.resolveToolCall('mcp__1__missing')).resolves.toBeNull();
    });

    it('user gets no tool resolved when the lookup itself fails', async () => {
        mocks.findMcpServerById.mockRejectedValue(new Error('database is locked'));
        const manager = new McpManager();

        await expect(manager.resolveToolCall('mcp__1__read')).resolves.toBeNull();
    });

    it('user still gets the tool result when attachments cannot be extracted', async () => {
        mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
        mocks.extractMcpToolAttachments.mockRejectedValue(new Error('unsupported content'));
        const manager = new McpManager();

        const result = await manager.executeTool('read', {}, {
            resolved: { serverId: 1, originalName: 'read', toolTimeout: 30 },
        });

        expect(result.isError).toBeFalsy();
        expect(result.result).toContain('ok');
        expect(result.attachments).toBeUndefined();
    });
});
