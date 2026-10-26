import type { SQLInputValue } from 'node:sqlite';

import {
    countSessions,
    createSession,
    deleteAllSessions,
    findSessionById,
    listSessions,
} from '@database/queries/sessions';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import { openMigratedDatabase } from './sqliteHarness';

/**
 * The conversation list is the app's home screen. A wrong order hides the conversation the user
 * just used, and a broken search says "nothing found" for a conversation that is right there.
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
        INSERT INTO sessions (id, session_id, title, model, updated_at, last_message_at)
            VALUES (1, 's1', 'Weekly planning', 'gpt-4o', '2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'),
                   (2, 's2', 'Budget review', 'gpt-4o', '2026-01-02T00:00:00Z', NULL),
                   (3, 's3', 'Trip ideas', 'claude', '2026-01-03T00:00:00Z', '2026-01-04T00:00:00Z');
        INSERT INTO messages (id, session_id, role)
            VALUES (10, 1, 'user'), (11, 3, 'assistant');
        INSERT INTO message_parts (message_id, type, content, sort_order)
            VALUES (10, 'text', 'We discussed the quarterly budget in detail', 0),
                   (11, 'text', 'Some travel notes', 0);
    `);
}

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user opens the conversation list', () => {
    it('user gets the most recently used conversation first', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const sessions = await listSessions();

        // s1 has the newest last message; s2 has none, so its updated_at decides.
        expect(sessions.map((session) => session.id)).toEqual([1, 3, 2]);
    });

    it('user gets only as many conversations as they asked for', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(listSessions({ limit: 2 })).resolves.toHaveLength(2);
    });

    it('user gets every conversation when no limit is given', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(listSessions()).resolves.toHaveLength(3);
    });

    it('user gets a conversation found by its title', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const sessions = await listSessions({ query: 'budget' });

        expect(sessions.map((session) => session.id)).toContain(2);
    });

    it('user gets a conversation found by words inside its messages', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        const sessions = await listSessions({ query: 'quarterly' });

        // The match is on message text, not the title.
        expect(sessions.map((session) => session.id)).toEqual([1]);
    });

    it('user gets the search to ignore letter case', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // One match is the title "Budget review", the other the message mentioning the budget.
        const sessions = await listSessions({ query: 'BUDGET' });
        expect(sessions.map((session) => session.id).sort()).toEqual([1, 2]);
    });

    it('user gets a short query searched without the trigram index', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // Two characters cannot use the trigram index; the fallback must still match.
        const sessions = await listSessions({ query: 'tr' });
        expect(sessions.map((session) => session.id)).toContain(3);
    });

    it('user gets no result for a query that matches nothing', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(listSessions({ query: 'nonexistentterm' })).resolves.toEqual([]);
    });

    it('user gets every conversation for a query of only spaces', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // A blank search box is not a search for the empty string.
        await expect(listSessions({ query: '   ' })).resolves.toHaveLength(3);
    });

    it('user gets a percent sign treated as text rather than a wildcard', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        // An unescaped % would match every conversation.
        await expect(listSessions({ query: '%' })).resolves.toEqual([]);
    });

    it('user gets an underscore treated as text rather than a wildcard', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(listSessions({ query: '_' })).resolves.toEqual([]);
    });
});

describe('user creates and reads a conversation', () => {
    it('user gets a new conversation stored with no terminal badge', async () => {
        const database = openDatabase();
        routeQueriesTo(database);

        const created = await createSession({
            session_id: 'new-1',
            title: 'Fresh',
            model: 'gpt-4o',
        } as never);

        // A brand new conversation has nothing to dismiss.
        expect(created).toMatchObject({ session_id: 'new-1', pending_terminal_status: null });
        expect(created.id).toBeGreaterThan(0);
    });

    it('user gets a conversation read back by its id', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(findSessionById(2)).resolves.toMatchObject({ title: 'Budget review' });
        await expect(findSessionById(99)).resolves.toBeUndefined();
    });

    it('user gets the conversation count', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await expect(countSessions()).resolves.toBe(3);
    });

    it('user gets zero counted with no conversations', async () => {
        const database = openDatabase();
        routeQueriesTo(database);

        await expect(countSessions()).resolves.toBe(0);
    });

    it('user gets every conversation removed when they clear the history', async () => {
        const database = openDatabase();
        routeQueriesTo(database);
        seed(database);

        await deleteAllSessions();

        await expect(countSessions()).resolves.toBe(0);
    });
});
