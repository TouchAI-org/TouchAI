import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');
const root = 'src/database/drizzle';
const journal = JSON.parse(readFileSync(`${root}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
};

function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
    for (const entry of journal.entries) {
        for (const statement of readFileSync(`${root}/${entry.tag}.sql`, 'utf8')
            .split('--> statement-breakpoint')
            .map((value) => value.trim())
            .filter(Boolean)) {
            db.exec(statement);
        }
    }
}

function migrated() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrations(db);
    return db;
}

describe('session message query indexes', () => {
    it('scopes message history reads by session without scanning the table', () => {
        const db = migrated();
        try {
            const indexes = db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='messages'"
                )
                .all()
                .map((row) => String(row.name));
            expect(indexes).toContain('messages_session_id_id_idx');

            const plan = db
                .prepare(
                    'EXPLAIN QUERY PLAN SELECT id FROM messages WHERE session_id = ? ORDER BY id'
                )
                .all(1);
            const details = plan.map((row) => String(row.detail)).join('\n');
            expect(details).toContain('messages_session_id_id_idx');
            expect(details).not.toMatch(/SCAN messages\b/);
        } finally {
            db.close();
        }
    });

    it('ships a drizzle snapshot for the new migration', () => {
        const pending = journal.entries.slice(4);
        const snapshotIndexes = readdirSync(`${root}/meta`)
            .filter((file) => /^\d+_snapshot\.json$/.test(file) && Number(file.split('_')[0]) >= 4)
            .map((file) => file.slice(0, 4))
            .sort();
        expect(snapshotIndexes).toEqual(pending.map((entry) => entry.tag.slice(0, 4)).sort());
    });
});
