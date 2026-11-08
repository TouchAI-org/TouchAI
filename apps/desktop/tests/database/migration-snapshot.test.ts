import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import * as schema from '@database/schema';
import type { DrizzleSQLiteSnapshotJSON } from 'drizzle-kit/api';
import { describe, expect, it } from 'vitest';

const { generateSQLiteDrizzleJson, generateSQLiteMigration } = createRequire(import.meta.url)(
    'drizzle-kit/api'
) as typeof import('drizzle-kit/api');

describe('given the shipped database schema has not changed', () => {
    it('user can prepare the next upgrade without recreating existing tables or columns', async () => {
        const journal = JSON.parse(
            readFileSync('src/database/drizzle/meta/_journal.json', 'utf8')
        ) as {
            entries: Array<{ idx: number }>;
        };
        const index = String(journal.entries[journal.entries.length - 1]!.idx).padStart(4, '0');
        const snapshot = JSON.parse(
            readFileSync(`src/database/drizzle/meta/${index}_snapshot.json`, 'utf8').replace(
                /^\uFEFF/,
                ''
            )
        ) as DrizzleSQLiteSnapshotJSON;
        const current = await generateSQLiteDrizzleJson(schema, snapshot.id);
        expect(await generateSQLiteMigration(snapshot, current)).toEqual([]);
    });
});
