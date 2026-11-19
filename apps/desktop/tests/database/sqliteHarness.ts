import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase, SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { interceptTauriInvoke, type TauriInvokeCall } from '@tests/utils/tauri';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databaseRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/database');
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
    options: {
        beforeCommit?: () => void;
        beforeQuery?: (request: {
            sql: string;
            params: SQLInputValue[];
            method: string;
        }) => Promise<void> | void;
        afterQuery?: (request: { sql: string; params: SQLInputValue[]; method: string }) => void;
        aroundInvoke?: (
            call: TauriInvokeCall,
            next: () => Promise<unknown> | unknown
        ) => Promise<unknown> | unknown;
    } = {}
): void {
    let transactionTail = Promise.resolve();
    let activeTransaction: { id: string; release(): void } | undefined;
    let transactionCount = 0;
    const assertTransaction = (payload: unknown) => {
        const { txId } = payload as { txId: string };
        if (!activeTransaction || activeTransaction.id !== txId)
            throw new Error('fixture transaction handle is stale');
        return activeTransaction;
    };
    const route = (call: TauriInvokeCall, next: () => Promise<unknown>) => {
        if (call.cmd === 'database_tx_begin') {
            // Native BEGIN IMMEDIATE waits for the previous writer; a single fixture connection must do the same.
            const previous = transactionTail;
            let release!: () => void;
            transactionTail = new Promise<void>((resolve) => {
                release = resolve;
            });
            return previous.then(() => {
                const { behavior = 'immediate' } = call.payload as { behavior?: string };
                const mode = {
                    immediate: 'IMMEDIATE',
                    deferred: 'DEFERRED',
                    exclusive: 'EXCLUSIVE',
                }[behavior];
                try {
                    if (!mode) throw new Error('fixture transaction mode is invalid');
                    database.exec(`BEGIN ${mode}`);
                    activeTransaction = { id: `test-tx-${++transactionCount}`, release };
                    return activeTransaction.id;
                } catch (error) {
                    release();
                    throw error;
                }
            });
        }
        if (call.cmd === 'database_tx_commit') {
            const transaction = assertTransaction(call.payload);
            options.beforeCommit?.();
            database.exec('COMMIT');
            activeTransaction = undefined;
            transaction.release();
            return null;
        }
        if (call.cmd === 'database_tx_rollback') {
            const transaction = assertTransaction(call.payload);
            try {
                database.exec('ROLLBACK');
            } finally {
                activeTransaction = undefined;
                transaction.release();
            }
            return null;
        }
        if (call.cmd !== 'database_query' && call.cmd !== 'database_tx_query') {
            return next();
        }
        if (call.cmd === 'database_tx_query') assertTransaction(call.payload);

        const { request } = call.payload as {
            request: { sql: string; params: SQLInputValue[]; method: string };
        };
        const execute = () => {
            const statement = database.prepare(request.sql);
            let result;
            if (request.method === 'run') {
                const written = statement.run(...(request.params ?? []));
                result = {
                    rows: [],
                    rowsAffected: Number(written.changes),
                    lastInsertId: Number(written.lastInsertRowid),
                };
            } else
                result = {
                    rows: statement.all(...(request.params ?? [])),
                    rowsAffected: 0,
                    lastInsertId: null,
                };
            options.afterQuery?.(request);
            return result;
        };
        const admission = options.beforeQuery?.(request);
        return admission ? admission.then(execute) : execute();
    };
    interceptTauriInvoke((call, next) =>
        options.aroundInvoke
            ? options.aroundInvoke(call, () => route(call, next))
            : route(call, next)
    );
}

/** Closes every database opened by `openMigratedDatabase` in the current test file. */
export function closeTestDatabases(): void {
    openDatabases.splice(0).forEach((database) => database.close());
}
