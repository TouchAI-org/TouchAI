import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';

import { interceptTauriInvoke } from '@tests/utils/tauri';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databaseRoot = resolve('src/database');
const journal = JSON.parse(readFileSync(`${databaseRoot}/drizzle/meta/_journal.json`, 'utf8')) as {
    entries: Array<{ tag: string }>;
};

const openDatabases: SqliteDatabase[] = [];

/**
 * Opens an in-memory SQLite database with every shipped migration applied, so the
 * tests exercise the real schema instead of a hand-written subset.
 *
 * Call `closeTestDatabases()` in `afterEach` to release them.
 */
export function openMigratedDatabase(): SqliteDatabase {
    const database = new DatabaseSync(':memory:');
    openDatabases.push(database);
    database.exec('PRAGMA foreign_keys = ON');
    for (const entry of journal.entries) {
        database.exec(readFileSync(`${databaseRoot}/drizzle/${entry.tag}.sql`, 'utf8'));
    }
    return database;
}

/**
 * Routes the app's database IPC to a real in-memory database.
 *
 * The query layer only ever talks to SQLite through Tauri commands, so this is the
 * system boundary the tests replace; everything above it runs for real.
 */
export function routeQueriesTo(
    database: SqliteDatabase,
    options: { beforeCommit?: () => void } = {}
): void {
    interceptTauriInvoke((call, next) => {
        const operation = routeDatabaseOperation(database, call);
        if (operation) {
            return operation.value;
        }
        if (call.cmd === 'database_tx_begin') {
            database.exec('BEGIN');
            return 'test-tx';
        }
        if (call.cmd === 'database_tx_commit') {
            options.beforeCommit?.();
            database.exec('COMMIT');
            return null;
        }
        if (call.cmd === 'database_tx_rollback') {
            database.exec('ROLLBACK');
            return null;
        }
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') {
            return next();
        }

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

/**
 * Routes one typed database operation to the test database. The production
 * bridge deliberately has no generic SQL fallback, so this is the test-side
 * equivalent of the Rust repository dispatch.
 */
export function routeDatabaseOperation(
    database: SqliteDatabase,
    call: { cmd: string; payload?: unknown }
): { value: unknown } | undefined {
    if (call.cmd !== 'database_operation') return undefined;
    const request = (call.payload as { request?: Record<string, unknown> } | undefined)?.request;
    if (!request) return { value: undefined };

    const kind = String(request.kind);
    const read = (sql: string, params: SQLInputValue[] = []) =>
        database.prepare(sql).all(...params);
    const run = (sql: string, params: SQLInputValue[] = []) => database.prepare(sql).run(...params);

    switch (kind) {
        case 'setting_find':
            return {
                value:
                    read('SELECT * FROM settings WHERE key = ? LIMIT 1', [
                        String(request.key),
                    ])[0] ?? null,
            };
        case 'setting_get':
            return {
                value:
                    (
                        read('SELECT value FROM settings WHERE key = ? LIMIT 1', [
                            String(request.key),
                        ])[0] as { value?: string | null } | undefined
                    )?.value ?? null,
            };
        case 'setting_get_many': {
            const keys = (request.keys as string[] | undefined) ?? [];
            if (keys.length === 0) return { value: {} };
            const rows = read(
                `SELECT key, value FROM settings WHERE key IN (${keys.map(() => '?').join(', ')})`,
                keys
            ) as Array<{ key: string; value: string | null }>;
            const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
            return {
                value: Object.fromEntries(keys.map((key) => [key, values[key] ?? null])),
            };
        }
        case 'setting_set':
            return {
                value: database
                    .prepare(
                        `INSERT INTO settings (key, value) VALUES (?, ?)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value
                         RETURNING *`
                    )
                    .get(String(request.key), String(request.value)),
            };
        case 'statistic_get':
            return {
                value:
                    (
                        read('SELECT value FROM statistics WHERE key = ? LIMIT 1', [
                            String(request.key),
                        ])[0] as { value?: string | null } | undefined
                    )?.value ?? null,
            };
        case 'statistic_set':
            run(
                `INSERT INTO statistics (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                [String(request.key), String(request.value)]
            );
            return { value: true };
        case 'meta_get':
            return {
                value:
                    (
                        read('SELECT value FROM touchai_meta WHERE key = ? LIMIT 1', [
                            String(request.key),
                        ])[0] as { value?: string | null } | undefined
                    )?.value ?? null,
            };
        case 'meta_set':
            run(
                `INSERT INTO touchai_meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                [String(request.key), String(request.value)]
            );
            return { value: null };
        case 'meta_delete':
            run('DELETE FROM touchai_meta WHERE key = ?', [String(request.key)]);
            return { value: null };
        case 'quick_search_find':
            return {
                value: read(
                    `SELECT path_norm, click_count, query_norm
                     FROM quick_search_click_stats
                     WHERE query_norm = ?
                     ORDER BY click_count DESC, updated_at DESC
                     LIMIT ?`,
                    [String(request.queryNorm), Number(request.limit)]
                ),
            };
        case 'quick_search_find_recent':
            return {
                value: read(
                    `SELECT path_norm, click_count, query_norm, updated_at
                     FROM quick_search_click_stats
                     WHERE query_norm = ?
                     ORDER BY updated_at DESC, click_count DESC, path_norm
                     LIMIT ?`,
                    [String(request.queryNorm), Number(request.limit)]
                ),
            };
        case 'quick_search_upsert':
            if (!request.queryNorm || !request.pathNorm) return { value: null };
            run(
                `INSERT INTO quick_search_click_stats (query_norm, path_norm, click_count, updated_at)
                 VALUES (?, ?, 1, strftime('%Y-%m-%d %H:%M:%f', 'now'))
                 ON CONFLICT(query_norm, path_norm) DO UPDATE SET
                   click_count = CASE
                     WHEN quick_search_click_stats.click_count >= ? THEN ?
                     ELSE quick_search_click_stats.click_count + 1
                   END,
                   updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now')`,
                [
                    String(request.queryNorm),
                    String(request.pathNorm),
                    Number(request.maxClickCount),
                    Number(request.maxClickCount),
                ]
            );
            return { value: null };
        default:
            throw new Error(`Unhandled database operation in test: ${kind}`);
    }
}

/** Closes every database opened by `openMigratedDatabase` in the current test file. */
export function closeTestDatabases(): void {
    openDatabases.splice(0).forEach((database) => database.close());
}
