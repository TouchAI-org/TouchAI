import type { SQLInputValue } from 'node:sqlite';

import {
    countEnabledBuiltInTools,
    createBuiltInTool,
    findAllBuiltInTools,
    findBuiltInToolById,
    findBuiltInToolByToolId,
    findEnabledBuiltInTools,
    touchBuiltInToolLastUsed,
    updateBuiltInTool,
    updateBuiltInTools,
} from '@database/queries/builtInTools';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { openMigratedDatabase } from './sqliteHarness';

/**
 * The built-in tool rows are what the settings page toggles and what the agent reads before each
 * request. A wrong ordering or a lost enabled flag either hides a tool the user turned on or
 * offers one they turned off.
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
        INSERT INTO built_in_tools (id, tool_id, display_name, risk_level, enabled)
            VALUES (1, 'bash', 'Bash', 'high', 1),
                   (2, 'web_fetch', 'Web fetch', 'low', 1),
                   (3, 'ask_user', 'Ask user', 'low', 0);
    `);
}

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user opens the built-in tool settings', () => {
    it('user gets the enabled tools listed before the disabled ones', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const tools = await findAllBuiltInTools();

        // Enabled tools come first, then each group is alphabetical by display name.
        expect(tools.map((tool) => tool.tool_id)).toEqual(['bash', 'web_fetch', 'ask_user']);
        expect(tools[0]!.enabled).toBe(1);
        expect(tools[tools.length - 1]!.enabled).toBe(0);
    });

    it('user gets only the enabled tools offered to the model', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const tools = await findEnabledBuiltInTools();

        expect(tools.map((tool) => tool.tool_id)).toEqual(['bash', 'web_fetch']);
    });

    it('user gets a tool found by its database id', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const tool = await findBuiltInToolById(2);

        expect(tool?.tool_id).toBe('web_fetch');
    });

    it('user gets a tool found by its stable tool id', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const tool = await findBuiltInToolByToolId('bash');

        expect(tool?.id).toBe(1);
    });

    it('user gets nothing for an id that is not stored', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(findBuiltInToolById(99)).resolves.toBeUndefined();
        await expect(findBuiltInToolByToolId('ghost')).resolves.toBeUndefined();
    });

    it('user gets the count of tools they have enabled', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // The settings badge counts what is on, not what exists.
        await expect(countEnabledBuiltInTools()).resolves.toBe(2);
    });

    it('user gets zero counted when every tool is off', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        database.exec(`
            INSERT INTO built_in_tools (id, tool_id, display_name, risk_level, enabled)
                VALUES (1, 'bash', 'Bash', 'high', 0);
        `);

        await expect(countEnabledBuiltInTools()).resolves.toBe(0);
    });
});

describe('user changes a built-in tool', () => {
    it('user gets a new tool stored and returned', async () => {
        const database = openDatabase();
        routeQueriesTo(database);

        const created = await createBuiltInTool({
            tool_id: 'bash',
            display_name: 'Bash',
            description: 'Run a command',
            enabled: 1,
            risk_level: 'high',
            config_json: '{}',
        });

        expect(created).toMatchObject({ tool_id: 'bash', display_name: 'Bash' });
        expect(created.id).toBeGreaterThan(0);
    });

    it('user gets their config saved without the other fields changing', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const updated = await updateBuiltInTool(1, { config_json: '{"approvalMode":"never"}' });

        expect(updated).toMatchObject({
            tool_id: 'bash',
            display_name: 'Bash',
            config_json: '{"approvalMode":"never"}',
        });
    });

    it('user gets nothing updated for an id that does not exist', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(updateBuiltInTool(99, { enabled: 1 })).resolves.toBeUndefined();
    });

    it('user turns several tools on at once and all of them stick', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const updated = await updateBuiltInTools([1, 3], { enabled: 1 });

        expect(updated).toHaveLength(2);
        await expect(findEnabledBuiltInTools()).resolves.toHaveLength(3);
    });

    it('user asks to update no tools and nothing is written', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // An empty selection is a no-op, not a transaction that rewrites the table.
        await expect(updateBuiltInTools([], { enabled: 0 })).resolves.toEqual([]);
        await expect(countEnabledBuiltInTools()).resolves.toBe(2);
    });

    it('user gets the whole batch rolled back when one id is missing', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // A partial batch would leave half the tools changed and no way to retry cleanly.
        await expect(updateBuiltInTools([1, 99], { enabled: 0 })).rejects.toThrow();

        await expect(countEnabledBuiltInTools()).resolves.toBe(2);
    });

    it('user gets the last-used time recorded when a tool runs', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await touchBuiltInToolLastUsed('bash', '2026-05-01T00:00:00Z');

        const tool = await findBuiltInToolByToolId('bash');
        expect(tool?.last_used_at).toBe('2026-05-01T00:00:00Z');
    });

    it('user gets a timestamp filled in when none is given', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await touchBuiltInToolLastUsed('bash');

        const tool = await findBuiltInToolByToolId('bash');
        expect(tool?.last_used_at).toBeTruthy();
    });
});
