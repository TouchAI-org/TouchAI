// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import {
    collectGateReport,
    isGateMessage,
} from '../../../scripts/ci/architecture/check-boundaries.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(testDirectory, '../../..');
const BOUNDARIES_CLI = path.resolve(
    testDirectory,
    '../../../scripts/ci/architecture/check-boundaries.mjs'
);
const CYCLES_CLI = path.resolve(testDirectory, '../../../scripts/ci/architecture/check-cycles.mjs');
const BOUNDARIES_DTS = path.resolve(
    testDirectory,
    '../../../scripts/ci/architecture/check-boundaries.d.mts'
);

const cleanup: string[] = [];

/**
 * Build a minimal project root the CLIs can lint without touching the real
 * source tree: a tsconfig alias map plus one view component.
 */
function createFixtureRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-cli-'));
    cleanup.push(root);
    fs.mkdirSync(path.join(root, 'src/views'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/services/Demo'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'tsconfig.json'),
        JSON.stringify(
            {
                compilerOptions: {
                    target: 'ES2020',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                    paths: {
                        '@/*': ['./src/*'],
                        '@services/*': ['./src/services/*'],
                        '@database': ['./src/database'],
                        '@database/*': ['./src/database/*'],
                    },
                },
                include: ['src/**/*.ts', 'src/**/*.vue'],
            },
            null,
            4
        )
    );
    fs.writeFileSync(path.join(root, 'src/views/Foo.ts'), 'export const Foo = 1;\n');
    return root;
}

function runCli(
    cli: string,
    args: string[]
): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: DESKTOP_ROOT,
        encoding: 'utf8',
        timeout: 30000,
    });
    expect(result.error).toBeUndefined();
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe('user runs the architecture CLI gate', () => {
    describe('given a lint result with a fatal parse error', () => {
        it('user sees the parse error counted instead of silently skipped', () => {
            const report = collectGateReport([
                {
                    filePath: 'src/x.ts',
                    messages: [
                        { fatal: true, ruleId: null, message: 'Parsing error', line: 1, column: 1 },
                    ],
                },
            ]);
            expect(report.errorCount).toBe(1);
            expect(report.lines[0]).toContain('[parse-error]');
        });
    });

    describe('given a lint result with a package-ban violation', () => {
        it('user sees the no-restricted-imports violation counted', () => {
            const report = collectGateReport([
                {
                    filePath: 'src/x.ts',
                    messages: [
                        {
                            ruleId: '@typescript-eslint/no-restricted-imports',
                            message: 'vue is banned',
                            line: 1,
                            column: 1,
                        },
                    ],
                },
            ]);
            expect(report.errorCount).toBe(1);
        });
    });

    describe('given a lint result with an unrelated rule violation', () => {
        it('user sees it excluded from the architecture gate', () => {
            const report = collectGateReport([
                {
                    filePath: 'src/x.ts',
                    messages: [{ ruleId: 'no-unused-vars', message: 'unused', line: 1, column: 1 }],
                },
            ]);
            expect(report.errorCount).toBe(0);
            expect(report.fileCount).toBe(0);
        });
    });

    it('user sees only the architecture and package rules admitted', () => {
        expect(isGateMessage({ ruleId: 'touchai/import-boundaries' })).toBe(true);
        expect(isGateMessage({ ruleId: '@typescript-eslint/no-restricted-imports' })).toBe(true);
        expect(isGateMessage({ ruleId: 'no-undef' })).toBe(false);
        expect(isGateMessage({ ruleId: null })).toBe(false);
        expect(isGateMessage({ fatal: true, ruleId: null })).toBe(true);
    });
});

describe('user runs the architecture CLIs as processes', () => {
    it('user sees the boundary declaration file shipped next to the CLI', () => {
        expect(fs.existsSync(BOUNDARIES_DTS)).toBe(true);
    });

    describe('given a service that imports the Vue UI layer', () => {
        it('user sees the boundary CLI exit non-zero and print the violation', () => {
            const root = createFixtureRoot();
            fs.writeFileSync(
                path.join(root, 'src/services/Demo/uiAlias.ts'),
                "import { Foo } from '@/views/Foo';\nexport const x = Foo;\n"
            );

            const result = runCli(BOUNDARIES_CLI, [
                '--project-root',
                root,
                '--targets',
                'src/services/Demo/uiAlias.ts',
            ]);

            expect(result.status).not.toBe(0);
            expect(result.stdout).toContain('views/Foo');
        });

        it('user sees the boundary CLI exit zero for a clean service', () => {
            const root = createFixtureRoot();
            fs.writeFileSync(
                path.join(root, 'src/services/Demo/uiAlias.ts'),
                'export const x = 1;\n'
            );

            const result = runCli(BOUNDARIES_CLI, [
                '--project-root',
                root,
                '--targets',
                'src/services/Demo/uiAlias.ts',
            ]);

            expect(result.status).toBe(0);
        });
    });

    describe('given a two-module runtime import cycle', () => {
        it('user sees the cycle CLI exit non-zero and print the cycle', () => {
            const root = createFixtureRoot();
            const srcRoot = path.join(root, 'src');
            fs.writeFileSync(
                path.join(srcRoot, 'a.ts'),
                "import { b } from './b';\nexport const a = b;\n"
            );
            fs.writeFileSync(
                path.join(srcRoot, 'b.ts'),
                "import { a } from './a';\nexport const b = a;\n"
            );

            const result = runCli(CYCLES_CLI, ['--project-root', root, '--src-root', srcRoot]);

            expect(result.status).not.toBe(0);
            expect(result.stdout).toContain('a -> b');
        });

        it('user sees the cycle CLI exit zero for an acyclic pair', () => {
            const root = createFixtureRoot();
            const srcRoot = path.join(root, 'src');
            fs.writeFileSync(
                path.join(srcRoot, 'a.ts'),
                "import { b } from './b';\nexport const a = b;\n"
            );
            fs.writeFileSync(path.join(srcRoot, 'b.ts'), 'export const b = 1;\n');

            const result = runCli(CYCLES_CLI, ['--project-root', root, '--src-root', srcRoot]);

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('No runtime cycles');
        });
    });
});
