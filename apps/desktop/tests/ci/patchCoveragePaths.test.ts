import { execFileSync, spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { measurePatchCoverage } from '../../scripts/ci/coverage/patch-coverage.mjs';

const sourcePath = 'apps/desktop/src/feature.ts';
const changed = new Map([[sourcePath, new Set([2])]]);

function coverageFor(hits = 1, line = 2) {
    return {
        statementMap: {
            0: { start: { line, column: 0 }, end: { line, column: 23 } },
        },
        s: { 0: hits },
        branchMap: {},
        b: {},
    };
}

function shortWindowsPath(path: string) {
    if (process.platform !== 'win32') {
        return path;
    }

    // Quote the path inside a batch file. Passing it as a command argument
    // loses the quotes, while a script keeps spaces in a single item.
    const directory = mkdtempSync(join(tmpdir(), 'short-path-'));
    const script = join(directory, 'short-path.cmd');
    writeFileSync(script, `@echo off\r\nfor %%I in ("${path}") do @echo %%~sI\r\n`);

    try {
        return execFileSync('cmd.exe', ['/d', '/c', script], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
}

describe('user measures covered changes with absolute report paths', () => {
    it.each([
        ['/checkout/repo', '/checkout/repo/apps/desktop/src/feature.ts'],
        ['C:\\checkout\\repo', 'C:\\checkout\\repo\\apps\\desktop\\src\\feature.ts'],
    ])('user gets full coverage when the repository root is %s', (repoRoot, file) => {
        const result = measurePatchCoverage(changed, { [file]: coverageFor() }, { repoRoot });

        expect(result).toMatchObject({ total: 1, covered: 1, percent: 100 });
    });

    it('user gets full coverage when the current repository directory is the root', () => {
        const file = resolve(sourcePath);
        const result = measurePatchCoverage(changed, { [file]: coverageFor() }, { repoRoot: '.' });

        expect(result).toMatchObject({ total: 1, covered: 1, percent: 100 });
    });

    it('user still gets a failed gate when the matching statement did not run', () => {
        const result = measurePatchCoverage(
            changed,
            { '/checkout/repo/apps/desktop/src/feature.ts': coverageFor(0) },
            { repoRoot: '/checkout/repo' }
        );

        expect(result).toMatchObject({ total: 1, covered: 0, percent: 0 });
    });

    it('user does not count coverage from a different checkout as covering a missing file', () => {
        const result = measurePatchCoverage(
            changed,
            { '/other/repo/apps/desktop/src/feature.ts': coverageFor() },
            { repoRoot: '/checkout/repo' }
        );

        expect(result).toMatchObject({ total: 1, covered: 0, percent: 0 });
    });

    it('user gets full coverage when a report path is another name for the checkout', (ctx) => {
        // tmpdir() already returns the 8.3 form on some Windows runners, so
        // start from the long spelling and shorten the checkout for the report.
        const longRoot =
            process.platform === 'win32'
                ? join(process.env.USERPROFILE ?? tmpdir(), 'AppData', 'Local', 'Temp')
                : tmpdir();
        const temporaryRoot = existsSync(longRoot) ? realpathSync.native(longRoot) : tmpdir();
        const checkout = mkdtempSync(join(temporaryRoot, 'patch-coverage-alias-'));
        let junction: string | null = null;

        try {
            const file = join(checkout, sourcePath);
            mkdirSync(join(checkout, 'apps/desktop/src'), { recursive: true });
            writeFileSync(file, 'export const added = 2;\n');
            let reportRoot = shortWindowsPath(checkout);

            // 8.3 names can be disabled per volume. Fall back to a junction,
            // which is another spelling for the same directory without it.
            if (process.platform === 'win32' && reportRoot === checkout) {
                junction = `${checkout}-junction`;

                try {
                    symlinkSync(checkout, junction, 'junction');
                } catch {
                    ctx.skip('this Windows volume provides no 8.3 or junction alias');
                }

                reportRoot = junction;
            }

            if (process.platform === 'win32') {
                expect(reportRoot).not.toBe(checkout);
            }
            expect(existsSync(reportRoot)).toBe(true);

            const result = measurePatchCoverage(
                new Map([[sourcePath, new Set([2])]]),
                { [join(reportRoot, sourcePath)]: coverageFor() },
                { repoRoot: checkout }
            );

            expect(result).toMatchObject({ total: 1, covered: 1, percent: 100 });
        } finally {
            if (junction && existsSync(junction)) {
                rmdirSync(junction);
            }
            rmSync(checkout, { recursive: true, force: true });
        }
    }, 15000);
});

describe('user runs the patch coverage command in a checkout', () => {
    it.each([
        ['.', 1, true, 0, '3/3 changed lines covered (100.00%)'],
        ['apps/desktop', 1, true, 0, '3/3 changed lines covered (100.00%)'],
        ['.', 0, true, 1, '2/3 changed lines covered (66.67%)'],
        ['apps/desktop', 0, true, 1, '2/3 changed lines covered (66.67%)'],
        ['.', 1, false, 1, '1/3 changed lines covered (33.33%)'],
        ['apps/desktop', 1, false, 1, '1/3 changed lines covered (33.33%)'],
    ] as const)(
        'user runs patch coverage from %s with %i tracked hits and new package coverage %s, then receives status %i',
        (directory, hits, packagesCovered, expectedStatus, expectedSummary) => {
            const cli = resolve('scripts/ci/coverage/patch-coverage-cli.mjs');
            const checkout = mkdtempSync(join(tmpdir(), 'patch-coverage-paths-'));
            const git = (...args: string[]) =>
                execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: 'pipe' });

            try {
                const source = join(checkout, sourcePath);
                mkdirSync(join(checkout, 'apps/desktop/src'), { recursive: true });
                writeFileSync(source, 'export const initial = 1;\n');
                git('init');
                git('add', '--', sourcePath);
                git(
                    '-c',
                    'user.name=Test Fixture',
                    '-c',
                    'user.email=fixture@example.com',
                    'commit',
                    '-m',
                    'test: initialize coverage fixture'
                );
                const base = git('rev-parse', 'HEAD').trim();
                writeFileSync(source, 'export const initial = 1;\nexport const added = 2;\n');
                const entries = { [source]: coverageFor(hits) };
                const newSources = ['agent-core', 'models'].map((name) => {
                    const directory = `packages/${name}/src`;
                    mkdirSync(join(checkout, directory), { recursive: true });
                    const path = `${directory}/new source.ts`;
                    const file = join(checkout, path);
                    writeFileSync(
                        file,
                        `export const value = 2;${name === 'models' ? '\r\n' : ''}`
                    );
                    if (packagesCovered) entries[file] = coverageFor(1, 1);
                    return path;
                });
                writeFileSync(join(checkout, 'packages/.gitignore'), 'ignored.ts\n');
                writeFileSync(
                    join(checkout, 'packages/models/src/ignored.ts'),
                    'export const ignored = 3;\n'
                );
                const report = join(checkout, 'coverage-final.json');
                writeFileSync(report, JSON.stringify(entries));
                const status = () => git('status', '--porcelain=v1', '--untracked-files=all');
                const before = status();

                const result = spawnSync(
                    process.execPath,
                    [cli, '--coverage', report, '--base', base, '--root', '.', '--floor', '85'],
                    { cwd: join(checkout, directory), encoding: 'utf8' }
                );

                expect(result.status, result.stderr).toBe(expectedStatus);
                expect(result.stdout).toContain(expectedSummary);
                for (const file of newSources) expect(result.stdout).toContain(file);
                expect(result.stdout).not.toContain('ignored.ts');
                expect(status()).toBe(before);
            } finally {
                rmSync(checkout, { recursive: true, force: true });
            }
        }
    );
});
