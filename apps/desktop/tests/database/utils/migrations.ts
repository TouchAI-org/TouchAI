import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const root = 'src/database/drizzle';
const journal = JSON.parse(readFileSync(`${root}/meta/_journal.json`, 'utf8')) as {
    entries: { tag: string }[];
};

function readStatements(tag: string): string[] {
    return readFileSync(`${root}/${tag}.sql`, 'utf8')
        .split('--> statement-breakpoint')
        .map((value) => value.trim())
        .filter(Boolean);
}

function isForeignKeyPragma(statement: string): boolean {
    return /^PRAGMA foreign_keys\s*=/i.test(statement);
}

/** Mirrors the native migration executor: rebuild pragmas cannot run inside a transaction. */
export function applyMigrationTag(db: InstanceType<typeof DatabaseSync>, tag: string) {
    const statements = readStatements(tag);
    if (!statements.some(isForeignKeyPragma)) {
        db.exec('BEGIN');
        try {
            for (const statement of statements) db.exec(statement);
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
        return;
    }

    const enabled = Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys ?? 1) !== 0;
    db.exec('PRAGMA foreign_keys=OFF');
    try {
        db.exec('BEGIN');
        try {
            for (const statement of statements) {
                if (!isForeignKeyPragma(statement)) db.exec(statement);
            }
            db.exec('COMMIT');
        } catch (error) {
            db.exec('ROLLBACK');
            throw error;
        }
    } finally {
        db.exec(enabled ? 'PRAGMA foreign_keys=ON' : 'PRAGMA foreign_keys=OFF');
    }
}

export function applyMigrations(db: InstanceType<typeof DatabaseSync>) {
    for (const entry of journal.entries) {
        applyMigrationTag(db, entry.tag);
    }
}

/** 只应用到指定迁移（含）为止，用于构造升级前的旧 schema 夹具。 */
export function applyMigrationsThrough(db: InstanceType<typeof DatabaseSync>, throughTag: string) {
    for (const entry of journal.entries) {
        for (const statement of readStatements(entry.tag)) {
            db.exec(statement);
        }
        if (entry.tag === throughTag) {
            return;
        }
    }

    throw new Error(`Migration tag not found: ${throughTag}`);
}

/** 应用指定迁移之后的剩余迁移，用于测量升级路径。 */
export function applyMigrationsAfter(db: InstanceType<typeof DatabaseSync>, afterTag: string) {
    let found = false;
    for (const entry of journal.entries) {
        if (entry.tag === afterTag) {
            found = true;
            continue;
        }
        if (!found) {
            continue;
        }
        for (const statement of readStatements(entry.tag)) {
            db.exec(statement);
        }
    }

    if (!found) {
        throw new Error(`Migration tag not found: ${afterTag}`);
    }
}

export function createMigrationFixtureDatabase(throughTag: string) {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    applyMigrationsThrough(db, throughTag);
    return db;
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
