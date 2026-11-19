import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');
const root = resolve('src/database');
const artifact = (path: string) => readFileSync(resolve(root, path), 'utf8');
let database: SqliteDatabase | undefined;

afterEach(() => database?.close());

describe('given a populated database with the shipped constraints and deletion guards', () => {
    it('user clears database contents and retains the schema while personal data and search results disappear', () => {
        database = new DatabaseSync(':memory:');
        database.exec('PRAGMA foreign_keys = ON');
        const journal = JSON.parse(artifact('drizzle/meta/_journal.json')) as {
            entries: Array<{ tag: string }>;
        };
        for (const entry of journal.entries) database.exec(artifact(`drizzle/${entry.tag}.sql`));
        database.exec(artifact('artifacts/runtime/guards.sql'));
        database.exec(artifact('artifacts/runtime/seed.sql'));
        database.exec(`
            INSERT INTO sessions(id,session_id,title,model) VALUES(1,'private','private conversation','fixture');
            INSERT INTO messages(id,session_id,role) VALUES(1,1,'user');
            INSERT INTO message_parts(message_id,type,content,sort_order) VALUES(1,'text','private conversation text',0);
            INSERT INTO session_turns(id,task_id,prompt_snapshot_json) VALUES(1,'private','{"userPrompt":"private"}');
            INSERT INTO session_turn_attempts(turn_id,attempt_index,checkpoint_json,delivery_manifest_json) VALUES(1,0,'{}','{}');
            INSERT INTO settings(key,value) VALUES('private-setting','private value');
            INSERT INTO statistics(key,value) VALUES('usage_rollup_baseline','[]');
            UPDATE providers SET api_key='private key';
        `);
        expect(
            database.prepare('SELECT count(*) AS count FROM message_search_fts').get()?.count
        ).toBe(1);
        expect(() => database!.exec('DELETE FROM providers')).toThrow('无法删除内置服务商');
        const schema = database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
        database.exec(`BEGIN; ${artifact('artifacts/storage/clear_database.sql')} COMMIT;`);
        for (const table of [
            'sessions',
            'messages',
            'message_parts',
            'message_search_fts',
            'session_turns',
            'session_turn_attempts',
            'providers',
            'models',
            'settings',
            'statistics',
            'touchai_meta',
            'built_in_tools',
            'attachments',
            'usage_daily_rollups',
        ]) {
            expect(
                database.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count,
                table
            ).toBe(0);
        }
        expect(database.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all()).toEqual(
            schema
        );
        expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(database.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        database.exec(artifact('artifacts/runtime/seed.sql'));
        expect(
            Number(database.prepare('SELECT count(*) AS count FROM providers').get()?.count)
        ).toBeGreaterThan(0);
        expect(
            database
                .prepare(
                    "SELECT count(*) AS count FROM providers WHERE api_key IS NOT NULL AND api_key <> ''"
                )
                .get()?.count
        ).toBe(0);
        expect(() => database!.exec('DELETE FROM providers')).toThrow('无法删除内置服务商');
    });
});
