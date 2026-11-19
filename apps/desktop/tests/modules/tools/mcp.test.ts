import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls, interceptTauriInvoke, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpConnections, createTools, ToolExecutionError } from '@/modules/tools';

afterEach(() => {
    closeTestDatabases();
    vi.useRealTimers();
});

async function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO mcp_servers (id, name, transport_type, url, enabled, tool_timeout)
        VALUES (1, 'Fixture', 'http', 'https://fixture.invalid/mcp', 1, 12000);
        INSERT INTO mcp_tools (server_id, name, input_schema, enabled)
        VALUES (1, 'disabled', '{"type":"object","properties":{}}', 0);`);
    mockTauriCommand('mcp_list_tools', [
        {
            name: 'read',
            description: 'Read fixture',
            input_schema: { type: 'object', properties: { value: { type: 'string' } } },
        },
        { name: 'disabled', input_schema: { type: 'object', properties: {} } },
    ]);
    mockTauriCommand('mcp_get_client_status', { status: 'connected', version: 'fixture-version' });
    mockTauriCommand('mcp_call_tool', {
        success: true,
        is_error: false,
        content: [{ type: 'text', text: 'fixture result' }],
    });
    const resources: Uint8Array[] = [];
    const connections = createMcpConnections({
        messages: { t: (key) => key, tt: (text) => text },
        diagnostics: { debug: () => {}, error: () => {} },
        resources: {
            create: async (resource) => {
                resources.push(resource.data);
                return {
                    id: 'fixture-resource',
                    type: resource.type,
                    path: 'C:\\fixture\\result.png',
                    originPath: resource.originPath,
                    name: resource.name,
                };
            },
        },
    });
    await connections.connect(1, 'background');
    const tools = createTools({ registrations: [], mcp: connections, formatError: (code) => code });
    return { database, connections, tools, resources };
}

describe('given MCP catalogs feed the sole controlled tool registry', () => {
    it('user retains disabled choices and executes through the advertised schema and timeout binding', async () => {
        const { database, connections, tools } = await fixture();
        try {
            const snapshot = await tools.snapshot();
            expect(snapshot.declarations.map((tool) => tool.name)).toEqual(['mcp__1__read']);
            database.exec(`UPDATE mcp_servers SET tool_timeout = 600000 WHERE id = 1;
                UPDATE mcp_tools SET input_schema = '{"type":"object","properties":{"value":{"type":"number"}}}' WHERE name = 'read';`);
            const outcome = await snapshot.execute(
                { id: 'read', name: 'mcp__1__read', arguments: '{"value":"original"}' },
                { iteration: 0 }
            );
            expect(outcome).toMatchObject({ isError: false, result: 'fixture result' });
            expect(getTauriInvokeCalls('mcp_call_tool').map((call) => call.payload)).toEqual([
                {
                    serverId: 1,
                    toolName: 'read',
                    arguments: { value: 'original' },
                    timeoutMs: 12000,
                },
            ]);
            expect(
                database.prepare("SELECT enabled FROM mcp_tools WHERE name = 'disabled'").get()
            ).toEqual({ enabled: 0 });
        } finally {
            tools.dispose();
            await connections.dispose();
        }
    });

    it('user cannot send a captured call through a replacement connection', async () => {
        const { database, connections, tools } = await fixture();
        try {
            const snapshot = await tools.snapshot();
            database.exec(
                `UPDATE mcp_servers SET url = 'https://replacement.invalid/mcp' WHERE id = 1`
            );
            await connections.connect(1);
            const outcome = await snapshot
                .execute({ id: 'old', name: 'mcp__1__read', arguments: '{}' }, { iteration: 0 })
                .catch((error: unknown) => {
                    expect(error).toBeInstanceOf(ToolExecutionError);
                    return (error as ToolExecutionError).outcome;
                });
            expect(outcome).toMatchObject({ isError: true, sideEffect: 'none' });
            expect(getTauriInvokeCalls('mcp_call_tool')).toEqual([]);
        } finally {
            tools.dispose();
            await connections.dispose();
        }
    });

    it('user locally cancels an uncooperative remote effect without receiving late resources', async () => {
        const { connections, tools, resources } = await fixture();
        let admit!: () => void;
        let finish!: (value: unknown) => void;
        const admitted = new Promise<void>((resolve) => {
            admit = resolve;
        });
        mockTauriCommand('mcp_call_tool', () => {
            admit();
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
        try {
            const controller = new AbortController();
            const pending = (await tools.snapshot()).execute(
                { id: 'read', name: 'mcp__1__read', arguments: '{}' },
                { iteration: 0, signal: controller.signal }
            );
            await admitted;
            controller.abort();
            expect(await pending).toMatchObject({
                isError: true,
                sideEffect: 'unknown',
                failureCode: 'request_cancelled',
            });
            finish({
                success: true,
                is_error: false,
                content: [{ type: 'image', data: 'cGl4ZWxz', mime_type: 'image/png' }],
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(resources).toEqual([]);
        } finally {
            tools.dispose();
            await connections.dispose();
        }
    });

    it('user does not receive declarations for a changed endpoint until that connection has been established', async () => {
        const { database, connections, tools } = await fixture();
        try {
            database.exec(
                `UPDATE mcp_servers SET url = 'https://replacement.invalid/mcp' WHERE id = 1`
            );
            expect((await tools.snapshot()).declarations).toEqual([]);
            await connections.connect(1);
            expect((await tools.snapshot()).declarations.map((tool) => tool.name)).toEqual([
                'mcp__1__read',
            ]);
        } finally {
            tools.dispose();
            await connections.dispose();
        }
    });

    it('user cannot start an effect when its connection is replaced during authorization', async () => {
        const { database, connections, tools } = await fixture();
        const snapshot = await tools.snapshot();
        let replace = true;
        let authorizationReads = 0;
        interceptTauriInvoke(async (call, next) => {
            if (call.cmd === 'database_tx_begin') {
                database.exec('BEGIN');
                return 'test-tx';
            }
            if (call.cmd === 'database_tx_commit') {
                database.exec('COMMIT');
                return null;
            }
            if (call.cmd === 'database_tx_rollback') {
                database.exec('ROLLBACK');
                return null;
            }
            if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') return next();
            const { request } = call.payload as {
                request: {
                    sql: string;
                    params: import('node:sqlite').SQLInputValue[];
                    method: string;
                };
            };
            const statement = database.prepare(request.sql);
            if (request.method === 'run') {
                const result = statement.run(...request.params);
                return {
                    rows: [],
                    rowsAffected: Number(result.changes),
                    lastInsertId: Number(result.lastInsertRowid),
                };
            }
            const rows = statement.all(...request.params);
            if (replace && request.sql.includes('from "mcp_tools"') && ++authorizationReads === 3) {
                replace = false;
                await connections.connect(1);
            }
            return { rows, rowsAffected: 0, lastInsertId: null };
        });
        try {
            const outcome = await snapshot
                .execute({ id: 'old', name: 'mcp__1__read', arguments: '{}' }, { iteration: 0 })
                .catch((error: unknown) => {
                    expect(error).toBeInstanceOf(ToolExecutionError);
                    return (error as ToolExecutionError).outcome;
                });
            expect(outcome.isError).toBe(true);
            expect(getTauriInvokeCalls('mcp_call_tool')).toEqual([]);
        } finally {
            tools.dispose();
            await connections.dispose();
        }
    });

    it('user can finish local host cleanup when a remote disconnect never acknowledges', async () => {
        const { connections, tools } = await fixture();
        vi.useFakeTimers();
        let finish!: () => void;
        mockTauriCommand(
            'mcp_disconnect_server',
            () =>
                new Promise<void>((resolve) => {
                    finish = resolve;
                })
        );
        const events: unknown[] = [];
        connections.subscribe((event) => events.push(event));
        let settled = false;
        const cleanup = connections.dispose().then(
            () => {
                settled = true;
                return null;
            },
            (error: unknown) => {
                settled = true;
                return error;
            }
        );
        try {
            await vi.advanceTimersByTimeAsync(5000);
            expect(settled).toBe(true);
            expect(await cleanup).toEqual(new Error('agent.mcp.disconnectTimeout'));
            expect(connections.getStatus(1)).toMatchObject({ status: 'disconnected' });
            finish();
            await Promise.resolve();
            expect(events).toEqual([]);
        } finally {
            finish?.();
            tools.dispose();
            await cleanup;
        }
    });
});
