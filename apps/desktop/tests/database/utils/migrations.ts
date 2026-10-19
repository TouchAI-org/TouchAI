import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const root = 'src/database/drizzle';
const journal = JSON.parse(readFileSync(`${root}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
};

export function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
    for (const entry of journal.entries) {
        for (const statement of readFileSync(`${root}/${entry.tag}.sql`, 'utf8')
            .split('--> statement-breakpoint')
            .map((value) => value.trim())
            .filter(Boolean)) {
            db.exec(statement);
        }
    }
}

export function createMigratedDatabase() {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrations(db);
    return db;
}

export function listIndexes(db: InstanceType<typeof DatabaseSync>, table: string): string[] {
    return db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
        .all(table)
        .map((row) => String(row.name));
}

export function ftsRowIds(db: InstanceType<typeof DatabaseSync>, match: string): number[] {
    return db
        .prepare('SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?')
        .all(match)
        .map((row) => Number(row.rowid));
}
