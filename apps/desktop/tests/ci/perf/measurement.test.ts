// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runInCgroup } = vi.hoisted(() => ({
    runInCgroup: vi.fn(),
}));

vi.mock('../../../scripts/perf/lib/process.mjs', () => ({ runInCgroup }));

let root: string | null = null;

async function retryDisplayStartup(input: {
    runStarted: boolean;
    exitCode: number | null;
    signal: string | null;
    logText: string;
}): Promise<boolean> {
    const { shouldRetryDisplayStartupFailure } =
        await import('../../../scripts/perf/lib/measurement.mjs');
    return shouldRetryDisplayStartupFailure(input);
}

beforeEach(() => {
    vi.resetModules();
    runInCgroup.mockReset();
});

afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = null;
    delete process.env.TOUCHAI_PERF_ARTIFACTS;
    delete process.env.TOUCHAI_PERF_EVIDENCE;
    delete process.env.TOUCHAI_PERF_PORT;
    delete process.env.TOUCHAI_PERF_STARTUP_SETTLE_MS;
});

describe('user runs one performance measurement', () => {
    it('user records launch failures as invalid terminal measurements', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-measurement-'));
        const evidenceRoot = path.join(root, 'evidence');
        const artifactsRoot = path.join(root, 'artifacts');
        const binary = path.join(evidenceRoot, 'binaries/baseline/TouchAI');
        const fixture = path.join(evidenceRoot, 'fixtures/baseline/fixture-base.db');
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.mkdirSync(path.dirname(fixture), { recursive: true });
        fs.mkdirSync(path.join(evidenceRoot, 'raw/formal'), { recursive: true });
        fs.writeFileSync(binary, 'binary');
        fs.writeFileSync(fixture, 'fixture');
        process.env.TOUCHAI_PERF_ARTIFACTS = artifactsRoot;
        process.env.TOUCHAI_PERF_EVIDENCE = evidenceRoot;
        process.env.TOUCHAI_PERF_PORT = '3426';
        process.env.TOUCHAI_PERF_STARTUP_SETTLE_MS = '8000';
        runInCgroup.mockRejectedValueOnce(new Error('spawn failed'));

        const { runOneMeasurement } = await import('../../../scripts/perf/lib/measurement.mjs');

        await expect(
            runOneMeasurement({
                arm: 'baseline',
                flow: 'latency',
                block: 1,
                sequenceIndex: 1,
                fixture: 'base',
                historyLevel: 0,
                options: { memoryIntervalMs: 250 },
            })
        ).rejects.toThrow('measurement launch failed: spawn failed');

        const records = fs
            .readFileSync(path.join(evidenceRoot, 'raw/formal/runs.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(records.map((record) => record.type)).toEqual(['run-launch', 'run']);
        expect(records[0]).toMatchObject({ attempt: 1 });
        expect(records[1]).toMatchObject({
            attempt: 1,
            exitCode: null,
            signal: null,
            cgroup: {},
            valid: false,
            invalidReasons: ['measurement launch failed: spawn failed'],
        });
    });

    it('user keeps existing evidence when the model port is already occupied', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-measurement-'));
        const evidenceRoot = path.join(root, 'evidence');
        const artifactsRoot = path.join(root, 'artifacts');
        const comparison = {
            baselineCommit: 'a'.repeat(40),
            candidateCommit: 'b'.repeat(40),
        };
        const binaries: Record<string, { binary: string; sha256: string }> = {};
        for (const arm of ['baseline', 'current']) {
            const binary = path.join(evidenceRoot, `binaries/${arm}/TouchAI`);
            fs.mkdirSync(path.dirname(binary), { recursive: true });
            fs.writeFileSync(binary, `${arm} binary`);
            binaries[arm] = {
                binary,
                sha256: createHash('sha256').update(`${arm} binary`).digest('hex'),
            };
        }
        fs.mkdirSync(path.join(evidenceRoot, 'raw/formal'), { recursive: true });
        for (const arm of ['baseline', 'current']) {
            const fixture = path.join(evidenceRoot, `fixtures/${arm}/fixture-base.db`);
            fs.mkdirSync(path.dirname(fixture), { recursive: true });
            fs.writeFileSync(fixture, `${arm} fixture`);
        }
        fs.writeFileSync(
            path.join(evidenceRoot, 'source-manifest.json'),
            JSON.stringify({ comparison })
        );
        fs.writeFileSync(
            path.join(evidenceRoot, 'builds.json'),
            JSON.stringify({
                builds: ['baseline', 'current'].map((arm) => ({
                    arm,
                    comparison,
                    binarySha256: binaries[arm]!.sha256,
                })),
            })
        );
        const original = {
            runs: 'existing runs\n',
            events: 'existing events\n',
            plan: 'existing plan\n',
        };
        fs.writeFileSync(path.join(evidenceRoot, 'raw/formal/runs.jsonl'), original.runs);
        fs.writeFileSync(path.join(evidenceRoot, 'raw/formal/events.jsonl'), original.events);
        fs.writeFileSync(path.join(evidenceRoot, 'run-plan.json'), original.plan);

        const blocker = http.createServer();
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const address = blocker.address();
        if (!address || typeof address === 'string') throw new Error('Missing blocker port.');
        process.env.TOUCHAI_PERF_ARTIFACTS = artifactsRoot;
        process.env.TOUCHAI_PERF_EVIDENCE = evidenceRoot;
        process.env.TOUCHAI_PERF_PORT = String(address.port);
        process.env.TOUCHAI_PERF_STARTUP_SETTLE_MS = '8000';
        const { MANIFEST_VERSION, modelEndpoint } =
            await import('../../../scripts/perf/lib/config.mjs');
        fs.writeFileSync(
            path.join(evidenceRoot, 'fixture-manifest.json'),
            JSON.stringify({ version: MANIFEST_VERSION, comparison, modelEndpoint })
        );

        try {
            const { runMeasurements } = await import('../../../scripts/perf/lib/orchestrator.mjs');
            await expect(
                runMeasurements({
                    flows: ['latency'],
                    latencyBlocks: 1,
                    progressBlocks: 3,
                    longBlocks: 6,
                    historyLevels: [100],
                    warmSamples: 0,
                    progressWarmups: 0,
                    progressTasks: 0,
                    memoryIntervalMs: 250,
                    dryRun: false,
                    resume: false,
                })
            ).rejects.toThrow(/EADDRINUSE|address already in use/i);
        } finally {
            await new Promise<void>((resolve, reject) =>
                blocker.close((error) => (error ? reject(error) : resolve()))
            );
        }

        expect(fs.readFileSync(path.join(evidenceRoot, 'raw/formal/runs.jsonl'), 'utf8')).toBe(
            original.runs
        );
        expect(fs.readFileSync(path.join(evidenceRoot, 'raw/formal/events.jsonl'), 'utf8')).toBe(
            original.events
        );
        expect(fs.readFileSync(path.join(evidenceRoot, 'run-plan.json'), 'utf8')).toBe(
            original.plan
        );
    }, 15000);
});

describe('user retries only a failed display startup', () => {
    it('user retries once when the X11 notification stack fails before the scenario starts', async () => {
        await expect(
            retryDisplayStartup({
                runStarted: false,
                exitCode: 1,
                signal: null,
                logText:
                    'Dunst did not register org.freedesktop.Notifications. ' +
                    "ERROR: Couldn't initialize X11 output. Aborting...",
            })
        ).resolves.toBe(true);
    });

    it('user keeps a real scenario failure visible after the app has started', async () => {
        await expect(
            retryDisplayStartup({
                runStarted: true,
                exitCode: 1,
                signal: null,
                logText: 'The seeded 1000-message session did not finish rendering.',
            })
        ).resolves.toBe(false);
    });

    it('user does not mask an assertion failure as a display restart', async () => {
        await expect(
            retryDisplayStartup({
                runStarted: false,
                exitCode: 1,
                signal: null,
                logText: 'AssertionError: expected the cold sample to be recorded',
            })
        ).resolves.toBe(false);
    });

    it('user does not retry an unexplained trace trap before the run starts', async () => {
        await expect(
            retryDisplayStartup({
                runStarted: false,
                exitCode: 133,
                signal: null,
                logText: 'Trace/breakpoint trap',
            })
        ).resolves.toBe(false);
    });

    it('user gets no retry when the scenario exited cleanly', async () => {
        await expect(
            retryDisplayStartup({
                runStarted: false,
                exitCode: 0,
                signal: null,
                logText: 'Cannot open X11 display',
            })
        ).resolves.toBe(false);
    });
});
