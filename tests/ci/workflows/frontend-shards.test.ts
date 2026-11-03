import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { truthy } from '@actions/expressions/result';
import { afterEach, describe, expect, it } from 'vitest';

import {
    evaluateExpression,
    readWorkflow,
    type Workflow,
    type WorkflowJob,
    type WorkflowStep,
} from './workflow-test-helpers';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');
const shardCheckerPath = resolve(repositoryRoot, '.github/scripts/assert-frontend-shards.mjs');

const checkoutAction = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1';
const pnpmAction = 'pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413';
const nodeAction = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020';
const uploadAction = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
const downloadAction = 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333';
const shardJobId = 'frontend-test-shards';
const aggregateJobId = 'frontend-tests';

const shardCommand =
    'pnpm --filter @touchai/desktop exec vitest run --config vitest.ci-shard.config.ts --configLoader runner --coverage --shard=${{ matrix.shard }}/3 --reporter=default --reporter=blob';
const mergeCommand =
    'pnpm --filter @touchai/desktop exec vitest --config vitest.config.ts --configLoader runner --merge-reports=.vitest-reports --coverage';

interface ShardMatrix {
    'fail-fast'?: unknown;
    matrix?: {
        shard?: unknown;
    };
}

interface DispatchableJob extends WorkflowJob {
    strategy?: ShardMatrix;
    'runs-on'?: unknown;
    'continue-on-error'?: unknown;
}

const originalThresholds = {
    statements: 90,
    branches: 84,
    functions: 88,
    lines: 91,
    'src/services/EventService/**/*.ts': {
        statements: 90,
        branches: 100,
        functions: 100,
        lines: 90,
    },
    'src/services/NativeService/**/*.ts': {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
    },
    'src/services/BuiltInToolService/tools/browser/**/*.ts': {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
    },
    'src/views/SettingsView/components/BuiltInTools/browserToolGroup.ts': {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
    },
    'src/views/SearchView/components/QuickSearchPanel/composables/**/*.ts': {
        statements: 75,
        branches: 65,
        functions: 75,
        lines: 80,
    },
    'src/utils/searchHighlight.ts': {
        statements: 95,
        branches: 60,
        functions: 100,
        lines: 95,
    },
    'src/views/SearchView/components/SearchBar/composables/**/*.ts': {
        statements: 70,
        branches: 50,
        functions: 75,
        lines: 72,
    },
    'src/views/SearchView/composables/useSearchInput.ts': {
        statements: 90,
        branches: 75,
        functions: 100,
        lines: 90,
    },
    'src/views/SearchView/composables/useSearchRequest.ts': {
        statements: 60,
        branches: 45,
        functions: 50,
        lines: 60,
    },
    'src/views/SearchView/utils/clipboardDraft.ts': {
        statements: 95,
        branches: 75,
        functions: 100,
        lines: 95,
    },
} as const;

const temporaryDirectories: string[] = [];

function ciWorkflow() {
    return readWorkflow('ci.yml');
}

function job(workflow: Workflow, jobId: string) {
    const selected = workflow.jobs[jobId] as DispatchableJob | undefined;

    if (selected === undefined) {
        throw new Error(`Workflow job ${jobId} is missing.`);
    }

    return selected;
}

function step(jobValue: DispatchableJob, name: string) {
    const selected = jobValue.steps.find((candidate) => candidate.name === name);

    if (selected === undefined) {
        throw new Error(`Workflow step ${name} is missing.`);
    }

    return selected;
}

function actionStep(jobValue: DispatchableJob, action: string) {
    return jobValue.steps.find((candidate) => candidate.uses === action);
}

function normalizedCommand(runValue: string | undefined) {
    return (runValue ?? '').trim().replace(/\s+/g, ' ');
}

function needs(jobValue: DispatchableJob) {
    if (jobValue.needs === undefined) {
        return [];
    }

    return Array.isArray(jobValue.needs) ? jobValue.needs : [jobValue.needs];
}

function source(value: unknown, label: string) {
    if (typeof value !== 'string') {
        throw new Error(`${label} must be a string.`);
    }

    return value;
}

function stepIndex(jobValue: DispatchableJob, actionOrName: string) {
    const selected = jobValue.steps.findIndex(
        (candidate) => candidate.uses === actionOrName || candidate.name === actionOrName
    );

    if (selected < 0) {
        throw new Error(`Workflow action or step ${actionOrName} is missing.`);
    }

    return selected;
}

function runCommands(jobValue: DispatchableJob) {
    return jobValue.steps
        .map((candidate) => normalizedCommand(candidate.run))
        .filter((command) => command.length > 0);
}

function workflowCondition(jobValue: DispatchableJob, context: Record<string, unknown>) {
    return truthy(evaluateExpression(source(jobValue.if, `${jobValue.name} condition`), context));
}

function conditionWithoutAlways(jobValue: DispatchableJob) {
    return source(jobValue.if, `${jobValue.name} condition`)
        .replace(/^\s*always\(\)\s*&&\s*/, '')
        .replace(/^\s*\(([\s\S]*)\)\s*$/, '$1')
        .trim();
}

let cachedBash: string | undefined;

function gitBashExecutable() {
    if (process.platform !== 'win32') {
        return 'bash';
    }

    if (cachedBash !== undefined) {
        return cachedBash;
    }

    const gitExecPath = spawnSync('git', ['--exec-path'], {
        encoding: 'utf8',
        env: process.env,
        windowsHide: true,
    });

    if (gitExecPath.error || gitExecPath.status !== 0) {
        throw new Error(`Unable to locate Git for Windows: ${gitExecPath.stderr}`);
    }

    const gitRoot = resolve(gitExecPath.stdout.trim(), '../../..');
    const candidates = [resolve(gitRoot, 'bin/bash.exe'), resolve(gitRoot, 'usr/bin/bash.exe')];
    const bash = candidates.find((candidate) => existsSync(candidate));

    if (bash === undefined) {
        throw new Error(`Unable to locate Git Bash; checked ${candidates.join(', ')}.`);
    }

    cachedBash = bash;
    return bash;
}

function runShardResultGate(result: string | undefined) {
    const workflow = ciWorkflow();
    const aggregate = job(workflow, aggregateJobId);
    const environment: NodeJS.ProcessEnv = {
        ...process.env,
        LC_ALL: 'C',
    };

    if (result === undefined) {
        delete environment.SHARDS_RESULT;
    } else {
        environment.SHARDS_RESULT = result;
    }

    const execution = spawnSync(
        gitBashExecutable(),
        ['--noprofile', '--norc', '-c', source(aggregate.steps[0]?.run, 'shard result gate')],
        {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: environment,
            timeout: 10_000,
            windowsHide: true,
        }
    );

    if (execution.error) {
        throw execution.error;
    }

    return {
        status: execution.status,
        output: `${execution.stdout}${execution.stderr}`,
    };
}

async function createShardDirectory({
    count = 3,
    extras = [],
    files = [1, 2, 3],
}: {
    count?: number;
    extras?: string[];
    files?: number[];
} = {}) {
    const root = await mkdtemp(join(tmpdir(), 'touchai-frontend-shards-'));
    temporaryDirectories.push(root);

    for (const index of files) {
        await writeFile(join(root, `blob-${index}-${count}.json`), '{}', 'utf8');
    }

    for (const extra of extras) {
        await writeFile(join(root, extra), '{}', 'utf8');
    }

    return root;
}

function runShardChecker(directory: string, count: string) {
    const execution = spawnSync(process.execPath, [shardCheckerPath, directory, count], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
    });

    if (execution.error) {
        throw execution.error;
    }

    return {
        status: execution.status,
        output: `${execution.stdout}${execution.stderr}`,
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('user splits frontend tests into native report shards', () => {
    it('user sees three independent shards run when a desktop change is not docs-only', () => {
        const workflow = ciWorkflow();
        const shards = job(workflow, shardJobId);
        const strategy = shards.strategy;

        expect(shards.name).toBe('Frontend Tests (Shard ${{ matrix.shard }}/3)');
        expect(shards['runs-on']).toBe('ubuntu-latest');
        expect(needs(shards)).toEqual(['changes']);
        expect(strategy?.['fail-fast']).toBe(false);
        expect(strategy?.matrix?.shard).toEqual([1, 2, 3]);
        expect(conditionWithoutAlways(shards)).toBe(
            "needs.changes.outputs.docs_only != 'true' && needs.changes.outputs.desktop_changed == 'true'"
        );
    });

    it.each([
        {
            scenario: 'a desktop change is not docs-only',
            docsOnly: 'false',
            desktopChanged: 'true',
            selected: true,
            outcome: 'run',
        },
        {
            scenario: 'the change is docs-only',
            docsOnly: 'true',
            desktopChanged: 'true',
            selected: false,
            outcome: 'skip',
        },
        {
            scenario: 'no desktop files changed',
            docsOnly: 'false',
            desktopChanged: 'false',
            selected: false,
            outcome: 'skip',
        },
    ])(
        'user sees frontend shards $outcome when $scenario',
        ({ docsOnly, desktopChanged, selected }) => {
            const shards = job(ciWorkflow(), shardJobId);
            const result = workflowCondition(shards, {
                needs: {
                    changes: {
                        outputs: {
                            docs_only: docsOnly,
                            desktop_changed: desktopChanged,
                        },
                    },
                },
            });

            expect(result).toBe(selected ? true : false);
        }
    );

    it('user sees every shard run the complete native coverage command without shortcuts', () => {
        const shards = job(ciWorkflow(), shardJobId);
        const commands = runCommands(shards).filter((command) => command.includes('vitest'));

        expect(commands).toEqual([shardCommand]);
        expect(commands[0]).not.toContain('passWithNoTests');
        expect(commands[0]).not.toContain('retry');
        expect(commands[0]).not.toContain('no-isolate');
    });

    it('user sees package setup and cached Node installation precede frozen dependency restore', () => {
        const shards = job(ciWorkflow(), shardJobId);
        const checkoutIndex = stepIndex(shards, checkoutAction);
        const pnpmIndex = stepIndex(shards, pnpmAction);
        const nodeIndex = stepIndex(shards, nodeAction);
        const installIndex = stepIndex(shards, 'Install dependencies');
        const checkout = actionStep(shards, checkoutAction);
        const node = actionStep(shards, nodeAction);

        expect(checkoutIndex).toBeLessThan(pnpmIndex);
        expect(pnpmIndex).toBeLessThan(nodeIndex);
        expect(nodeIndex).toBeLessThan(installIndex);
        expect(checkout?.with).toMatchObject({
            ref: '${{ github.event.pull_request.head.sha || github.sha }}',
            'persist-credentials': false,
        });
        expect(node?.with).toMatchObject({ 'node-version': 22, cache: 'pnpm' });
        expect(normalizedCommand(step(shards, 'Install dependencies').run)).toBe(
            'pnpm install --frozen-lockfile'
        );
    });

    it('user sees each shard upload its exact hidden native report on every uncancelled result', () => {
        const shards = job(ciWorkflow(), shardJobId);
        const upload = actionStep(shards, uploadAction);

        expect(upload).toBeDefined();
        expect(upload?.if).toBe('${{ !cancelled() }}');
        expect(upload?.with).toEqual({
            name: 'frontend-shard-${{ matrix.shard }}',
            path: 'apps/desktop/.vitest-reports/blob-${{ matrix.shard }}-3.json',
            'include-hidden-files': true,
            'if-no-files-found': 'error',
            'retention-days': 3,
        });
        expect(stepIndex(shards, uploadAction)).toBeGreaterThan(
            stepIndex(shards, 'Run frontend test shard')
        );
    });

    it('user sees frontend-only work avoid native Rust caches', () => {
        const workflow = ciWorkflow();

        for (const jobId of [shardJobId, aggregateJobId, 'ci-tests']) {
            expect(nativeCacheSteps(job(workflow, jobId))).toEqual([]);
        }
    });

    it('user sees shard failures remain visible without cancellation or masked errors', () => {
        const shards = job(ciWorkflow(), shardJobId);

        expect(shards['continue-on-error']).toBeUndefined();
        expect(
            shards.steps.every((candidate) => candidate['continue-on-error'] === undefined)
        ).toBe(true);
    });
});

function nativeCacheSteps(jobValue: DispatchableJob) {
    return jobValue.steps.filter(
        (candidate) =>
            candidate.uses?.startsWith('swatinem/rust-cache@') ||
            normalizedCommand(candidate.run).includes('cargo ')
    );
}

describe('user merges complete shards under the original frontend policy', () => {
    it('user sees the aggregate wait for changes and every frontend shard', () => {
        const workflow = ciWorkflow();
        const aggregate = job(workflow, aggregateJobId);

        expect(aggregate.name).toBe('Frontend Tests');
        expect([...needs(aggregate)].sort()).toEqual(['changes', shardJobId].sort());
        expect(aggregate['runs-on']).toBe('ubuntu-latest');
    });

    it('user sees the aggregate always evaluate an applicable desktop change even when a shard failed', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);
        const condition = source(aggregate.if, 'aggregate condition');

        expect(condition.startsWith('always()')).toBe(true);
        expect(conditionWithoutAlways(aggregate)).toBe(
            "needs.changes.result == 'success' && needs.changes.outputs.docs_only != 'true' && needs.changes.outputs.desktop_changed == 'true'"
        );
    });

    it.each([
        {
            scenario: 'changes succeeded for a desktop pull request',
            changesResult: 'success',
            docsOnly: 'false',
            desktopChanged: 'true',
            selected: true,
            outcome: 'run',
        },
        {
            scenario: 'the change is docs-only',
            changesResult: 'success',
            docsOnly: 'true',
            desktopChanged: 'false',
            selected: false,
            outcome: 'skip',
        },
        {
            scenario: 'no desktop files changed',
            changesResult: 'success',
            docsOnly: 'false',
            desktopChanged: 'false',
            selected: false,
            outcome: 'skip',
        },
        {
            scenario: 'change classification failed',
            changesResult: 'failure',
            docsOnly: 'false',
            desktopChanged: 'true',
            selected: false,
            outcome: 'skip',
        },
    ])(
        'user sees the aggregate $outcome when $scenario',
        ({ changesResult, docsOnly, desktopChanged, selected }) => {
            const aggregate = job(ciWorkflow(), aggregateJobId);
            const result = truthy(
                evaluateExpression(conditionWithoutAlways(aggregate), {
                    needs: {
                        changes: {
                            result: changesResult,
                            outputs: {
                                docs_only: docsOnly,
                                desktop_changed: desktopChanged,
                            },
                        },
                    },
                })
            );

            expect(result).toBe(selected ? true : false);
        }
    );

    it('user sees the aggregate refuse a non-successful shard matrix before any merge work', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);
        const first = aggregate.steps[0];

        expect(first?.name).toBe('Verify frontend test shards succeeded');
        expect(first?.if).toBeUndefined();
        expect(first?.env).toEqual({
            SHARDS_RESULT: '${{ needs.frontend-test-shards.result }}',
        });
        expect(source(first?.run, 'shard result gate')).toContain('SHARDS_RESULT');
    });

    it('user sees the aggregate continue when all frontend shards succeed', () => {
        const gate = runShardResultGate('success');

        expect(gate.status).toBe(0);
        expect(gate.output).not.toContain('Frontend test shards did not all succeed');
    });

    it.each([
        { result: 'failure', outcome: 'fails' },
        { result: 'cancelled', outcome: 'is cancelled' },
        { result: 'skipped', outcome: 'is skipped' },
        { result: undefined, outcome: 'has no result' },
    ])('user sees the aggregate fail when the shard matrix $outcome', ({ result }) => {
        const gate = runShardResultGate(result);

        expect(gate.status).toBe(1);
        expect(gate.output).toContain('Frontend test shards did not all succeed');
        expect(gate.output).toContain(`result: ${result ?? 'missing'}`);
    });

    it('user sees full history checked out for the full-policy merge and patch comparison', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);
        const checkout = actionStep(aggregate, checkoutAction);

        expect(checkout?.with).toMatchObject({
            ref: '${{ github.event.pull_request.head.sha || github.sha }}',
            'fetch-depth': 0,
            'persist-credentials': false,
        });
        expect(stepIndex(aggregate, checkoutAction)).toBeGreaterThan(0);
    });

    it('user sees package setup and cached Node installation precede frozen dependency restore', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);
        const pnpmIndex = stepIndex(aggregate, pnpmAction);
        const nodeIndex = stepIndex(aggregate, nodeAction);
        const installIndex = stepIndex(aggregate, 'Install dependencies');
        const node = actionStep(aggregate, nodeAction);

        expect(pnpmIndex).toBeLessThan(nodeIndex);
        expect(nodeIndex).toBeLessThan(installIndex);
        expect(node?.with).toMatchObject({ 'node-version': 22, cache: 'pnpm' });
        expect(normalizedCommand(step(aggregate, 'Install dependencies').run)).toBe(
            'pnpm install --frozen-lockfile --filter @touchai/desktop...'
        );
    });

    it('user sees all three artifacts downloaded together into the native report directory', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);
        const download = actionStep(aggregate, downloadAction);

        expect(download?.with).toEqual({
            pattern: 'frontend-shard-*',
            'merge-multiple': true,
            path: 'apps/desktop/.vitest-reports',
        });
    });

    it('user sees completeness checked before the native merge applies the full coverage policy', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);
        const checkerIndex = stepIndex(aggregate, 'Verify frontend shard artifacts');
        const mergeIndex = stepIndex(aggregate, 'Merge frontend shard reports with coverage');

        expect(normalizedCommand(step(aggregate, 'Verify frontend shard artifacts').run)).toBe(
            'node .github/scripts/assert-frontend-shards.mjs apps/desktop/.vitest-reports 3'
        );
        expect(
            normalizedCommand(step(aggregate, 'Merge frontend shard reports with coverage').run)
        ).toBe(mergeCommand);
        expect(checkerIndex).toBeLessThan(mergeIndex);
        expect(stepIndex(aggregate, downloadAction)).toBeLessThan(checkerIndex);
    });

    it('user keeps the original summary, patch floor, and coverage artifact after the merge', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);
        const commands = runCommands(aggregate);
        const mergeIndex = stepIndex(aggregate, 'Merge frontend shard reports with coverage');
        const summaryIndex = stepIndex(aggregate, 'Summarize coverage');
        const patchIndex = stepIndex(aggregate, 'Check patch coverage');
        const artifactIndex = stepIndex(aggregate, uploadAction);
        const artifact = actionStep(aggregate, uploadAction);

        expect(commands).toContain(
            'node apps/desktop/scripts/ci/coverage/summarize-coverage.mjs --kind frontend --input apps/desktop/.coverage/unit/coverage-summary.json'
        );
        expect(commands.find((command) => command.includes('patch-coverage-cli.mjs'))).toBe(
            'node apps/desktop/scripts/ci/coverage/patch-coverage-cli.mjs --coverage apps/desktop/.coverage/unit/coverage-final.json --base "${{ github.event.pull_request.base.sha }}" --root . --floor 85'
        );
        expect(summaryIndex).toBeGreaterThan(mergeIndex);
        expect(patchIndex).toBeGreaterThan(summaryIndex);
        expect(artifactIndex).toBeGreaterThan(patchIndex);
        expect(artifact?.with).toMatchObject({
            name: 'frontend-coverage-report',
            path: 'apps/desktop/.coverage/unit',
            'if-no-files-found': 'error',
        });
    });

    it('user sees no fallback or masked failure in the aggregate job', () => {
        const aggregate = job(ciWorkflow(), aggregateJobId);

        expect(aggregate['continue-on-error']).toBeUndefined();
        expect(
            aggregate.steps.every((candidate) => candidate['continue-on-error'] === undefined)
        ).toBe(true);
        expect(runCommands(aggregate).join(' ')).not.toContain('|| true');
        expect(runCommands(aggregate).join(' ')).not.toContain('vitest.ci-shard.config.ts');
    });
});

describe('user validates hidden shard artifacts', () => {
    it('user sees exactly three expected report files accepted', async () => {
        const directory = await createShardDirectory();
        const result = runShardChecker(directory, '3');

        expect(result.status).toBe(0);
        expect(result.output).toContain('Verified 3 frontend shard report files');
    });

    it('user sees a missing report directory rejected', async () => {
        const missing = join(tmpdir(), `touchai-missing-shards-${process.pid}-${Date.now()}`);
        const result = runShardChecker(missing, '3');

        expect(result.status).toBe(1);
        expect(result.output).toContain('Frontend shard report directory is not readable');
    });

    it('user sees a missing report rejected', async () => {
        const directory = await createShardDirectory({ files: [1, 3] });
        const result = runShardChecker(directory, '3');

        expect(result.status).toBe(1);
        expect(result.output).toContain('blob-2-3.json');
        expect(result.output).toContain('Expected files:');
        expect(result.output).toContain('Actual entries:');
    });

    it.each([
        { extra: '.DS_Store', label: 'a hidden extra entry' },
        { extra: 'unexpected.txt', label: 'an unexpected extra entry' },
        { extra: 'blob-4-3.json', label: 'an out-of-range shard report' },
    ])('user sees $label rejected', async ({ extra }) => {
        const directory = await createShardDirectory({ extras: [extra] });
        const result = runShardChecker(directory, '3');

        expect(result.status).toBe(1);
        expect(result.output).toContain(extra);
        expect(result.output).toContain('Expected files:');
    });

    it('user sees a directory in place of a report rejected', async () => {
        const directory = await createShardDirectory({ files: [2, 3] });
        await mkdir(join(directory, 'blob-1-3.json'));
        const result = runShardChecker(directory, '3');

        expect(result.status).toBe(1);
        expect(result.output).toContain('blob-1-3.json');
        expect(result.output).toContain('not a regular file');
    });

    it('user sees a symlink in place of a report rejected', async () => {
        const directory = await createShardDirectory({ files: [2, 3] });
        const targetRoot = await mkdtemp(join(tmpdir(), 'touchai-frontend-shard-target-'));
        temporaryDirectories.push(targetRoot);
        const target = join(targetRoot, 'symlink-target');
        await mkdir(target);
        const linkType = process.platform === 'win32' ? 'junction' : 'dir';
        await symlink(target, join(directory, 'blob-1-3.json'), linkType);
        const result = runShardChecker(directory, '3');

        expect(result.status).toBe(1);
        expect(result.output).toContain('Invalid entry (not a regular file): blob-1-3.json');
    });

    it.each([
        { count: '0', label: 'zero' },
        { count: '-1', label: 'negative' },
        { count: '2.5', label: 'fractional' },
        { count: 'three', label: 'non-numeric' },
    ])('user sees a $label shard count rejected', async ({ count }) => {
        const directory = await createShardDirectory();
        const result = runShardChecker(directory, count);

        expect(result.status).toBe(1);
        expect(result.output).toContain('positive integer');
    });
});

describe('user retains the original shard merge policy', () => {
    it('user sees partial shard runs skip complete-suite floors and report files', async () => {
        const original = (await import('../../../apps/desktop/vitest.config')).default;
        const shard = (await import('../../../apps/desktop/vitest.ci-shard.config')).default;
        const originalRecord = original as Record<string, unknown>;
        const shardRecord = shard as Record<string, unknown>;
        const originalTest = (original.test ?? {}) as Record<string, unknown>;
        const shardTest = (shard.test ?? {}) as Record<string, unknown>;
        const originalCoverage = (original.test?.coverage ?? {}) as Record<string, unknown>;
        const shardCoverage = (shard.test?.coverage ?? {}) as Record<string, unknown>;

        expect(Object.keys(shardRecord).sort()).toEqual(Object.keys(originalRecord).sort());
        expect(Object.keys(shardTest).sort()).toEqual(Object.keys(originalTest).sort());
        expect(Object.keys(shardCoverage).sort()).toEqual(Object.keys(originalCoverage).sort());

        for (const [key, value] of Object.entries(originalRecord)) {
            if (key !== 'test') {
                expect(shardRecord[key]).toBe(value);
            }
        }

        for (const [key, value] of Object.entries(originalTest)) {
            if (key !== 'coverage') {
                expect(shardTest[key]).toBe(value);
            }
        }

        for (const [key, value] of Object.entries(originalCoverage)) {
            if (key !== 'thresholds' && key !== 'reporter') {
                expect(shardCoverage[key]).toBe(value);
            }
        }

        expect(original.test?.coverage?.thresholds).toEqual(originalThresholds);
        expect(original.test?.coverage?.reporter).toEqual([
            'text',
            'html',
            'json-summary',
            'json',
            'lcov',
        ]);
        expect(shard.test?.coverage?.thresholds).toBeUndefined();
        expect(shard.test?.coverage?.reporter).toEqual([]);
    }, 30_000);
});

describe('user runs every repository CI check and moved UI preview elsewhere', () => {
    it('user sees UI preview validation execute exactly once in repository CI tests', () => {
        const workflow = ciWorkflow();
        const matchingSteps = Object.values(workflow.jobs).flatMap((workflowJob) =>
            workflowJob.steps.filter(
                (workflowStep: WorkflowStep) =>
                    normalizedCommand(workflowStep.run) === 'pnpm test:ui-preview'
            )
        );
        const ciTests = job(workflow, 'ci-tests');

        expect(matchingSteps).toHaveLength(1);
        expect(runCommands(ciTests)).toContain('pnpm test:ui-preview');
        expect(runCommands(job(workflow, shardJobId))).not.toContain('pnpm test:ui-preview');
        expect(runCommands(job(workflow, aggregateJobId))).not.toContain('pnpm test:ui-preview');
        expect(runCommands(job(workflow, aggregateJobId))).not.toContain('pnpm test:coverage');
    });

    it('user keeps every existing CI test, type, and lint step', () => {
        const commands = runCommands(job(ciWorkflow(), 'ci-tests'));

        expect(commands).toEqual([
            'pnpm install --frozen-lockfile',
            'pnpm test:ui-preview',
            'pnpm test:ci:typecheck',
            'pnpm exec eslint tests/ci vitest.ci.config.ts',
            'pnpm test:ci',
        ]);
    });

    it('user keeps the final required gate, contexts, and established DAG intact', () => {
        const workflow = ciWorkflow();
        const required = job(workflow, 'ci-required');

        expect(required.name).toBe('CI Required');
        expect([...needs(required)].sort()).toEqual(
            [
                'changes',
                'workflow-lint',
                'conventional-commits',
                'dependency-review',
                'release-notes-check',
                'frontend-quality',
                aggregateJobId,
                'ci-tests',
                'site-build',
                'rust-checks',
                'architecture',
                'build-windows',
            ].sort()
        );
        expect(needs(required)).not.toContain(shardJobId);
        expect(job(workflow, 'conventional-commits').name).toBe('Conventional Commits');
        expect(job(workflow, 'dependency-review').name).toBe('Dependency Review');
    });
});
