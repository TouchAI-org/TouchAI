// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../../..');
const workflowPath = path.resolve(repositoryRoot, '.github/workflows/perf-nightly.yml');

describe('user runs RFC 710 performance on GitHub Actions', () => {
    it('user sees the canonical workflow use a GitHub-hosted display stack', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain('runs-on: ubuntu-24.04');
        expect(workflow).not.toContain('self-hosted');
        expect(workflow).not.toContain('Daytona');
        expect(workflow).toContain('dbus-x11');
        expect(workflow).toContain('dunst');
        expect(workflow).toContain('openbox');
        expect(workflow).toContain('wmctrl');
        expect(workflow).toContain("inputs['startup-settle-ms']");
        expect(workflow).toContain("inputs['latency-blocks']");
        expect(workflow).toContain('TOUCHAI_PERF_EVIDENCE: /tmp/touchai-perf-evidence');
        expect(workflow).toContain('TOUCHAI_PERF_ARTIFACTS: /tmp/touchai-perf-artifacts');
        expect(workflow).toContain('performance-scope');
        expect(workflow).toContain('- cold-latency');
        expect(workflow).toContain('- steady-state-memory');
        expect(workflow).toContain('- full');
        expect(workflow).toContain("github.event_name == 'schedule'");
        expect(workflow).toContain('--progress-blocks "$PROGRESS_BLOCKS"');
        expect(workflow).toContain('--long-blocks "$LONG_BLOCKS"');
        expect(workflow).toContain('--history-levels "$HISTORY_LEVELS"');
        expect(workflow).not.toContain('${{ github.workspace }}/../');
        expect(workflow).not.toContain('TOUCHAI_PERF_EVIDENCE: ${{ runner.temp }}');
    });

    it('user sees invalid samples and gate failures make the job fail', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain(
            "contains(github.event.pull_request.labels.*.name, 'perf:rfc710')"
        );
        expect(workflow).toContain('Enforce RFC 710 performance gate');
        expect(workflow).toContain('.rawCounts.invalidRuns');
        expect(workflow).toContain('.overallStatus');
        expect(workflow).toContain('steady-state-memory) flows=progress,long-session');
        expect(workflow).toContain('cat "$TOUCHAI_PERF_EVIDENCE/summary.md"');
        expect(workflow).not.toContain('continue-on-error');
    });
});
