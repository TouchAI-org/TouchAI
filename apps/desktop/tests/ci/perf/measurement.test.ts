// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import fs from 'node:fs';
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
        expect(records[1]).toMatchObject({
            exitCode: null,
            signal: null,
            cgroup: {},
            valid: false,
            invalidReasons: ['measurement launch failed: spawn failed'],
        });
    });
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
