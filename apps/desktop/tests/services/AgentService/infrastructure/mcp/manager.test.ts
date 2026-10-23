import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { McpManager } from '@services/AgentService/infrastructure/mcp/McpManager';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const { mcpMock } = vi.hoisted(() => ({
    mcpMock: {
        connectServer: vi.fn(),
        disconnectServer: vi.fn(),
        disconnectAll: vi.fn(),
        listTools: vi.fn(),
        callTool: vi.fn(),
        getServerStatus: vi.fn(),
        getAllServerStatuses: vi.fn(),
    },
}));

vi.mock('@services/NativeService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@services/NativeService')>();
    return { ...actual, mcp: mcpMock };
});

const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};

const databases: SqliteDatabase[] = [];

function openDatabase(): SqliteDatabase {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    for (const entry of journal.entries) {
        database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
    }
    return database;
}

function routeQueriesTo(database: SqliteDatabase) {
    interceptTauriInvoke((call) => {
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
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') return undefined;

        const { request } = call.payload as {
            request: { sql: string; params: SQLInputValue[]; method: string };
        };
        const statement = database.prepare(request.sql);
        if (request.method === 'run') {
            const result = statement.run(...(request.params ?? []));
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return {
            rows: statement.all(...(request.params ?? [])),
            rowsAffected: 0,
            lastInsertId: null,
        };
    });
}

function seedServer(
    database: SqliteDatabase,
    overrides: { enabled?: number; timeout?: number } = {}
) {
    database
        .prepare(
            `INSERT INTO mcp_servers (id, name, transport_type, command, enabled, tool_timeout)
             VALUES (1, 'filesystem', 'stdio', 'node', ?, ?)`
        )
        .run(overrides.enabled ?? 1, overrides.timeout ?? 30_000);
}

function seedTool(
    database: SqliteDatabase,
    name: string,
    options: { enabled?: number; description?: string | null } = {}
) {
    database
        .prepare(
            `INSERT INTO mcp_tools (server_id, name, description, input_schema, enabled)
             VALUES (1, ?, ?, ?, ?)`
        )
        .run(
            name,
            options.description ?? null,
            JSON.stringify({ type: 'object', properties: { path: { type: 'string' } } }),
            options.enabled ?? 1
        );
}

function toolRows(database: SqliteDatabase) {
    return database.prepare('SELECT name, enabled FROM mcp_tools ORDER BY name').all() as Array<{
        name: string;
        enabled: number;
    }>;
}

function serverRow(database: SqliteDatabase) {
    return database.prepare('SELECT version, last_error FROM mcp_servers WHERE id = 1').get() as {
        version: string | null;
        last_error: string | null;
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mcpMock.connectServer.mockResolvedValue(undefined);
    mcpMock.disconnectServer.mockResolvedValue(undefined);
    mcpMock.disconnectAll.mockResolvedValue(undefined);
    mcpMock.listTools.mockResolvedValue([]);
    mcpMock.getServerStatus.mockResolvedValue({ status: 'connected', version: null });
    mcpMock.getAllServerStatuses.mockResolvedValue([]);
});

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user connects an MCP server', () => {
    it('user sees the server tools synced while the tools they disabled stay disabled', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        seedTool(database, 'read_file', { enabled: 0 });
        mcpMock.listTools.mockResolvedValue([
            { name: 'read_file', description: 'read', input_schema: { type: 'object' } },
            { name: 'write_file', description: 'write', input_schema: { type: 'object' } },
        ]);
        mcpMock.getServerStatus.mockResolvedValue({ status: 'connected', version: '1.4.0' });

        await new McpManager().connectServer({
            id: 1,
            name: 'filesystem',
            transport_type: 'stdio',
            command: 'node',
            enabled: 1,
            tool_timeout: 30_000,
        } as Parameters<McpManager['connectServer']>[0]);

        expect(toolRows(database)).toEqual([
            { name: 'read_file', enabled: 0 },
            { name: 'write_file', enabled: 1 },
        ]);
        expect(serverRow(database)).toEqual({ version: '1.4.0', last_error: null });
    });

    it('user is told why a server failed to connect and sees it kept out of the tool list', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        mcpMock.connectServer.mockRejectedValue(new Error('spawn node ENOENT'));

        const manager = new McpManager();

        await expect(
            manager.connectServer({
                id: 1,
                name: 'filesystem',
                transport_type: 'stdio',
                command: 'node',
                enabled: 1,
                tool_timeout: 30_000,
            } as Parameters<McpManager['connectServer']>[0])
        ).rejects.toThrow('spawn node ENOENT');

        expect(manager.getServerStatus(1)).toBe('error');
        expect(manager.getServerError(1)).toBe('spawn node ENOENT');
        expect(serverRow(database).last_error).toBe('spawn node ENOENT');
        await expect(manager.getEnabledToolDefinitions()).resolves.toEqual([]);
    });

    it('user sees only tools from servers that are actually connected', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        seedTool(database, 'read_file', { description: 'read a file' });
        const manager = new McpManager();

        // Not connected yet: the model must not see the tool.
        await expect(manager.getEnabledToolDefinitions()).resolves.toEqual([]);

        manager.setStatusFromEvent(1, 'connected');
        const definitions = await manager.getEnabledToolDefinitions();

        expect(definitions).toHaveLength(1);
        expect(definitions[0]).toMatchObject({
            name: 'mcp__1__read_file',
            description: 'read a file',
            adaptiveTimeoutCeilingMs: 30_000,
        });
        expect(definitions[0]?.input_schema).toMatchObject({ type: 'object' });
    });

    it('user sees a readable description for a tool that ships none', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        seedTool(database, 'read_file');
        const manager = new McpManager();
        manager.setStatusFromEvent(1, 'connected');

        const [definition] = await manager.getEnabledToolDefinitions();

        expect(definition?.description).toContain('read_file');
    });
});

describe('user calls an MCP tool', () => {
    it('user gets the server resolved from a namespaced tool name', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        seedTool(database, 'read_file');
        const manager = new McpManager();

        await expect(manager.resolveToolCall('mcp__1__read_file')).resolves.toEqual({
            serverId: 1,
            originalName: 'read_file',
            toolTimeout: 30_000,
        });
    });

    it('user gets no tool when the name, server, or tool is unknown or disabled', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database, { enabled: 0 });
        seedTool(database, 'read_file');
        const manager = new McpManager();

        await expect(manager.resolveToolCall('read_file')).resolves.toBeNull();
        await expect(manager.resolveToolCall('mcp__99__read_file')).resolves.toBeNull();
        await expect(manager.resolveToolCall('mcp__1__read_file')).resolves.toBeNull();
        await expect(manager.resolveToolCall('mcp__1__missing')).resolves.toBeNull();
    });

    it('user sees the tool result text and the error flag from the server', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        seedTool(database, 'read_file');
        mcpMock.callTool.mockResolvedValue({
            success: true,
            is_error: true,
            content: [{ type: 'text', text: 'permission denied' }],
        });
        const manager = new McpManager();

        await expect(
            manager.executeTool('mcp__1__read_file', { path: 'README.md' })
        ).resolves.toMatchObject({ result: 'permission denied', isError: true });
        expect(mcpMock.callTool).toHaveBeenCalledWith(
            1,
            'read_file',
            { path: 'README.md' },
            30_000
        );
    });

    it('user sees a cancelled tool call end before the server is contacted', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        seedTool(database, 'read_file');
        const manager = new McpManager();
        const controller = new AbortController();
        controller.abort();

        const result = await manager.executeTool(
            'mcp__1__read_file',
            {},
            {
                signal: controller.signal,
            }
        );

        expect(result.isError).toBe(true);
        expect(mcpMock.callTool).not.toHaveBeenCalled();
    });
});

describe('user disconnects MCP servers', () => {
    it('user sees all server statuses refreshed from the backend', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        mcpMock.getAllServerStatuses.mockResolvedValue([
            { server_id: 1, status: 'error', error: 'crashed' },
        ]);
        const manager = new McpManager();

        await manager.refreshAllServerStatuses();

        expect(manager.getServerStatus(1)).toBe('error');
        expect(manager.getServerError(1)).toBe('crashed');
    });

    it('user is told when disconnecting all servers takes too long and sees statuses cleared once they settle', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        let settleDisconnect: (() => void) | null = null;
        mcpMock.disconnectAll.mockReturnValue(
            new Promise<void>((resolveDisconnect) => {
                settleDisconnect = resolveDisconnect;
            })
        );
        const manager = new McpManager();
        manager.setStatusFromEvent(1, 'connected');

        await expect(manager.disconnectAll(10)).rejects.toThrow();

        // The backend is still shutting down, so the shown status is not rewritten yet.
        expect(manager.getServerStatus(1)).toBe('connected');

        settleDisconnect!();
        await Promise.resolve();
        await Promise.resolve();

        expect(manager.getServerStatus(1)).toBe('disconnected');
    });

    it('user sees the server disconnected and its error cleared', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seedServer(database);
        const manager = new McpManager();
        manager.setStatusFromEvent(1, 'error', 'crashed');

        await manager.disconnectServer(1);

        expect(manager.getServerStatus(1)).toBe('disconnected');
        expect(manager.getServerError(1)).toBeNull();
        expect(serverRow(database).last_error).toBeNull();
    });
});
