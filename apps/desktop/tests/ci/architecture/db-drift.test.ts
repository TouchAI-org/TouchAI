// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
    checkArtifacts,
    checkGeneration,
    diffAgainstBaseline,
    hashArtifacts,
} from '../../../scripts/ci/architecture/check-db-drift.mjs';

const DRIZZLE_SQL = 'apps/desktop/src/database/drizzle/0000_init.sql';
const JOURNAL = 'apps/desktop/src/database/drizzle/meta/_journal.json';
const GUARDS = 'apps/desktop/src/database/artifacts/runtime/guards.sql';
const SEED = 'apps/desktop/src/database/artifacts/runtime/seed.sql';

const cleanup: string[] = [];

function writeFile(root: string, relativePath: string, content: string): void {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
}

function buildProject(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-dbdrift-'));
    cleanup.push(root);
    writeFile(root, 'apps/desktop/src/database/schema.ts', 'export {};\n');
    writeFile(root, DRIZZLE_SQL, 'CREATE TABLE t (id INTEGER);\n');
    writeFile(root, JOURNAL, '{ "entries": [] }\n');
    writeFile(root, GUARDS, 'SELECT 1;\n');
    writeFile(root, SEED, 'INSERT INTO t VALUES (1);\n');
    fs.mkdirSync(path.join(root, 'apps/desktop/node_modules'), { recursive: true });
    return root;
}

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe('user runs the database contract drift gate', () => {
    describe('given the committed migrations and SQL artifacts', () => {
        it('user sees a hash recorded for every contract artifact', () => {
            const root = buildProject();
            const hashes = hashArtifacts(root);
            expect(Object.keys(hashes).sort()).toEqual([DRIZZLE_SQL, GUARDS, JOURNAL, SEED].sort());
        });
    });

    describe('given a changed artifact against a recorded baseline', () => {
        it('user sees the drift reported as changed', () => {
            const root = buildProject();
            const baseline = hashArtifacts(root);
            writeFile(root, SEED, 'INSERT INTO t VALUES (2);\n');
            expect(diffAgainstBaseline(hashArtifacts(root), baseline).changed).toEqual([SEED]);
        });

        it('user sees a new artifact reported as added', () => {
            const root = buildProject();
            const baseline = hashArtifacts(root);
            writeFile(root, 'apps/desktop/src/database/artifacts/runtime/seed2.sql', 'SELECT 2;\n');
            expect(diffAgainstBaseline(hashArtifacts(root), baseline).added).toEqual([
                'apps/desktop/src/database/artifacts/runtime/seed2.sql',
            ]);
        });
    });

    describe('given a baseline file on disk', () => {
        it('user sees the gate pass when the artifacts match and fail when they drift', () => {
            const root = buildProject();
            const baselineFile = path.join(root, 'baseline.json');
            fs.writeFileSync(baselineFile, JSON.stringify(hashArtifacts(root)));

            const passing = checkArtifacts({ projectRoot: root, baselineFile });
            expect(passing.diff).toEqual({ added: [], removed: [], changed: [] });

            writeFile(root, GUARDS, 'SELECT 2;\n');
            const failing = checkArtifacts({ projectRoot: root, baselineFile });
            expect(failing.diff.changed).toEqual([GUARDS]);
        });
    });

    describe('given the generator runs in an out-of-tree copy', () => {
        it('user sees no drift when the generator emits nothing', () => {
            const root = buildProject();
            const result = checkGeneration({
                projectRoot: root,
                tmpRoot: root,
                runGenerate: () => 'no schema changes',
            });
            expect(result.failed).toBe(false);
            expect(result.diff).toEqual({ added: [], removed: [], changed: [] });
        });

        it('user sees drift when the generator emits a new migration', () => {
            const root = buildProject();
            const result = checkGeneration({
                projectRoot: root,
                tmpRoot: root,
                runGenerate: (work) => {
                    fs.writeFileSync(path.join(work, 'out', '0001_drift.sql'), '-- drift\n');
                    return 'generated';
                },
            });
            expect(result.diff.added).toEqual(['0001_drift.sql']);
        });

        it('user sees a failed generator run reported instead of a clean result', () => {
            const root = buildProject();
            const result = checkGeneration({
                projectRoot: root,
                tmpRoot: root,
                runGenerate: () => {
                    throw new Error('drizzle-kit exploded');
                },
            });
            expect(result.failed).toBe(true);
            expect(result.output).toContain('drizzle-kit exploded');
        });

        it('user sees the scratch copy removed after the check', () => {
            const root = buildProject();
            const before = fs
                .readdirSync(root)
                .filter((name) => name.startsWith('touchai-db-generate-'));
            checkGeneration({ projectRoot: root, tmpRoot: root, runGenerate: () => '' });
            const after = fs
                .readdirSync(root)
                .filter((name) => name.startsWith('touchai-db-generate-'));
            expect(after).toEqual(before);
        });
    });
});

const drizzleKitBin = path.resolve('node_modules/drizzle-kit/bin.cjs');

describe.skipIf(!fs.existsSync(drizzleKitBin))(
    'user runs the database generation gate against a seeded copy of the real schema',
    () => {
        function buildRealProject(): string {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-dbgen-'));
            cleanup.push(root);
            const databaseDir = path.join(root, 'apps/desktop/src/database');
            fs.mkdirSync(databaseDir, { recursive: true });
            fs.copyFileSync(
                path.resolve('src/database/schema.ts'),
                path.join(databaseDir, 'schema.ts')
            );
            fs.cpSync(path.resolve('src/database/drizzle'), path.join(databaseDir, 'drizzle'), {
                recursive: true,
            });
            fs.symlinkSync(
                path.resolve('node_modules'),
                path.join(root, 'apps/desktop/node_modules'),
                'dir'
            );
            return root;
        }

        it('user sees a clean result while schema.ts matches the committed migrations', () => {
            const result = checkGeneration({ projectRoot: buildRealProject() });
            expect(result.failed).toBe(false);
            expect(result.diff).toEqual({ added: [], removed: [], changed: [] });
        });

        it('user sees drift when a single schema.ts table is added', () => {
            const root = buildRealProject();
            const schemaPath = path.join(root, 'apps/desktop/src/database/schema.ts');
            fs.appendFileSync(
                schemaPath,
                "\nexport const driftProbe = sqliteTable('drift_probe', { id: integer('id').primaryKey() });\n"
            );

            const result = checkGeneration({ projectRoot: root });
            expect(result.failed).toBe(false);
            expect(result.diff.added.length).toBeGreaterThan(0);
        });
    }
);
