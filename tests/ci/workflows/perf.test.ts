// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../..');
const workflowPath = path.resolve(repositoryRoot, '.github/workflows/perf-nightly.yml');
const perfRunner = path.resolve(repositoryRoot, 'apps/desktop/scripts/perf/run.mjs');

function runGate(stats: unknown | null) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-gate-'));
    try {
        if (stats !== null) {
            writeFileSync(path.join(root, 'stats.json'), JSON.stringify(stats));
        }
        return spawnSync(process.execPath, [perfRunner, 'gate'], {
            encoding: 'utf8',
            env: { ...process.env, TOUCHAI_PERF_EVIDENCE: root, TOUCHAI_PERF_ARTIFACTS: root },
        });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
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

    it('user sees the performance gate fail closed for every rejected report', () => {
        const passing = runGate({ overallStatus: 'PASS', rawCounts: { invalidRuns: 0 } });
        const invalid = runGate({ overallStatus: 'PASS', rawCounts: { invalidRuns: 1 } });
        const blocked = runGate({ overallStatus: 'BLOCKED', rawCounts: { invalidRuns: 0 } });
        const missing = runGate(null);

        expect(passing.status).toBe(0);
        expect(invalid.status).toBe(1);
        expect(invalid.stderr).toContain('1 invalid run');
        expect(blocked.status).toBe(1);
        expect(blocked.stderr).toContain('BLOCKED');
        expect(missing.status).toBe(1);
        expect(missing.stderr).toContain('missing stats.json');
    });

    it.each([
        { overallStatus: 'PASS' },
        { overallStatus: 'PASS', rawCounts: { invalidRuns: '0' } },
    ])('user sees a malformed invalid-run count fail the gate: %o', (stats) => {
        const result = runGate(stats);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('rawCounts.invalidRuns');
    });
});
