// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
    canonicalizeStartupCaches,
    deleteStartupBookkeeping,
} from '../../../scripts/perf/710/fixture-database.mjs';

const { DatabaseSync } = createRequire(import.meta.url)(
    'node:sqlite'
) as typeof import('node:sqlite');

const databases: SqliteDatabase[] = [];

function openDatabase(): SqliteDatabase {
    const database = new DatabaseSync(':memory:');
    database.exec(`
        CREATE TABLE llm_metadata (
            id INTEGER PRIMARY KEY,
            model_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL
        );
        CREATE TABLE llm_metadata_aliases (
            alias TEXT PRIMARY KEY,
            model_id TEXT NOT NULL
        );
        CREATE TABLE statistics (
            id INTEGER PRIMARY KEY,
            key TEXT NOT NULL,
            value TEXT
        );
    `);
    databases.push(database);
    return database;
}

afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
});

describe('user freezes equivalent RFC 710 startup caches', () => {
    it('user sees both measured arms use the baseline bundled model metadata', () => {
        const baseline = openDatabase();
        const current = openDatabase();
        baseline.exec(`
            INSERT INTO llm_metadata (id, model_id, name) VALUES (1, 'model-a', 'Model A');
            INSERT INTO llm_metadata_aliases (alias, model_id) VALUES ('alias-a', 'model-a');
        `);
        current.exec(`
            INSERT INTO llm_metadata (id, model_id, name) VALUES (99, 'stale', 'Stale');
        `);

        const copied = canonicalizeStartupCaches(baseline, current);

        expect(copied).toEqual({ llm_metadata: 1, llm_metadata_aliases: 1 });
        expect(current.prepare('SELECT * FROM llm_metadata ORDER BY id').all()).toEqual(
            baseline.prepare('SELECT * FROM llm_metadata ORDER BY id').all()
        );
        expect(current.prepare('SELECT * FROM llm_metadata_aliases ORDER BY alias').all()).toEqual(
            baseline.prepare('SELECT * FROM llm_metadata_aliases ORDER BY alias').all()
        );
    });

    it('user cannot benchmark before the baseline metadata cache has settled', () => {
        const baseline = openDatabase();
        const current = openDatabase();

        expect(() => canonicalizeStartupCaches(baseline, current)).toThrow(
            'Baseline model metadata cache did not settle before fixture capture'
        );
    });

    it('user does not compare usage-maintenance bookkeeping as business data', () => {
        const baseline = openDatabase();
        const current = openDatabase();
        current.exec(`
            INSERT INTO statistics (key, value) VALUES ('usage_maintenance_run_at', '2026-11-09T18:31:54.474Z');
        `);

        deleteStartupBookkeeping(baseline);
        deleteStartupBookkeeping(current);

        expect(current.prepare('SELECT COUNT(*) AS count FROM statistics').get()).toEqual({
            count: 0,
        });
    });
});
