import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createModelProvider } from './model-provider.js';

const databaseRoot = fileURLToPath(new URL('../../../src/database/', import.meta.url));
let activeFixture;

/** Apply the same declared SQL artifacts to a fresh, isolated test database. */
export function seedAgentDatabase(databasePath, providerUrl) {
    if (fs.existsSync(databasePath)) throw new Error('Agent fixture requires a fresh database');
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    try {
        database.exec(
            'CREATE TABLE migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL)'
        );
        const journal = JSON.parse(
            fs.readFileSync(path.join(databaseRoot, 'drizzle/meta/_journal.json'), 'utf8')
        );
        for (const { tag } of journal.entries) {
            database.exec('BEGIN');
            database.exec(
                fs.readFileSync(path.join(databaseRoot, 'drizzle', `${tag}.sql`), 'utf8')
            );
            database
                .prepare('INSERT INTO migrations (hash, created_at) VALUES (?, ?)')
                .run(tag, Date.now());
            database.exec('COMMIT');
        }
        for (const name of ['seed.sql', 'guards.sql']) {
            database.exec(
                fs.readFileSync(path.join(databaseRoot, 'artifacts/runtime', name), 'utf8')
            );
        }
        database.exec(
            'BEGIN; UPDATE models SET is_default=0; UPDATE providers SET enabled=0; UPDATE built_in_tools SET enabled=0;'
        );
        for (const [index, label] of ['Alpha', 'Beta'].entries()) {
            const id = database
                .prepare(
                    'INSERT INTO providers (name,driver,api_endpoint,api_key,logo,enabled,is_builtin) VALUES (?,?,?,?,?,1,0)'
                )
                .run(
                    `E2E ${label}`,
                    'openai-compatible',
                    `${providerUrl}/${label.toLowerCase()}`,
                    `e2e-${label.toLowerCase()}-key`,
                    'test'
                ).lastInsertRowid;
            database
                .prepare(
                    'INSERT INTO models (provider_id,name,model_id,is_default,tool_call,context_limit,output_limit,is_custom_metadata) VALUES (?,?,?,?,1,32000,2048,1)'
                )
                .run(id, `E2E ${label}`, `e2e-${label.toLowerCase()}`, index === 0 ? 1 : 0);
        }
        database.exec(
            "UPDATE built_in_tools SET enabled=1 WHERE tool_id IN ('setting','ask_user_question')"
        );
        database.exec('COMMIT');
    } finally {
        database.close();
    }
}

export async function createAgentFixture(appRoot) {
    const provider = await createModelProvider();
    const databasePath = path.join(appRoot, 'data', 'touchai.db');
    try {
        seedAgentDatabase(databasePath, provider.baseUrl);
    } catch (error) {
        await provider.close();
        throw error;
    }
    function withDatabase(readOnly, action) {
        const database = new DatabaseSync(databasePath, { readOnly });
        try {
            database.exec('PRAGMA busy_timeout=1000');
            return action(database);
        } finally {
            database.close();
        }
    }
    async function assertHealthy() {
        await provider.assertHealthy();
    }
    activeFixture = {
        appRoot,
        databasePath,
        provider,
        assertHealthy,
        query: (sql, ...bindings) => withDatabase(true, (db) => db.prepare(sql).all(...bindings)),
        execute: (sql, ...bindings) =>
            withDatabase(false, (db) => db.prepare(sql).run(...bindings)),
        async close() {
            let failure;
            try {
                await assertHealthy();
            } catch (error) {
                failure = error;
            }
            const calls = await provider.calls().catch(() => []);
            await provider.close();
            fs.writeFileSync(
                path.join(appRoot, 'model-requests.json'),
                JSON.stringify(calls, null, 2)
            );
            activeFixture = undefined;
            if (failure) throw failure;
        },
    };
    return activeFixture;
}

export function getAgentFixture() {
    if (!activeFixture)
        throw new Error('Agent E2E fixture was not initialized by the native runner');
    return activeFixture;
}
