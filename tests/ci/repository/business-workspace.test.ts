import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { readWorkflow, runClassifier } from '../workflows/workflow-test-helpers';

const root = new URL('../../../', import.meta.url);
async function manifest(path: string) {
    return JSON.parse(await readFile(new URL(path, root), 'utf8')) as {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
    };
}

describe('given the two extracted packages are production workspace dependencies', () => {
    it('user installs Desktop and receives both current workspace packages in the frozen lockfile', async () => {
        const desktop = await manifest('apps/desktop/package.json');
        const lock = parse(await readFile(new URL('pnpm-lock.yaml', root), 'utf8'));
        for (const name of ['agent-core', 'models']) {
            expect(desktop.dependencies[`@touchai/${name}`]).toBe('workspace:*');
            expect(lock.importers['apps/desktop'].dependencies[`@touchai/${name}`].version).toBe(
                `link:../../packages/${name}`
            );
            const pkg = await manifest(`packages/${name}/package.json`);
            for (const [dependency, specifier] of Object.entries(pkg.dependencies)) {
                expect(lock.importers[`packages/${name}`].dependencies[dependency].specifier).toBe(
                    specifier
                );
            }
        }
    });
    it('user runs workspace quality checks and both package types plus the actual source gate are required', async () => {
        const { scripts } = await manifest('package.json');
        expect(scripts['type:check']).toContain('type:check:packages');
        expect(scripts['test:typecheck']).toContain('test:typecheck:packages');
        expect(scripts['check:architecture']).toContain('tooling/architecture/check.mjs');
        expect(scripts['test:pr']).toContain('check:architecture');
        expect(scripts.build).toContain('build:packages');
    });
    it.each([
        'packages/agent-core/src/create.ts',
        'packages/models/src/providers/openai.ts',
        'tooling/architecture/check.mjs',
        'tests/ci/architecture/repository.test.ts',
    ])('user changes %s and receives required Desktop validation', async (filename) => {
        const result = await runClassifier('ci.yml', {
            eventName: 'pull_request',
            pullRequestNumber: 710,
            payload: { pull_request: { number: 710, changed_files: 1 } },
            listFilePages: [[{ status: 'modified', filename }]],
        });
        expect(result.outputs).toMatchObject({ docs_only: 'false', desktop_changed: 'true' });
    });
    it('user runs required CI and checks the actual repository graph before the architecture fixtures', () => {
        const workflow = readWorkflow('ci.yml');
        const steps = workflow.jobs['ci-tests']!.steps;
        const gate = steps.findIndex((step) => step.run === 'pnpm check:architecture');
        const tests = steps.findIndex((step) => step.run === 'pnpm test:ci');
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(tests);
    });
    it.each([
        ['area:agent-service', 'packages/agent-core/src/index.ts'],
        ['area:agent-service', 'packages/models/src/providers/openai.ts'],
        ['area:agent-service', 'apps/desktop/src/modules/agent/contracts/history.ts'],
        ['area:mcp', 'apps/desktop/src/modules/tools/mcp/create.io.ts'],
    ])('user sees the existing %s area label when changing %s', async (area, filename) => {
        const rules = parse(await readFile(new URL('.github/labeler.yml', root), 'utf8')) as Record<
            string,
            { 'changed-files': { 'any-glob-to-any-file': string[] }[] }[]
        >;
        const patterns = rules[area]?.flatMap((rule) =>
            rule['changed-files'].flatMap((match) => match['any-glob-to-any-file'])
        );
        expect(patterns?.some((pattern) => posix.matchesGlob(filename, pattern))).toBe(true);
    });
    it('user receives coverage for executed and untouched code in Desktop and both packages when running frontend checks', async () => {
        const base = (await import('../../../apps/desktop/vitest.config')).default;
        const fixture = await mkdtemp(join(tmpdir(), 'touchai-workspace-coverage-'));
        const desktop = join(fixture, 'apps/desktop');
        const owners = [
            desktop,
            join(fixture, 'packages/agent-core'),
            join(fixture, 'packages/models'),
        ];
        try {
            for (const owner of owners) {
                await mkdir(join(owner, 'src'), { recursive: true });
                await mkdir(join(owner, 'tests'), { recursive: true });
                for (const name of ['used', 'untouched']) {
                    await writeFile(
                        join(owner, 'src', `${name}.ts`),
                        'export const value = () => 11;\n'
                    );
                }
                await writeFile(
                    join(owner, 'tests/value.test.ts'),
                    [
                        "import { value } from '../src/used';",
                        "it('user reads the value from this owner', () => expect(value()).toBe(11));",
                    ].join('\n')
                );
            }
            await mkdir(join(desktop, 'tests/setup'));
            await writeFile(join(desktop, 'tests/setup/vitest.ts'), 'export {};\n');
            await symlink(
                fileURLToPath(new URL('apps/desktop/node_modules', root)),
                join(desktop, 'node_modules'),
                'junction'
            );
            const config = join(fixture, 'vitest.config.mjs');
            const reportsDirectory = join(fixture, 'report');
            await writeFile(
                config,
                `export default ${JSON.stringify({
                    root: desktop,
                    cacheDir: join(fixture, 'cache'),
                    test: {
                        globals: true,
                        projects: base.test?.projects,
                        coverage: { ...base.test?.coverage, reportsDirectory, reporter: ['json'] },
                    },
                })};\n`
            );
            const cli = fileURLToPath(
                new URL('vitest.mjs', import.meta.resolve('vitest/package.json'))
            );
            const run = spawnSync(
                process.execPath,
                [
                    cli,
                    'run',
                    '--config',
                    config,
                    '--configLoader',
                    'runner',
                    '--coverage',
                    '--maxWorkers=1',
                    '--no-file-parallelism',
                ],
                { cwd: desktop, encoding: 'utf8', timeout: 25_000 }
            );
            expect(run.error).toBeUndefined();
            expect(run.status, run.stderr).toBe(1);
            expect(run.stderr).toMatch(/Coverage for lines \(50%\) does not meet global threshold/);
            const report: Record<string, { s: Record<string, number> }> = JSON.parse(
                await readFile(join(reportsDirectory, 'coverage-final.json'), 'utf8')
            );
            const statements = new Map(
                Object.entries(report).map(([path, entry]) => [
                    resolve(path),
                    Object.values(entry.s),
                ])
            );
            for (const owner of owners) {
                for (const name of ['used', 'untouched']) {
                    const counts = statements.get(join(owner, 'src', `${name}.ts`)) ?? [];
                    expect(counts.length).toBeGreaterThan(0);
                    expect(
                        counts.every((count) => (name === 'used' ? count > 0 : count === 0))
                    ).toBe(true);
                }
            }
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    }, 30_000);
});
