import { routeQueriesTo } from '@tests/database/sqliteHarness';
import { createMcpHostFixture } from '@tests/utils/mcpHost';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

describe('given one main-owned MCP connection lifetime', () => {
    it('user sees connecting while native admission waits and connected after it settles', async () => {
        const input = createMcpHostFixture();
        const pending = Promise.withResolvers<void>();
        mockTauriCommand('mcp_connect_server', () => pending.promise);
        const connect = input.connections.connect(1);
        await expect.poll(() => input.connections.getStatus(1).status).toBe('connecting');
        pending.resolve();
        await connect;
        expect(input.connections.getStatus(1).status).toBe('connected');
    });

    it('user starts with enabled servers connected as background while one failure does not block the rest', async () => {
        const input = createMcpHostFixture();
        input.database
            .exec(`INSERT INTO mcp_servers (id, name, transport_type, command, enabled) VALUES
            (2, 'Other', 'stdio', 'node', 1), (3, 'Disabled', 'stdio', 'node', 0)`);
        mockTauriCommand('mcp_connect_server', (payload) => {
            if ((payload as { config: { id: number } }).config.id === 1)
                throw new Error('first fails');
        });
        await input.connections.autoConnect();
        expect(input.connections.getStatus(1).status).toBe('error');
        expect(input.connections.getStatus(2).status).toBe('connected');
        expect(getTauriInvokeCalls('mcp_connect_server').map(({ payload }) => payload)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    config: expect.objectContaining({ id: 1 }),
                    connectionOrigin: 'background',
                }),
                expect.objectContaining({
                    config: expect.objectContaining({ id: 2 }),
                    connectionOrigin: 'background',
                }),
            ])
        );
        expect(getTauriInvokeCalls('mcp_connect_server')).toHaveLength(2);
    });

    it('user manually connects with saved arguments and environment using the user origin', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        expect(getTauriInvokeCalls('mcp_connect_server').map(({ payload }) => payload)).toEqual([
            expect.objectContaining({
                connectionOrigin: 'user',
                config: expect.objectContaining({
                    id: 1,
                    command: 'node',
                    args: ['--verbose'],
                    env: { MODE: 'fixture' },
                }),
            }),
        ]);
    });

    it('user starts no connection for an empty enabled catalog and a failed catalog read remains observable', async () => {
        const input = createMcpHostFixture({ enabled: 0 });
        await input.connections.autoConnect();
        expect(getTauriInvokeCalls('mcp_connect_server')).toEqual([]);
        routeQueriesTo(input.database, {
            beforeQuery: () => {
                throw new Error('fixture database locked');
            },
        });
        await expect(input.connections.autoConnect()).rejects.toMatchObject({
            cause: new Error('fixture database locked'),
        });
    });

    it('user retains the original connection failure when saving its diagnostic also fails', async () => {
        const input = createMcpHostFixture();
        input.database.exec(`CREATE TEMP TRIGGER refuse_error BEFORE UPDATE ON mcp_servers
            BEGIN SELECT RAISE(ABORT, 'fixture storage refused'); END;`);
        mockTauriCommand('mcp_connect_server', () => {
            throw new Error('spawn ENOENT');
        });
        await expect(input.connections.connect(1)).rejects.toThrow('spawn ENOENT');
        expect(input.connections.getStatus(1)).toMatchObject({
            status: 'error',
            error: 'spawn ENOENT',
        });
    });

    it('user retains a working connection when its optional version probe fails', async () => {
        const input = createMcpHostFixture();
        mockTauriCommand('mcp_get_client_status', () => {
            throw new Error('status unavailable');
        });
        await input.connections.connect(1);
        expect(input.connections.getStatus(1).status).toBe('connected');
        expect((await input.tools.snapshot()).declarations.map((tool) => tool.name)).toEqual([
            'mcp__1__read_file',
        ]);
        expect(input.database.prepare('SELECT version FROM mcp_servers').get()).toEqual({
            version: null,
        });
    });

    it('user retains the committed catalog atomically when refreshing tools cannot be saved', async () => {
        const input = createMcpHostFixture();
        input.database
            .exec(`INSERT INTO mcp_tools (server_id, name, input_schema, enabled) VALUES (1, 'old_read', '{"type":"object"}', 1);
            CREATE TEMP TRIGGER refuse_catalog BEFORE INSERT ON mcp_tools
            BEGIN SELECT RAISE(ABORT, 'fixture catalog refused'); END;`);
        await input.connections.connect(1);
        expect(input.connections.getStatus(1).status).toBe('connected');
        expect(input.database.prepare('SELECT name FROM mcp_tools').all()).toEqual([
            { name: 'old_read' },
        ]);
    });

    it('user retains tool text when malformed returned image bytes cannot become an attachment', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        mockTauriCommand('mcp_call_tool', {
            success: true,
            is_error: false,
            content: [
                { type: 'text', text: 'completed report' },
                { type: 'image', mime_type: 'image/png', data: '!!!invalid-base64' },
            ],
        });
        const outcome = await (
            await input.tools.snapshot()
        ).execute({ id: 'call', name: 'mcp__1__read_file', arguments: '{}' }, { iteration: 1 });
        expect(outcome).toMatchObject({ isError: false, sideEffect: 'completed' });
        expect(outcome.result).toContain('completed report');
        expect(outcome.attachments).toBeUndefined();
        expect(getTauriInvokeCalls('mcp_call_tool')).toHaveLength(1);
    });

    it('user cannot publish ambiguous tools when a native server advertises duplicate names', async () => {
        const input = createMcpHostFixture();
        mockTauriCommand('mcp_list_tools', [
            { name: 'read_file', input_schema: { type: 'object' } },
            { name: 'read_file', input_schema: { type: 'object' } },
        ]);
        await expect(input.connections.connect(1)).rejects.toThrow(
            'Duplicate tool name: mcp__1__read_file'
        );
        expect((await input.tools.snapshot()).declarations).toEqual([]);
        expect(getTauriInvokeCalls('mcp_call_tool')).toEqual([]);
    });

    it('user receives native disconnect failure and may retry instead of receiving a false success', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        mockTauriCommand('mcp_disconnect_server', () => {
            throw new Error('still running');
        });
        await expect(input.connections.disconnect(1)).rejects.toThrow('still running');
        mockTauriCommand('mcp_disconnect_server', undefined);
        await input.connections.disconnect(1);
        expect(input.connections.getStatus(1).status).toBe('disconnected');
    });

    it('user retains known status when a native refresh fails then can refresh again', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        mockTauriCommand('mcp_get_all_client_statuses', () => {
            throw new Error('bridge down');
        });
        await expect(input.connections.refresh()).rejects.toThrow('bridge down');
        expect(input.connections.getStatus(1).status).toBe('connected');
        mockTauriCommand('mcp_get_all_client_statuses', [{ server_id: 1, status: 'disconnected' }]);
        await input.connections.refresh();
        expect(input.connections.getStatus(1).status).toBe('disconnected');
    });

    it('user finishes local cleanup after a native deadline and late rejection cannot revive status', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        vi.useFakeTimers();
        const pending = Promise.withResolvers<void>();
        mockTauriCommand('mcp_disconnect_server', () => pending.promise);
        const closed = input.connections.dispose();
        const failure = expect(closed).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(5000);
        await failure;
        pending.reject(new Error('bridge closed'));
        await Promise.resolve();
        await Promise.resolve();
        expect(input.connections.getStatus(1).status).toBe('disconnected');
        expect(await input.tools.snapshot().catch(() => null)).toBeNull();
    });
});
