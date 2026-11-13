// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { measurementInvalidReasons } from '../../../scripts/perf/710/run.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const RUN_CLI = path.resolve(testDirectory, '../../../scripts/perf/710/run.mjs');
const cleanup: string[] = [];

function createEvidenceRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-run-'));
    cleanup.push(root);
    fs.mkdirSync(path.join(root, 'raw/formal'), { recursive: true });
    return root;
}

function runHarness(root: string, args: string[]) {
    return spawnSync(process.execPath, [RUN_CLI, 'run', ...args], {
        encoding: 'utf8',
        env: {
            ...process.env,
            TOUCHAI_PERF_EVIDENCE: root,
            TOUCHAI_PERF_ARTIFACTS: path.join(root, 'artifacts'),
        },
        timeout: 30000,
    });
}

function persistedProtocol(warmSamples: number) {
    return {
        flows: ['latency'],
        latencyBlocks: 1,
        progressBlocks: 3,
        longBlocks: 6,
        historyLevels: [100, 500, 1000],
        warmSamples,
        progressWarmups: 4,
        progressTasks: 8,
        memoryIntervalMs: 250,
        startupSettleMs: 8000,
        armOrder: ['baseline', 'current', 'current', 'baseline'],
        display: 'xvfb-openbox-dunst-dbus',
        windowManager: 'openbox',
        notificationDaemon: 'dunst',
    };
}

afterAll(() => {
    for (const root of cleanup) fs.rmSync(root, { recursive: true, force: true });
});

describe('user previews and resumes the RFC 710 performance run', () => {
    it('user previews a dry run without clearing evidence or replacing its plan', () => {
        const root = createEvidenceRoot();
        const planFile = path.join(root, 'run-plan.json');
        const runsFile = path.join(root, 'raw/formal/runs.jsonl');
        fs.writeFileSync(planFile, 'previous-plan\n');
        fs.writeFileSync(runsFile, 'previous-run\n');

        const result = runHarness(root, [
            '--dry-run',
            '--flows',
            'latency',
            '--latency-blocks',
            '1',
            '--warm-samples',
            '0',
        ]);

        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout ?? '')).toHaveLength(4);
        expect(fs.readFileSync(planFile, 'utf8')).toBe('previous-plan\n');
        expect(fs.readFileSync(runsFile, 'utf8')).toBe('previous-run\n');
    });

    it('user cannot resume with a different warm-sample protocol', () => {
        const root = createEvidenceRoot();
        fs.writeFileSync(
            path.join(root, 'run-plan.json'),
            `${JSON.stringify({ protocol: persistedProtocol(0) }, null, 2)}\n`
        );

        const result = runHarness(root, [
            '--resume',
            '--dry-run',
            '--flows',
            'latency',
            '--latency-blocks',
            '1',
            '--warm-samples',
            '8',
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('warmSamples');
    });
});

describe('user validates RFC 710 measurement evidence', () => {
    it('user rejects a run when its memory sampler stops before WebDriver finishes', () => {
        expect(
            measurementInvalidReasons({
                exitCode: 0,
                signal: null,
                notificationFailures: 0,
                samplerFailure: 'stopped before WebDriver completed (exit 1 signal null)',
            })
        ).toEqual(['memory sampler stopped before WebDriver completed (exit 1 signal null)']);
    });
});
