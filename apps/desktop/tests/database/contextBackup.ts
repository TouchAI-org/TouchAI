import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export function attachContextBackup(target: DatabaseSync, source: DatabaseSync) {
    target.exec('PRAGMA foreign_keys = OFF');
    target.exec("ATTACH DATABASE ':memory:' AS imported");
    const tables = source
        .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'message_search_fts%'"
        )
        .all();
    for (const table of tables) {
        target.exec(String(table.sql).replace('CREATE TABLE ', 'CREATE TABLE imported.'));
        const columns = source
            .prepare(`PRAGMA table_xinfo("${table.name}")`)
            .all()
            .filter((column) => column.hidden === 0)
            .map((column) => String(column.name));
        const quoted = columns.map((column) => `"${column}"`).join(',');
        const insert = target.prepare(
            `INSERT INTO imported."${table.name}" (${quoted}) VALUES (${columns.map(() => '?').join(',')})`
        );
        for (const row of source.prepare(`SELECT ${quoted} FROM "${table.name}"`).all()) {
            insert.run(...columns.map((column) => row[column] as SQLInputValue));
        }
    }
    target.exec('PRAGMA foreign_keys = ON');
}

export function importChangedContextHistory(database: DatabaseSync) {
    attachContextBackup(database, database);
    database.exec(
        "UPDATE imported.message_parts SET content='Divergent backup evidence' WHERE message_id=2 AND type='text'"
    );
    database.exec('BEGIN IMMEDIATE');
    database.exec(
        readFileSync(
            resolve(
                dirname(fileURLToPath(import.meta.url)),
                '../../src/database/artifacts/import/chat_merge.sql'
            ),
            'utf8'
        )
    );
    database.exec('COMMIT');
}
