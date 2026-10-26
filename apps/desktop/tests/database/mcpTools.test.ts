import type { SQLInputValue } from 'node:sqlite';

import {
    countMcpTools,
    countMcpToolsByServerId,
    createMcpTool,
    deleteMcpTool,
    deleteMcpToolsByServerId,
    findAllMcpTools,
    findEnabledMcpToolsByServerId,
    findMcpToolById,
    findMcpToolByServerIdAndName,
    findMcpToolsByServerId,
    updateMcpTool,
} from '@database/queries/mcpTools';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { openMigratedDatabase } from './sqliteHarness';

/**
 * MCP tool rows are re-synced every time a server reconnects. A leaked row from a previous
 * connection makes the model call a tool the server no longer has.
 */
const databases: ReturnType<typeof openMigratedDatabase>[] = [];

function openDatabase() {
    const database = openMigratedDatabase();
    databases.push(database);
    return database;
}

function routeQueriesTo(database: ReturnType<typeof openMigratedDatabase>) {
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
            const result = statement.run(...request.params);
            return {
                rows: [],
                rowsAffected: Number(result.changes),
                lastInsertId: Number(result.lastInsertRowid),
            };
        }
        return { rows: statement.all(...request.params), rowsAffected: 0, lastInsertId: null };
    });
}

function seed(database: ReturnType<typeof openMigratedDatabase>) {
    database.exec(`
        INSERT INTO mcp_servers (id, name, transport_type, enabled)
            VALUES (1, 'filesystem', 'stdio', 1), (2, 'search', 'http', 1);
        INSERT INTO mcp_tools (id, server_id, name, description, input_schema, enabled)
            VALUES (1, 1, 'read_file', 'Read', '{}', 1),
                   (2, 1, 'write_file', 'Write', '{}', 0),
                   (3, 2, 'query', 'Query', '{}', 1);
    `);
}

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user sees the tools a server exposes', () => {
    it('user gets every tool across all servers', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const tools = await findAllMcpTools();

        expect(tools.map((tool) => tool.name)).toEqual(['query', 'read_file', 'write_file']);
    });

    it('user gets only the tools belonging to one server', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const tools = await findMcpToolsByServerId(1);

        expect(tools.map((tool) => tool.name)).toEqual(['read_file', 'write_file']);
    });

    it('user gets only the enabled tools offered to the model', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const tools = await findEnabledMcpToolsByServerId(1);

        // The user disabled write_file; it must not reach the model.
        expect(tools.map((tool) => tool.name)).toEqual(['read_file']);
    });

    it('user gets a tool found by its id', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(findMcpToolById(2)).resolves.toMatchObject({ name: 'write_file' });
        await expect(findMcpToolById(99)).resolves.toBeUndefined();
    });

    it('user gets a tool found by server and name', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // The same name may exist on two servers, so the server id is part of the key.
        await expect(findMcpToolByServerIdAndName(2, 'query')).resolves.toMatchObject({ id: 3 });
        await expect(findMcpToolByServerIdAndName(1, 'query')).resolves.toBeUndefined();
    });

    it('user gets the tool count for the whole app and per server', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(countMcpTools()).resolves.toBe(3);
        await expect(countMcpToolsByServerId(1)).resolves.toBe(2);
        await expect(countMcpToolsByServerId(99)).resolves.toBe(0);
    });
});

describe('user edits an MCP tool list', () => {
    it('user gets a newly discovered tool stored', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const created = await createMcpTool({
            server_id: 2,
            name: 'explain',
            description: 'Explain',
            input_schema: '{}',
            enabled: 1,
        });

        expect(created).toMatchObject({ server_id: 2, name: 'explain' });
        expect(created.id).toBeGreaterThan(0);
    });

    it('user turns a tool off and the change sticks', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const updated = await updateMcpTool(1, { enabled: 0 });

        expect(updated).toMatchObject({ name: 'read_file', enabled: 0 });
        await expect(findEnabledMcpToolsByServerId(1)).resolves.toEqual([]);
    });

    it('user gets nothing updated for a tool that is gone', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(updateMcpTool(99, { enabled: 1 })).resolves.toBeUndefined();
    });

    it('user gets one tool deleted without touching its neighbours', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await deleteMcpTool(2);

        expect((await findMcpToolsByServerId(1)).map((tool) => tool.name)).toEqual(['read_file']);
    });

    it('user gets a reconnected server left with only its current tools', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // The sync deletes first, then inserts what the server reports now.
        await deleteMcpToolsByServerId(1);

        expect(await findMcpToolsByServerId(1)).toHaveLength(0);
        expect((await findMcpToolsByServerId(2)).map((tool) => tool.name)).toEqual(['query']);
    });
});
