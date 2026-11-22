// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
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
    writeFileSync(path.join(root, 'source-manifest.json'), JSON.stringify({ comparison }));
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
                fixtureSha256: 'base-fixture-sha',
                binarySha256: `${arm}-binary-sha`,
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
                    durationMs: 1000,
                    firstTextMs: 400,
                }
            );
            plan.push(identity);
        }
    }
    writeFileSync(
        path.join(root, 'run-plan.json'),
        JSON.stringify({
            protocol: {
                comparison,
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
        base: { sha256: 'base-fixture-sha', businessOracleSha256: 'base-oracle' },
    };
    writeFileSync(
        path.join(root, 'fixture-manifest.json'),
        JSON.stringify({
            version: MANIFEST_VERSION,
            comparison,
            modelEndpoint,
            arms: {
                baseline: {
                    sourceBinarySha256: 'baseline-binary-sha',
                    migrationTags: [],
                    fixtures,
                },
                current: {
                    sourceBinarySha256: 'current-binary-sha',
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
        expect(job.steps[gateIndex]?.if).toBe('always()');
        expect(job.steps[summaryIndex]?.if).toBe('always()');
        expect(job.steps[uploadIndex]?.if).toBe('always()');
        expect(runStep?.run).toContain('steady-state-memory) flows=progress,long-session');
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
        expect(checkout?.with?.ref).toContain('inputs.candidate || github.sha');
        expect(job.env.LATENCY_BLOCKS).toContain("inputs['latency-blocks'] || '60'");
        expect(job.env.PROGRESS_BLOCKS).toBe('3');
        expect(runStep?.run).toContain('node apps/desktop/scripts/perf/run.mjs all');
        expect(runStep?.run).toContain('--baseline "$PERF_BASELINE"');
        expect(runStep?.run).toContain('--candidate "$PERF_CANDIDATE"');
        expect(source).not.toContain('github.event.pull_request.head.sha');
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
