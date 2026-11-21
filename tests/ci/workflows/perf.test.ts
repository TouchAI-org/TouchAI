// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../..');
const workflowPath = path.resolve(repositoryRoot, '.github/workflows/perf-nightly.yml');
const perfRunner = path.resolve(repositoryRoot, 'apps/desktop/scripts/perf/run.mjs');
const comparison = {
    baselineCommit: 'a'.repeat(40),
    candidateCommit: 'b'.repeat(40),
};

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
            version: 1,
            comparison,
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
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain('runs-on: ubuntu-24.04');
        expect(workflow).toContain('node-version: 22');
        expect(workflow).not.toContain('self-hosted');
        expect(workflow).not.toContain('Daytona');
        expect(workflow).toContain('dbus-x11');
        expect(workflow).toContain('dunst');
        expect(workflow).toContain('openbox');
        expect(workflow).toContain('wmctrl');
        expect(workflow).toContain("inputs['startup-settle-ms']");
        expect(workflow).toContain("inputs['latency-blocks']");
        expect(workflow).toContain("inputs['long-blocks']");
        expect(workflow).toContain('TOUCHAI_PERF_EVIDENCE: /tmp/touchai-perf-evidence');
        expect(workflow).toContain('TOUCHAI_PERF_ARTIFACTS: /tmp/touchai-perf-artifacts');
        expect(workflow).toContain('performance-scope');
        expect(workflow).toContain('- cold-latency');
        expect(workflow).toContain('- steady-state-memory');
        expect(workflow).toContain('- full');
        expect(workflow).toContain("github.event_name == 'schedule'");
        expect(workflow).toContain('--progress-blocks "$PROGRESS_BLOCKS"');
        expect(workflow).toContain("inputs['long-blocks'] || '6'");
        expect(workflow).toContain('--long-blocks "$LONG_BLOCKS"');
        expect(workflow).toContain('long-blocks must be at least 6');
        expect(workflow).toContain('--history-levels "$HISTORY_LEVELS"');
        expect(workflow).toContain('persist-credentials: false');
        expect(workflow).toContain('startup-settle-ms must be a positive integer');
        expect(workflow).not.toContain('${{ github.workspace }}/../');
        expect(workflow).not.toContain('TOUCHAI_PERF_EVIDENCE: ${{ runner.temp }}');
    });

    it('user sees invalid samples and gate failures make the job fail', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain(
            "contains(github.event.pull_request.labels.*.name, 'performance')"
        );
        expect(workflow).toContain('Enforce desktop performance gate');
        expect(workflow).toContain('node apps/desktop/scripts/perf/run.mjs gate');
        expect(workflow).toContain('steady-state-memory) flows=progress,long-session');
        expect(workflow).toContain('cat "$TOUCHAI_PERF_EVIDENCE/summary.md"');
        expect(workflow).not.toContain('continue-on-error');
    });

    it('user compares the pull request merge commit with its base without an obsolete baseline alias', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain('github.event.pull_request.base.sha');
        expect(workflow).toContain('PERF_CANDIDATE_REQUEST: ${{ inputs.candidate || github.sha }}');
        expect(workflow).toContain('ref: ${{ inputs.candidate || github.sha }}');
        expect(workflow).not.toContain('github.event.pull_request.head.sha');
        expect(workflow).toContain('node apps/desktop/scripts/perf/run.mjs all');
        expect(workflow).toContain('--baseline "$PERF_BASELINE"');
        expect(workflow).toContain('--candidate "$PERF_CANDIDATE"');
        expect(workflow).toContain("inputs['latency-blocks'] || '60'");
        expect(workflow).toContain("PROGRESS_BLOCKS: '3'");
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
