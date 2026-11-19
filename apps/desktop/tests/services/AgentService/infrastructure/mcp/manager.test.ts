import { createMcpHostFixture } from '@tests/utils/mcpHost';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

describe('given saved MCP servers and native connections', () => {
    it('user connects and retains disabled tools while newly discovered tools become available', async () => {
        const input = createMcpHostFixture();
        input.database.exec(
            `INSERT INTO mcp_tools (server_id, name, input_schema, enabled) VALUES (1, 'read_file', '{}', 0)`
        );
        mockTauriCommand('mcp_list_tools', [
            { name: 'read_file', input_schema: { type: 'object' } },
            { name: 'write_file', input_schema: { type: 'object' } },
        ]);
        mockTauriCommand('mcp_get_client_status', {
            server_id: 1,
            status: 'connected',
            version: '1.4.0',
        });
        await input.connections.connect(1);
        expect(
            input.database.prepare('SELECT name, enabled FROM mcp_tools ORDER BY name').all()
        ).toEqual([
            { name: 'read_file', enabled: 0 },
            { name: 'write_file', enabled: 1 },
        ]);
        expect(input.database.prepare('SELECT version, last_error FROM mcp_servers').get()).toEqual(
            { version: '1.4.0', last_error: null }
        );
        expect((await input.tools.snapshot()).declarations.map((tool) => tool.name)).toEqual([
            'mcp__1__write_file',
        ]);
    });

    it('user receives the native failure and a saved error then can reconnect successfully', async () => {
        const input = createMcpHostFixture();
        mockTauriCommand('mcp_connect_server', () => {
            throw new Error('spawn node ENOENT');
        });
        await expect(input.connections.connect(1)).rejects.toThrow('spawn node ENOENT');
        expect(input.connections.getStatus(1)).toMatchObject({
            status: 'error',
            error: 'spawn node ENOENT',
        });
        expect(input.database.prepare('SELECT last_error FROM mcp_servers').get()).toEqual({
            last_error: 'spawn node ENOENT',
        });
        expect((await input.tools.snapshot()).declarations).toEqual([]);
        mockTauriCommand('mcp_connect_server', undefined);
        await input.connections.connect(1);
        expect(input.connections.getStatus(1)).toMatchObject({ status: 'connected', error: null });
        expect(input.database.prepare('SELECT last_error FROM mcp_servers').get()).toEqual({
            last_error: null,
        });
    });

    it('user sees only tools from established connections with a readable fallback description', async () => {
        const input = createMcpHostFixture();
        expect((await input.tools.snapshot()).declarations).toEqual([]);
        mockTauriCommand('mcp_list_tools', [
            { name: 'read_file', input_schema: { type: 'object' } },
        ]);
        await input.connections.connect(1);
        expect((await input.tools.snapshot()).declarations).toEqual([
            expect.objectContaining({
                name: 'mcp__1__read_file',
                description: expect.stringContaining('read_file'),
                adaptiveTimeoutCeilingMs: 30000,
            }),
        ]);
    });

    it('user receives tool result text and its error flag through the controlled pipeline', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        mockTauriCommand('mcp_call_tool', {
            success: true,
            is_error: true,
            content: [{ type: 'text', text: 'permission denied' }],
        });
        expect(
            await (
                await input.tools.snapshot()
            ).execute(
                { id: 'call', name: 'mcp__1__read_file', arguments: '{"path":"README.md"}' },
                { iteration: 1 }
            )
        ).toMatchObject({ result: 'permission denied', isError: true });
        expect(getTauriInvokeCalls('mcp_call_tool').map(({ payload }) => payload)).toEqual([
            {
                serverId: 1,
                toolName: 'read_file',
                arguments: { path: 'README.md' },
                timeoutMs: 30000,
            },
        ]);
    });

    it('user cannot invoke malformed, missing, disabled or disconnected tool names', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        input.database.exec('UPDATE mcp_servers SET enabled = 0');
        const snapshot = await input.tools.snapshot();
        for (const name of [
            'read_file',
            'mcp__99__read_file',
            'mcp__1__missing',
            'mcp__1__read_file',
        ]) {
            expect(
                await snapshot.execute({ id: name, name, arguments: '{}' }, { iteration: 1 })
            ).toMatchObject({ isError: true, sideEffect: 'none', failureCode: 'tool_unavailable' });
        }
        expect(getTauriInvokeCalls('mcp_call_tool')).toEqual([]);
    });

    it('user cancels before an effect and no request reaches the native server', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        const signal = new AbortController();
        signal.abort();
        expect(
            await (
                await input.tools.snapshot()
            ).execute(
                { id: 'call', name: 'mcp__1__read_file', arguments: '{}' },
                { iteration: 1, signal: signal.signal }
            )
        ).toMatchObject({ isError: true, failureCode: 'request_cancelled', sideEffect: 'none' });
        expect(getTauriInvokeCalls('mcp_call_tool')).toEqual([]);
    });

    it('user refreshes native status and disconnects with the persisted error cleared', async () => {
        const input = createMcpHostFixture();
        await input.connections.connect(1);
        mockTauriCommand('mcp_get_all_client_statuses', [
            { server_id: 1, status: 'error', error: 'crashed' },
        ]);
        expect(await input.connections.refresh()).toEqual([
            { serverId: 1, status: 'error', error: 'crashed' },
        ]);
        expect((await input.tools.snapshot()).declarations).toEqual([]);
        await input.connections.disconnect(1);
        expect(input.connections.getStatus(1)).toMatchObject({
            status: 'disconnected',
            error: null,
        });
        expect(input.database.prepare('SELECT last_error FROM mcp_servers').get()).toEqual({
            last_error: null,
        });
    });
});
