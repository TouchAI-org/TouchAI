import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { setLocale } from '@/i18n';
import { useMcpConnection } from '@/composables/useMcpConnection';
import type { McpServerEntity } from '@/database/types';
import { mcpManager } from '@/services/AgentService/infrastructure/mcp';
import { useMcpStore } from '@/stores/mcp';

vi.mock('@database/queries', () => ({
    findAllMcpServers: vi.fn(async () => []),
    findMcpToolsByServerId: vi.fn(async () => []),
}));

vi.mock('@services/EventService', () => ({
    AppEvent: { MCP_STATUS: 'mcp-status' },
    eventService: { on: vi.fn(async () => undefined) },
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: {
        connectServer: vi.fn(),
        disconnectServer: vi.fn(),
        refreshAllServerStatuses: vi.fn(),
        setStatusFromEvent: vi.fn(),
    },
}));

describe('useMcpConnection i18n', () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        setLocale('zh-CN');
        vi.clearAllMocks();
    });

    function createServer(overrides: Partial<McpServerEntity> = {}): McpServerEntity {
        return {
            id: 1,
            name: 'Local MCP',
            transport_type: 'stdio',
            command: 'node',
            args: null,
            env: null,
            cwd: null,
            url: null,
            headers: null,
            enabled: 1,
            tool_timeout: 30000,
            version: null,
            last_error: null,
            last_connected_at: null,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            ...overrides,
        };
    }

    function addServer(server: McpServerEntity = createServer()) {
        const store = useMcpStore();
        store.servers = [server];
        store.setServerStatus(server.id, 'disconnected');
        return store;
    }

    it('returns translated setup errors outside component templates', async () => {
        setLocale('en-US');

        const connection = useMcpConnection(ref(404));
        const result = await connection.handleConnect();

        expect(result).toEqual({
            success: false,
            error: 'Server does not exist',
        });
    });

    it('returns keyed connection timeout errors outside component templates', async () => {
        vi.useFakeTimers();
        setLocale('en-US');
        addServer();
        vi.mocked(mcpManager.connectServer).mockResolvedValue(undefined);

        const connection = useMcpConnection(ref(1));
        const resultPromise = connection.handleConnect();

        await vi.advanceTimersByTimeAsync(15000);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'Connection timed out',
        });

        vi.useRealTimers();
    });

    it('returns keyed disconnect timeout errors outside component templates', async () => {
        vi.useFakeTimers();
        setLocale('en-US');
        addServer();
        vi.mocked(mcpManager.disconnectServer).mockResolvedValue(undefined);

        const connection = useMcpConnection(ref(1));
        const resultPromise = connection.handleDisconnect();

        await vi.advanceTimersByTimeAsync(5000);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'Disconnect timed out',
        });

        vi.useRealTimers();
    });

    it('composes keyed reconnect errors with the localized inner failure', async () => {
        vi.useFakeTimers();
        setLocale('en-US');
        addServer();
        vi.mocked(mcpManager.disconnectServer).mockResolvedValue(undefined);

        const connection = useMcpConnection(ref(1));
        const resultPromise = connection.handleReconnect();

        await vi.advanceTimersByTimeAsync(5000);

        await expect(resultPromise).resolves.toEqual({
            success: false,
            error: 'Disconnect failed: Disconnect timed out',
        });

        vi.useRealTimers();
    });
});
