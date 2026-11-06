// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databaseRoot = resolve('src/database');
const baseline = JSON.parse(
    readFileSync(resolve('scripts/ci/architecture/db-artifacts-baseline.json'), 'utf8')
) as Record<string, string>;
const journal = JSON.parse(
    readFileSync(resolve(databaseRoot, 'drizzle/meta/_journal.json'), 'utf8')
) as { entries: Array<{ tag: string }> };
const expectedFingerprints = JSON.parse(
    readFileSync(resolve('tests/ci/architecture/database-contract.fixtures.json'), 'utf8')
) as Record<string, string>;

function sha256(bytes: string | Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function quoteIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
}

function normalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    if (value && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce<Record<string, unknown>>((result, key) => {
                result[key] = normalize((value as Record<string, unknown>)[key]);
                return result;
            }, {});
    }
    return value;
}

function readRows(
    database: InstanceType<typeof DatabaseSync>,
    sql: string
): Array<Record<string, unknown>> {
    return database.prepare(sql).all() as Array<Record<string, unknown>>;
}

function schemaFacts(database: InstanceType<typeof DatabaseSync>): unknown {
    const objects = readRows(
        database,
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`
    );
    const tables = readRows(
        database,
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`
    );
    const tableFacts = tables.map(({ name }) => {
        const table = String(name);
        const quoted = quoteIdentifier(table);
        const columns = readRows(database, `PRAGMA table_info(${quoted})`);
        const indexes = readRows(database, `PRAGMA index_list(${quoted})`);
        const indexFacts = indexes.map(({ name: indexName }) => {
            const index = String(indexName);
            return {
                name: index,
                columns: readRows(database, `PRAGMA index_info(${quoteIdentifier(index)})`),
            };
        });
        return {
            name: table,
            columns,
            indexes: indexFacts,
            foreignKeys: readRows(database, `PRAGMA foreign_key_list(${quoted})`),
        };
    });
    const sqliteSequence = readRows(
        database,
        `SELECT name, seq FROM sqlite_sequence ORDER BY name`
    ).map((row) => ({ name: row.name, seq: row.seq }));

    return {
        objects,
        tables: tableFacts,
        sqliteSequence,
    };
}

function fingerprint(database: InstanceType<typeof DatabaseSync>): string {
    return sha256(JSON.stringify(normalize(schemaFacts(database))));
}

function openAtStage(stage: number): InstanceType<typeof DatabaseSync> {
    const database = new DatabaseSync(':memory:');
    database.exec('PRAGMA foreign_keys = ON');
    for (const entry of journal.entries.slice(0, stage + 1)) {
        database.exec(readFileSync(resolve(databaseRoot, 'drizzle', `${entry.tag}.sql`), 'utf8'));
    }
    return database;
}

describe('user upgrades a database through the committed migration contract', () => {
    it('user sees every frozen migration artifact keep its reviewed bytes', () => {
        for (const [relativePath, expectedHash] of Object.entries(baseline)) {
            const fullPath = resolve('..', '..', relativePath);
            expect(sha256(readFileSync(fullPath)), relativePath).toBe(expectedHash);
        }
    });

    it('user sees each migration stage keep its schema fingerprint', () => {
        for (const [stage, expected] of Object.entries(expectedFingerprints)) {
            const database = openAtStage(Number(stage));
            try {
                expect(fingerprint(database), `stage ${stage}`).toBe(expected);
            } finally {
                database.close();
            }
        }
    });

    it('user sees the latest migration chain retain its ordered tags', () => {
        expect(journal.entries.map((entry) => entry.tag)).toEqual([
            '0000_lyrical_toad',
            '0001_silent_reasoning',
            '0002_quick_search_click_stats_unique',
            '0003_tough_amazoness',
            '0004_ordinary_solo',
        ]);
    });
});
