// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Database contract drift gate (no schema change).
 *
 * Two independent checks, both read-only against the worktree:
 *
 *   1. Artifact hash baseline. `schema.ts` is only the drizzle-kit input; the
 *      committed `drizzle/*.sql` + `drizzle/meta/*` and the runtime/import SQL
 *      artifacts (`guards.sql`, `seed.sql`, ...) are the contract other owners
 *      depend on. Any change to them needs explicit user approval and a
 *      migration plan, so the default check fails when a tracked artifact is
 *      added, removed or modified. Never run `db:generate` into the worktree.
 *
 *   2. Generation drift (`--generation`, runs in CI). Copies `schema.ts`, the
 *      committed `drizzle/` output and a node_modules symlink into an
 *      out-of-tree temp directory, runs `drizzle-kit generate` there, and fails
 *      if the generator would emit a new migration. A red result means
 *      `schema.ts` no longer matches the committed migration history; it does
 *      not write anything into the worktree.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT } from './boundaries.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(HERE, 'db-artifacts-baseline.json');
const DRIZZLE_DIR = 'apps/desktop/src/database/drizzle';
const SCHEMA_FILE = 'apps/desktop/src/database/schema.ts';

/** Directories whose contents are the reviewed database contract. */
export const ARTIFACT_ROOTS = [
    'apps/desktop/src/database/drizzle',
    'apps/desktop/src/database/artifacts',
];

function toPosixPath(value) {
    return value.split(path.sep).join('/');
}

function walkFiles(root) {
    if (!fs.existsSync(root)) return [];
    const files = [];
    const stack = [root];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) files.push(full);
        }
    }
    return files.sort();
}

function hashOf(file) {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {string} [projectRoot]
 * @returns {Record<string, string>} repo-relative path -> sha256
 */
export function hashArtifacts(projectRoot = PROJECT_ROOT) {
    const result = {};
    for (const root of ARTIFACT_ROOTS) {
        for (const file of walkFiles(path.join(projectRoot, root))) {
            result[toPosixPath(path.relative(projectRoot, file))] = hashOf(file);
        }
    }
    return result;
}

/**
 * @param {Record<string, string>} current
 * @param {Record<string, string>} baseline
 * @returns {{ added: string[], removed: string[], changed: string[] }}
 */
export function diffAgainstBaseline(current, baseline) {
    const added = Object.keys(current)
        .filter((key) => !(key in baseline))
        .sort();
    const removed = Object.keys(baseline)
        .filter((key) => !(key in current))
        .sort();
    const changed = Object.keys(current)
        .filter((key) => key in baseline && current[key] !== baseline[key])
        .sort();
    return { added, removed, changed };
}

function readBaseline(file) {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function checkArtifacts({ projectRoot = PROJECT_ROOT, baselineFile = BASELINE_PATH } = {}) {
    const current = hashArtifacts(projectRoot);
    const baseline = readBaseline(baselineFile);
    return { current, baseline, diff: diffAgainstBaseline(current, baseline) };
}

function copyTree(source, target) {
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
        const from = path.join(source, entry.name);
        const to = path.join(target, entry.name);
        if (entry.isDirectory()) copyTree(from, to);
        else fs.copyFileSync(from, to);
    }
}

function defaultRunGenerate(work, nodeModules) {
    const drizzleKit = path.join(nodeModules, 'drizzle-kit/bin.cjs');
    return execFileSync(
        process.execPath,
        [
            '--max-old-space-size=1024',
            drizzleKit,
            'generate',
            '--config',
            path.join(work, 'drizzle.config.ts'),
        ],
        { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
}

/**
 * Generation drift check. Writes only under `tmpRoot` (default the OS temp
 * dir), never into the worktree. `runGenerate` is injectable so the guard test
 * can exercise the comparison without invoking drizzle-kit.
 *
 * @param {{ projectRoot?: string, tmpRoot?: string, runGenerate?: (work: string, nodeModules: string) => string }} [options]
 */
export function checkGeneration({
    projectRoot = PROJECT_ROOT,
    tmpRoot,
    runGenerate = defaultRunGenerate,
} = {}) {
    const work = fs.mkdtempSync(path.join(tmpRoot ?? os.tmpdir(), 'touchai-db-generate-'));

    try {
        const schemaDir = path.join(work, 'schema');
        const outDir = path.join(work, 'out');
        fs.mkdirSync(schemaDir, { recursive: true });
        fs.copyFileSync(path.join(projectRoot, SCHEMA_FILE), path.join(schemaDir, 'schema.ts'));
        copyTree(path.join(projectRoot, DRIZZLE_DIR), outDir);

        const nodeModules = path.join(projectRoot, 'apps/desktop/node_modules');
        fs.symlinkSync(nodeModules, path.join(work, 'node_modules'), 'dir');

        fs.writeFileSync(
            path.join(work, 'drizzle.config.ts'),
            [
                "import { defineConfig } from 'drizzle-kit';",
                'export default defineConfig({',
                "    schema: './schema/schema.ts',",
                "    out: './out',",
                "    dialect: 'sqlite',",
                '});',
                '',
            ].join('\n')
        );

        const before = {};
        for (const file of walkFiles(outDir)) {
            before[toPosixPath(path.relative(outDir, file))] = hashOf(file);
        }

        let output = '';
        let failed = false;
        try {
            output = runGenerate(work, nodeModules);
        } catch (error) {
            failed = true;
            output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
        }

        const after = {};
        for (const file of walkFiles(outDir)) {
            after[toPosixPath(path.relative(outDir, file))] = hashOf(file);
        }

        return { output, failed, diff: diffAgainstBaseline(after, before) };
    } finally {
        // Remove the temp copy this call created; a generator log is returned to
        // the caller instead of being left behind as another stray directory.
        fs.rmSync(work, { recursive: true, force: true });
    }
}

const isMain =
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
    const args = process.argv.slice(2);
    if (args.includes('--write-baseline')) {
        const current = hashArtifacts();
        fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 4)}\n`);
        process.stdout.write(
            `Wrote ${Object.keys(current).length} artifact hashes to ${BASELINE_PATH}\n`
        );
        process.exit(0);
    }

    let failed = false;

    const { diff } = checkArtifacts();
    const changed = diff.added.length + diff.removed.length + diff.changed.length;
    if (changed === 0) {
        process.stdout.write('Database artifacts match the approved baseline.\n');
    } else {
        failed = true;
        process.stdout.write(
            `Database artifact drift detected (${changed} file(s)). A schema/migration/seed change needs explicit user approval and a migration plan; do not edit these files or run db:generate in the worktree.\n`
        );
        for (const key of diff.added) process.stdout.write(`  added:   ${key}\n`);
        for (const key of diff.removed) process.stdout.write(`  removed: ${key}\n`);
        for (const key of diff.changed) process.stdout.write(`  changed: ${key}\n`);
    }

    if (args.includes('--generation')) {
        const result = checkGeneration();
        const generated =
            result.diff.added.length + result.diff.removed.length + result.diff.changed.length;
        if (result.failed) {
            failed = true;
            process.stdout.write('drizzle-kit generate failed:\n');
            process.stdout.write(`${result.output}\n`);
        } else if (generated === 0) {
            process.stdout.write(
                'drizzle-kit generate produced no new migration; schema.ts matches the committed history.\n'
            );
        } else {
            failed = true;
            process.stdout.write(
                `schema.ts drifted from the committed migrations (${generated} generated file change(s)):\n`
            );
            for (const key of result.diff.added) process.stdout.write(`  added:   ${key}\n`);
            for (const key of result.diff.removed) process.stdout.write(`  removed: ${key}\n`);
            for (const key of result.diff.changed) process.stdout.write(`  changed: ${key}\n`);
        }
    }

    process.exitCode = failed ? 1 : 0;
}
