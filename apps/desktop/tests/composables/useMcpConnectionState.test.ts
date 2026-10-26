import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useMcpConnection } from '@/composables/useMcpConnection';
import type { McpServerEntity } from '@/database/types';
import { setLocale } from '@/i18n';
import { mcpManager } from '@/services/AgentService/infrastructure/mcp';
import { useMcpStore } from '@/stores/mcp';

/**
 * The connect, disconnect and reconnect buttons are the only way to control an MCP server from
 * settings. Each one waits for the backend to report a new state, so a wrong wait either reports
 * success before the server is up or leaves the button spinning until it times out.
 */
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
        last_connected_at: null,
        last_error: null,
        created_at: '',
        updated_at: '',
        ...overrides,
    };
}

function seedStore(status = 'disconnected') {
    const store = useMcpStore();
    store.servers = [createServer()];
    store.setServerStatus(1, status as never);
    return store;
}

beforeEach(() => {
    setActivePinia(createPinia());
    setLocale('en-US');
    vi.clearAllMocks();
    vi.mocked(mcpManager.connectServer).mockResolvedValue(undefined as never);
    vi.mocked(mcpManager.disconnectServer).mockResolvedValue(undefined as never);
});

describe('user connects an MCP server from settings', () => {
    it('user gets the button marked busy while the connect is running', async () => {
        const store = seedStore();
        const connection = useMcpConnection(ref(1));

        const pending = connection.handleConnect();

        expect(connection.isConnecting.value).toBe(true);

        store.setServerStatus(1, 'connected');
        await expect(pending).resolves.toEqual({ success: true });
    });

    it('user gets success reported once the server reports connected', async () => {
        const store = seedStore();
        const connection = useMcpConnection(ref(1));

        const pending = connection.handleConnect();
        store.setServerStatus(1, 'connected');

        await expect(pending).resolves.toEqual({ success: true });
        expect(connection.isConnecting.value).toBe(false);
    });

    it('user gets the backend reason shown when the server reports an error', async () => {
        const store = seedStore();
        store.setServerError(1, 'spawn ENOENT');
        const connection = useMcpConnection(ref(1));

        const pending = connection.handleConnect();
        store.setServerStatus(1, 'error');

        // Without the reason the user cannot tell a bad command from a missing binary.
        await expect(pending).resolves.toEqual({ success: false, error: 'spawn ENOENT' });
    });

    it('user gets a clear message when the server was deleted meanwhile', async () => {
        const store = useMcpStore();
        store.servers = [];
        const connection = useMcpConnection(ref(1));

        const outcome = await connection.handleConnect();

        expect(outcome.success).toBe(false);
        expect(outcome.error).toBeTruthy();
        expect(connection.isConnecting.value).toBe(false);
    });

    it('user gets no second connect while one is still running', async () => {
        const store = seedStore();
        const connection = useMcpConnection(ref(1));

        const first = connection.handleConnect();
        const second = await connection.handleConnect();

        // Two connects for one server race each other in the backend.
        expect(second).toEqual({ success: false });
        expect(mcpManager.connectServer).toHaveBeenCalledTimes(1);

        store.setServerStatus(1, 'connected');
        await first;
    });

    it('user gets the backend failure reported when the request itself throws', async () => {
        seedStore();
        vi.mocked(mcpManager.connectServer).mockImplementation(() => {
            throw new Error('bridge unavailable');
        });
        const connection = useMcpConnection(ref(1));

        const outcome = await connection.handleConnect();

        expect(outcome).toEqual({ success: false, error: 'bridge unavailable' });
        expect(connection.isConnecting.value).toBe(false);
    });
});

describe('user disconnects an MCP server', () => {
    it('user gets success reported once the server reports disconnected', async () => {
        const store = seedStore('connected');
        const connection = useMcpConnection(ref(1));

        const pending = connection.handleDisconnect();
        expect(connection.isDisconnecting.value).toBe(true);

        store.setServerStatus(1, 'disconnected');

        await expect(pending).resolves.toEqual({ success: true });
        expect(connection.isDisconnecting.value).toBe(false);
    });

    it('user gets no second disconnect while one is still running', async () => {
        const store = seedStore('connected');
        const connection = useMcpConnection(ref(1));

        const first = connection.handleDisconnect();
        const second = await connection.handleDisconnect();

        expect(second).toEqual({ success: false });
        expect(mcpManager.disconnectServer).toHaveBeenCalledTimes(1);

        store.setServerStatus(1, 'disconnected');
        await first;
    });
});

describe('user reconnects an MCP server', () => {
    it('user gets no reconnect while a connect is already running', async () => {
        seedStore();
        const connection = useMcpConnection(ref(1));

        const connect = connection.handleConnect();
        const outcome = await connection.handleReconnect();

        // Reconnecting on top of a connect would fight the backend.
        expect(outcome).toEqual({ success: false });

        useMcpStore().setServerStatus(1, 'connected');
        await connect;
    });
});

describe('user sees which server is selected', () => {
    it('user gets the live status of the selected server', async () => {
        seedStore('connected');
        const connection = useMcpConnection(ref(1));

        expect(connection.status.value).toBe('connected');
    });

    it('user gets nothing shown for the placeholder selection', async () => {
        seedStore('connected');
        const connection = useMcpConnection(ref(-1));

        // -1 means "no server selected yet", which is not a disconnected server, and it must
        // not carry the previous server's error into the panel.
        expect(connection.status.value).toBe('disconnected');
    });

    it('user gets the status of the newly selected server', async () => {
        const store = useMcpStore();
        store.servers = [createServer({ id: 1 }), createServer({ id: 2 })];
        store.setServerStatus(1, 'disconnected');
        store.setServerStatus(2, 'error');
        const serverId = ref(1);
        const connection = useMcpConnection(serverId);

        serverId.value = 2;

        expect(connection.status.value).toBe('error');
    });

    it('user gets the pending waits cleaned up when the panel closes', async () => {
        seedStore();
        const connection = useMcpConnection(ref(1));

        const pending = connection.handleConnect();
        connection.cleanup();
        // The panel may also run its own cleanup on close, so a second pass must be harmless.
        connection.cleanup();

        // A cleaned-up wait must not resolve as if the server had connected.
        const outcome = await Promise.race([
            pending,
            new Promise((resolve) => setTimeout(() => resolve('still-waiting'), 50)),
        ]);
        expect(outcome).toBe('still-waiting');
    });
});
describe('user reconnects an MCP server that will not come back', () => {
    it('user gets the reconnect reported as failed when the old connection will not drop', async () => {
        const store = seedStore('connected');
        vi.useFakeTimers();
        try {
            const connection = useMcpConnection(ref(1));

            const pending = connection.handleReconnect();
            // The backend never reports disconnected, so the disconnect times out.
            await vi.advanceTimersByTimeAsync(5000);
            const outcome = await pending;

            // Reporting success here would tell the user the server is up when it is not.
            expect(outcome.success).toBe(false);
            expect(outcome.error).toBeTruthy();
            expect(connection.isReconnecting.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
        void store;
    });

    it('user gets the reconnect reported as failed when the new connection errors', async () => {
        const store = seedStore('connected');
        vi.useFakeTimers();
        try {
            const connection = useMcpConnection(ref(1));

            const pending = connection.handleReconnect();
            store.setServerStatus(1, 'disconnected');
            await vi.advanceTimersByTimeAsync(600);
            store.setServerError(1, 'handshake refused');
            store.setServerStatus(1, 'error');
            const outcome = await pending;

            expect(outcome.success).toBe(false);
            expect(outcome.error).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('user gets success once the old connection drops and the new one comes up', async () => {
        const store = seedStore('connected');
        vi.useFakeTimers();
        try {
            const connection = useMcpConnection(ref(1));

            const pending = connection.handleReconnect();
            store.setServerStatus(1, 'disconnected');
            await vi.advanceTimersByTimeAsync(600);
            store.setServerStatus(1, 'connected');
            const outcome = await pending;

            expect(outcome).toEqual({ success: true });
            expect(connection.isReconnecting.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('user disconnects an MCP server that will not drop', () => {
    it('user gets a timeout reported rather than waiting forever', async () => {
        seedStore('connected');
        vi.useFakeTimers();
        try {
            const connection = useMcpConnection(ref(1));

            const pending = connection.handleDisconnect();
            await vi.advanceTimersByTimeAsync(5000);
            const outcome = await pending;

            expect(outcome.success).toBe(false);
            expect(outcome.error).toBeTruthy();
            expect(connection.isDisconnecting.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('user connects an MCP server that never answers', () => {
    it('user gets a timeout reported rather than a stuck spinner', async () => {
        seedStore();
        vi.useFakeTimers();
        try {
            const connection = useMcpConnection(ref(1));

            const pending = connection.handleConnect();
            await vi.advanceTimersByTimeAsync(15000);
            const outcome = await pending;

            expect(outcome.success).toBe(false);
            expect(outcome.error).toBeTruthy();
            expect(connection.isConnecting.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
