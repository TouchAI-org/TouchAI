// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { MANIFEST_VERSION, modelEndpoint } from '../../../apps/desktop/scripts/perf/lib/config.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../..');
const workflowPath = path.resolve(repositoryRoot, '.github/workflows/perf-nightly.yml');
const perfRunner = path.resolve(repositoryRoot, 'apps/desktop/scripts/perf/run.mjs');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const comparison = {
    baselineCommit: 'a'.repeat(40),
    candidateCommit: 'b'.repeat(40),
};

type WorkflowStep = {
    name?: string;
    uses?: string;
    run?: string;
    if?: string;
    with?: Record<string, unknown>;
    'continue-on-error'?: boolean;
};

type PerformanceWorkflow = {
    jobs: {
        performance: {
            'runs-on': string;
            'timeout-minutes': number;
            env: Record<string, string>;
            steps: WorkflowStep[];
        };
    };
};

async function readPerformanceWorkflow(): Promise<PerformanceWorkflow> {
    return parse(await readFile(workflowPath, 'utf8')) as PerformanceWorkflow;
}

function runInputValidation(workflow: PerformanceWorkflow, overrides: Record<string, string> = {}) {
    const validate = workflow.jobs.performance.steps.find(
        (step) => step.name === 'Validate inputs'
    );
    if (!validate?.run) throw new Error('Performance input validation step is missing.');

    return spawnSync('bash', ['-e', '-c', validate.run], {
        encoding: 'utf8',
        env: {
            ...process.env,
            TOUCHAI_PERF_STARTUP_SETTLE_MS: '12000',
            LATENCY_BLOCKS: '60',
            PROGRESS_BLOCKS: '3',
            LONG_BLOCKS: '6',
            HISTORY_LEVELS: '100,500,1000',
            PERF_SCOPE: 'full',
            BASELINE_RAIL: 'all',
            CANDIDATE_RAIL: 'sampled',
            ...overrides,
        },
    });
}

function spawnGate(root: string) {
    return spawnSync(process.execPath, [perfRunner, 'gate'], {
        encoding: 'utf8',
        env: { ...process.env, TOUCHAI_PERF_EVIDENCE: root, TOUCHAI_PERF_ARTIFACTS: root },
    });
}

function runGate(setup?: (root: string) => void) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-gate-'));
    try {
        setup?.(root);
        return spawnGate(root);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function writePassingEvidence(root: string): void {
    mkdirSync(path.join(root, 'raw/formal'), { recursive: true });
    const sources: Record<string, { path: string; sha256: string }> = {};
    const builds = ['baseline', 'current'].map((arm) => {
        const source = JSON.stringify({ version: MANIFEST_VERSION, arm, comparison, entries: [] });
        const file = `manifests/${arm}.json`;
        mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        writeFileSync(path.join(root, file), source);
        sources[arm] = { path: file, sha256: hash(source) };
        const binary = `binaries/${arm}/TouchAI`;
        mkdirSync(path.dirname(path.join(root, binary)), { recursive: true });
        writeFileSync(path.join(root, binary), `${arm}-binary`);
        return {
            arm,
            comparison,
            binary,
            binarySha256: hash(`${arm}-binary`),
            sourceManifestSha256: hash(source),
            exitCode: 0,
            signal: null,
        };
    });
    writeFileSync(
        path.join(root, 'source-manifest.json'),
        JSON.stringify({ version: MANIFEST_VERSION, comparison, ...sources })
    );
    writeFileSync(path.join(root, 'builds.json'), JSON.stringify({ builds }));
    mkdirSync(path.join(root, 'fixtures'));
    writeFileSync(path.join(root, 'fixtures/base.db'), 'base-fixture');
    const model = [];
    const order = ['baseline', 'current', 'current', 'baseline'] as const;
    const runs = [];
    const events = [];
    const plan = [];
    for (let block = 1; block <= 3; block += 1) {
        for (const [offset, arm] of order.entries()) {
            const sequenceIndex = offset + 1;
            const runId = `latency-b${block}-s${sequenceIndex}-${arm}`;
            const identity = {
                runId,
                arm,
                flow: 'latency',
                block,
                sequenceIndex,
                historyLevel: 0,
                fixture: 'base',
                fixtureSha256: hash('base-fixture'),
                binarySha256: hash(`${arm}-binary`),
                attempt: 1,
            };
            runs.push(
                { type: 'run-launch', ...identity },
                {
                    type: 'run',
                    ...identity,
                    exitCode: 0,
                    signal: null,
                    notificationFailures: 0,
                    valid: true,
                    invalidReasons: [],
                }
            );
            events.push(
                { type: 'run-start', ...identity },
                {
                    type: 'latency',
                    runId,
                    arm,
                    flow: 'latency',
                    block,
                    sequenceIndex,
                    mode: 'cold',
                    sample: 'cold',
                    promptId: `${runId}-cold`,
                    rounds: 12,
                    chunks: 24,
                    chunkBytes: 32,
                    alternate: false,
                    chunkDelayMs: 8,
                    durationMs: 1000,
                    firstTextMs: 400,
                }
            );
            const request = {
                runId,
                arm,
                flow: 'latency',
                block,
                promptId: `${runId}-cold`,
                rounds: 12,
                chunks: 24,
                chunkBytes: 32,
                alternate: false,
                chunkDelayMs: 8,
            };
            for (let toolCount = 0; toolCount <= 12; toolCount++)
                model.push({ ...request, type: 'request', toolCount, at: 1000 + toolCount });
            model.push({ ...request, type: 'complete', toolCount: 12, at: 2000 });
            plan.push(identity);
        }
    }
    writeFileSync(
        path.join(root, 'run-plan.json'),
        JSON.stringify({
            protocol: {
                comparison,
                modelEndpoint,
                flows: ['latency'],
                latencyBlocks: 3,
                progressBlocks: 3,
                longBlocks: 6,
                historyLevels: [],
                warmSamples: 0,
                progressWarmups: 4,
                progressTasks: 8,
                memoryIntervalMs: 250,
            },
            plan,
        })
    );
    const fixtures = {
        base: {
            path: 'fixtures/base.db',
            sha256: hash('base-fixture'),
            businessOracleSha256: 'base-oracle',
        },
    };
    writeFileSync(
        path.join(root, 'fixture-manifest.json'),
        JSON.stringify({
            version: MANIFEST_VERSION,
            comparison,
            modelEndpoint,
            arms: {
                baseline: {
                    sourceBinarySha256: hash('baseline-binary'),
                    migrationTags: [],
                    fixtures,
                },
                current: {
                    sourceBinarySha256: hash('current-binary'),
                    migrationTags: [],
                    fixtures,
                },
            },
            businessOracles: {
                base: { baseline: 'base-oracle', current: 'base-oracle' },
            },
        })
    );
    writeFileSync(
        path.join(root, 'raw/formal/runs.jsonl'),
        `${runs.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    writeFileSync(
        path.join(root, 'raw/formal/events.jsonl'),
        `${events.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    writeFileSync(path.join(root, 'raw/formal/pss.jsonl'), '');
    writeFileSync(
        path.join(root, 'raw/formal/model-server.jsonl'),
        model.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );
}

describe('user runs desktop performance on GitHub Actions', () => {
    it('user sees the canonical workflow use a GitHub-hosted display stack', async () => {
        const workflow = await readPerformanceWorkflow();
        const job = workflow.jobs.performance;
        const setupNode = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
        const install = job.steps.find(
            (step) => step.name === 'Install Linux GUI and build dependencies'
        );
        const validate = job.steps.find((step) => step.name === 'Validate inputs');
        const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));

        expect(job['runs-on']).toBe('ubuntu-24.04');
        expect(job['timeout-minutes']).toBe(360);
        expect(setupNode?.with?.['node-version']).toBe(22);
        expect(checkout?.with?.['persist-credentials']).toBe(false);
        expect(install?.run).toContain('dbus-x11');
        expect(install?.run).toContain('dunst');
        expect(install?.run).toContain('openbox');
        expect(install?.run).toContain('wmctrl');
        expect(job.env.TOUCHAI_PERF_EVIDENCE).toBe('/tmp/touchai-perf-evidence');
        expect(job.env.TOUCHAI_PERF_ARTIFACTS).toBe('/tmp/touchai-perf-artifacts');
        expect(job.env.PERF_SCOPE).toContain("github.event_name == 'schedule'");
        expect(validate?.run).toContain('startup-settle-ms must be a positive integer');
        expect(validate?.run).toContain('long-blocks must be at least 6');
        expect(validate?.run).toContain('more than 180 minutes settling alone');
        expect(await readFile(workflowPath, 'utf8')).not.toContain('self-hosted');
    });

    it('user sees impossible latency budgets fail before setup without charging memory-only scopes', async () => {
        const workflow = await readPerformanceWorkflow();
        const steps = workflow.jobs.performance.steps;
        const validateIndex = steps.findIndex((step) => step.name === 'Validate inputs');
        const setupIndexes = steps
            .map((step, index) =>
                step.uses?.startsWith('pnpm/action-setup@') ||
                step.uses?.startsWith('actions/setup-node@') ||
                step.name === 'Install Linux GUI and build dependencies' ||
                step.name === 'Install dependencies' ||
                step.name === 'Install tauri-driver'
                    ? index
                    : -1
            )
            .filter((index) => index >= 0);

        expect(validateIndex).toBeGreaterThan(-1);
        for (const index of setupIndexes) {
            expect(validateIndex).toBeLessThan(index);
        }

        const memoryOnly = runInputValidation(workflow, {
            LATENCY_BLOCKS: '500',
            PERF_SCOPE: 'steady-state-memory',
        });
        const coldLatency = runInputValidation(workflow, {
            LATENCY_BLOCKS: '500',
            PERF_SCOPE: 'cold-latency',
        });
        const full = runInputValidation(workflow, {
            LATENCY_BLOCKS: '500',
            PERF_SCOPE: 'full',
        });

        expect(memoryOnly.status).toBe(0);
        expect(coldLatency.status).toBe(1);
        expect(coldLatency.stderr).toContain('more than 180 minutes settling alone');
        expect(full.status).toBe(1);
        expect(full.stderr).toContain('more than 180 minutes settling alone');
    });

    it('user sees invalid samples and gate failures make the job fail', async () => {
        const workflow = await readPerformanceWorkflow();
        const job = workflow.jobs.performance;
        const names = job.steps.map((step) => step.name);
        const gateIndex = names.indexOf('Enforce desktop performance gate');
        const summaryIndex = names.indexOf('Summarize gate');
        const uploadIndex = names.indexOf('Upload performance evidence');
        const runStep = job.steps.find((step) => step.name === 'Run desktop performance protocol');
        const source = await readFile(workflowPath, 'utf8');

        expect(gateIndex).toBeGreaterThan(-1);
        expect(gateIndex).toBeLessThan(summaryIndex);
        expect(summaryIndex).toBeLessThan(uploadIndex);
        expect(job.steps[gateIndex]?.if).toBe("always() && env.PERF_SCOPE != 'progress-smoke'");
        expect(job.steps[summaryIndex]?.if).toBe('always()');
        expect(job.steps[uploadIndex]?.if).toBe('always()');
        expect(runStep?.run).toContain('steady-state-memory) flows=progress,long-session');
        expect(runStep?.run).toContain('progress-smoke) flows=progress');
        expect(job.steps[gateIndex]?.run).toContain('apps/desktop/scripts/perf/run.mjs gate');
        expect(job.steps.some((step) => step['continue-on-error'] === true)).toBe(false);
        expect(source).not.toContain('continue-on-error');
    });

    it('user compares the pull request merge commit with its base without an obsolete baseline alias', async () => {
        const workflow = await readPerformanceWorkflow();
        const job = workflow.jobs.performance;
        const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
        const runStep = job.steps.find((step) => step.name === 'Run desktop performance protocol');
        const source = await readFile(workflowPath, 'utf8');

        expect(job.env.PERF_BASELINE_REQUEST).toContain('github.event.pull_request.base.sha');
        expect(job.env.PERF_CANDIDATE_REQUEST).toContain('inputs.candidate || github.sha');
        expect(checkout?.with?.ref).toBeUndefined();
        expect(job.env.LATENCY_BLOCKS).toContain("inputs['latency-blocks'] || '60'");
        expect(job.env.PROGRESS_BLOCKS).toContain(
            "inputs['performance-scope'] == 'progress-smoke'"
        );
        expect(job.env.PROGRESS_WARMUPS).toContain("'1' || '4'");
        expect(job.env.PROGRESS_TASKS).toContain("'9' || '8'");
        expect(job.env.PERF_ADVISORY).toContain("'true' || 'false'");
        expect(runStep?.run).toContain('node apps/desktop/scripts/perf/run.mjs all');
        expect(runStep?.run).toContain('--baseline "$PERF_BASELINE"');
        expect(runStep?.run).toContain('--candidate "$PERF_CANDIDATE"');
        expect(runStep?.run).toContain('--baseline-rail "$BASELINE_RAIL"');
        expect(runStep?.run).toContain('--candidate-rail "$CANDIDATE_RAIL"');
        expect(runStep?.run).toContain('--advisory "$PERF_ADVISORY"');
        expect(source).not.toContain('github.event.pull_request.head.sha');
    });

    it('user sees a short progress smoke run fail for workload errors but not for missing statistics', async () => {
        const workflow = await readPerformanceWorkflow();
        const job = workflow.jobs.performance;
        const runStep = job.steps.find((step) => step.name === 'Run desktop performance protocol');
        const gate = job.steps.find((step) => step.name === 'Enforce desktop performance gate');
        const smoke = runInputValidation(workflow, {
            PERF_SCOPE: 'progress-smoke',
            LONG_BLOCKS: '1',
            PROGRESS_BLOCKS: '1',
        });

        expect(smoke.status).toBe(0);
        expect(runStep?.run).toContain('--progress-warmups "$PROGRESS_WARMUPS"');
        expect(runStep?.run).toContain('--progress-tasks "$PROGRESS_TASKS"');
        expect(gate?.if).toContain("env.PERF_SCOPE != 'progress-smoke'");
    });

    it('user sees the performance gate pass from complete current evidence', () => {
        const result = runGate(writePassingEvidence);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('Desktop performance gate passed');
    });

    it('user sees the performance gate fail when current evidence is missing', () => {
        const result = runGate();

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('BLOCKED');
    });

    it('user sees an old passing report rejected after raw evidence disappears', () => {
        const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-gate-'));
        try {
            writePassingEvidence(root);
            expect(spawnGate(root).status).toBe(0);
            expect(
                JSON.parse(readFileSync(path.join(root, 'stats.json'), 'utf8')).overallStatus
            ).toBe('PASS');

            rmSync(path.join(root, 'raw/formal/runs.jsonl'));
            rmSync(path.join(root, 'raw/formal/events.jsonl'));

            const result = spawnGate(root);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('BLOCKED');
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('user sees invalid current evidence fail instead of trusting a saved pass', () => {
        const result = runGate((root) => {
            writePassingEvidence(root);
            const file = path.join(root, 'raw/formal/runs.jsonl');
            const records = readFileSync(file, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            const terminal = records.find((record) => record.type === 'run');
            if (!terminal) throw new Error('Synthetic terminal run is missing.');
            terminal.valid = false;
            terminal.notificationFailures = 1;
            writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
            writeFileSync(
                path.join(root, 'stats.json'),
                JSON.stringify({ overallStatus: 'PASS', rawCounts: { invalidRuns: 0 } })
            );
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('invalid run');
    });
});
