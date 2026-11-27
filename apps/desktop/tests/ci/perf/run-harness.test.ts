// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { resolveComparison } from '../../../scripts/perf/lib/comparison.mjs';
import { MANIFEST_VERSION, modelEndpoint } from '../../../scripts/perf/lib/config.mjs';
import {
    acquirePerformanceHarnessLock,
    performanceHarnessLockPath,
} from '../../../scripts/perf/lib/lock.mjs';
import {
    createSamplerWatch,
    measurementInvalidReasons,
    samplerFailureReason,
} from '../../../scripts/perf/lib/measurement.mjs';
import {
    linkSnapshotDependencies,
    verifyPreparedSnapshot,
} from '../../../scripts/perf/lib/snapshots.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const RUN_CLI = path.resolve(testDirectory, '../../../scripts/perf/run.mjs');
const cleanup: string[] = [];

function sha256File(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function comparisonRepository(): string {
    const root = createEvidenceRoot();
    const git = (...args: string[]) => {
        const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout.trim();
    };
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'commit.gpgSign', 'false');
    fs.mkdirSync(path.join(root, 'apps/desktop/src/database'), { recursive: true });
    fs.writeFileSync(path.join(root, 'apps/desktop/src/database/seed.sql'), 'fixture');
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'fixture');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    git('add', 'apps/desktop/src/database/seed.sql', 'pnpm-lock.yaml', 'package.json');
    git('commit', '-qm', 'fixture');
    return root;
}

function createEvidenceRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-run-'));
    cleanup.push(root);
    fs.mkdirSync(path.join(root, 'raw/formal'), { recursive: true });
    return root;
}

function runHarness(root: string, args: string[]) {
    return runCommand(root, ['run', ...args]);
}

function runCommand(root: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, [RUN_CLI, ...argv], {
        encoding: 'utf8',
        env: {
            ...process.env,
            TOUCHAI_PERF_EVIDENCE: root,
            TOUCHAI_PERF_ARTIFACTS: path.join(root, 'artifacts'),
            ...env,
        },
        timeout: 30000,
    });
}

function persistedProtocol(warmSamples: number) {
    return {
        comparison: null,
        modelEndpoint,
        flows: ['latency'],
        latencyBlocks: 1,
        progressBlocks: 3,
        longBlocks: 6,
        historyLevels: [100, 500, 1000],
        railPolicies: { baseline: 'all', current: 'sampled' },
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

describe('user previews and resumes the desktop performance run', () => {
    it('user must choose a baseline instead of silently comparing an obsolete release', () => {
        expect(() => resolveComparison(comparisonRepository(), undefined, 'HEAD')).toThrow(
            '--baseline'
        );
    });

    it('user records resolved immutable commits for the selected comparable arms', () => {
        const root = comparisonRepository();
        const head = spawnSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
        }).stdout.trim();
        expect(resolveComparison(root, 'HEAD', 'HEAD')).toMatchObject({
            baselineCommit: head,
            candidateCommit: head,
        });
    });

    it('user cannot reuse candidate dependencies when the baseline lockfile differs', () => {
        const root = comparisonRepository();
        fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'changed');
        spawnSync('git', ['add', 'pnpm-lock.yaml'], { cwd: root });
        spawnSync('git', ['commit', '-qm', 'changed dependencies'], { cwd: root });
        expect(() => resolveComparison(root, 'HEAD^', 'HEAD')).toThrow('dependency');
    });

    it('user can compare a script-only package change with the same dependency graph', () => {
        const root = comparisonRepository();
        fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"check":"node check.mjs"}}');
        spawnSync('git', ['add', 'package.json'], { cwd: root });
        spawnSync('git', ['commit', '-qm', 'script change'], { cwd: root });
        expect(() => resolveComparison(root, 'HEAD^', 'HEAD')).not.toThrow();
    });

    it('user cannot compare different native dependency manifests', () => {
        const root = comparisonRepository();
        fs.mkdirSync(path.join(root, 'apps/desktop/src-tauri'), { recursive: true });
        fs.writeFileSync(
            path.join(root, 'apps/desktop/src-tauri/Cargo.toml'),
            '[package]\nname = "touchai"\nversion = "0.1.0"\n'
        );
        fs.writeFileSync(path.join(root, 'apps/desktop/src-tauri/Cargo.lock'), 'version = 3\n');
        spawnSync(
            'git',
            ['add', 'apps/desktop/src-tauri/Cargo.toml', 'apps/desktop/src-tauri/Cargo.lock'],
            { cwd: root }
        );
        spawnSync('git', ['commit', '-qm', 'add native manifests'], { cwd: root });
        fs.writeFileSync(
            path.join(root, 'apps/desktop/src-tauri/Cargo.toml'),
            '[package]\nname = "touchai"\nversion = "0.2.0"\n'
        );
        spawnSync('git', ['add', 'apps/desktop/src-tauri/Cargo.toml'], { cwd: root });
        spawnSync('git', ['commit', '-qm', 'change native dependency'], { cwd: root });

        expect(() => resolveComparison(root, 'HEAD^', 'HEAD')).toThrow('Cargo.toml');
    });

    it('user cannot compare different database artifacts under the no-schema-change protocol', () => {
        const root = comparisonRepository();
        fs.writeFileSync(path.join(root, 'apps/desktop/src/database/seed.sql'), 'changed');
        spawnSync('git', ['add', 'apps/desktop/src/database/seed.sql'], { cwd: root });
        spawnSync('git', ['commit', '-qm', 'changed data'], { cwd: root });
        expect(() => resolveComparison(root, 'HEAD^', 'HEAD')).toThrow('database artifacts');
    });

    it('user builds each workspace package from its own measured snapshot', () => {
        const root = createEvidenceRoot();
        const checkout = path.join(root, 'checkout');
        const snapshot = path.join(root, 'snapshot');
        fs.mkdirSync(path.join(checkout, 'apps/desktop/node_modules/@touchai'), {
            recursive: true,
        });
        fs.mkdirSync(path.join(checkout, 'node_modules'), { recursive: true });
        fs.mkdirSync(path.join(checkout, 'packages/models/node_modules'), { recursive: true });
        fs.mkdirSync(path.join(snapshot, 'packages/models'), { recursive: true });
        fs.writeFileSync(
            path.join(snapshot, 'packages/models/package.json'),
            '{"name":"@touchai/models"}'
        );
        fs.symlinkSync(
            path.join(checkout, 'packages/models'),
            path.join(checkout, 'apps/desktop/node_modules/@touchai/models')
        );

        linkSnapshotDependencies(snapshot, checkout);

        expect(
            fs.realpathSync(path.join(snapshot, 'apps/desktop/node_modules/@touchai/models'))
        ).toBe(path.join(snapshot, 'packages/models'));
    });

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

    it('user cannot start another command while the evidence lock is held', () => {
        const root = createEvidenceRoot();
        const lockPath = performanceHarnessLockPath(root);
        const statsFile = path.join(root, 'stats.json');
        const summaryFile = path.join(root, 'summary.md');
        fs.writeFileSync(statsFile, 'existing stats\n');
        fs.writeFileSync(summaryFile, 'existing summary\n');
        fs.writeFileSync(
            lockPath,
            `${JSON.stringify({ command: 'run', pid: process.pid, token: 'held' })}\n`
        );

        try {
            const result = runCommand(root, ['stats']);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('Another performance harness command');
            expect(fs.readFileSync(statsFile, 'utf8')).toBe('existing stats\n');
            expect(fs.readFileSync(summaryFile, 'utf8')).toBe('existing summary\n');
        } finally {
            fs.rmSync(lockPath, { force: true });
        }
    });

    it.each(['temporary directory', 'symbolic link'])(
        'user cannot overwrite locked evidence through a different %s',
        (alias) => {
            const root = createEvidenceRoot();
            const evidence = path.join(root, 'evidence');
            const artifacts = path.join(root, 'artifacts');
            fs.mkdirSync(evidence);
            fs.mkdirSync(artifacts);
            const alternate = path.join(root, 'alternate');
            const temporary = path.join(root, 'tmp');
            fs.mkdirSync(temporary);
            fs.symlinkSync(evidence, alternate, 'junction');
            const summary = path.join(evidence, 'summary.md');
            fs.writeFileSync(summary, 'preserved evidence');
            const lock = acquirePerformanceHarnessLock({
                command: 'run',
                evidenceRoot: evidence,
                artifactsRoot: artifacts,
            });
            try {
                const result = runCommand(
                    alias === 'symbolic link' ? alternate : evidence,
                    ['stats'],
                    {
                        ...(alias === 'temporary directory'
                            ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary }
                            : {}),
                        // Do not let the artifact lock mask a missing evidence lock.
                        TOUCHAI_PERF_ARTIFACTS: path.join(root, 'other-artifacts'),
                    }
                );
                expect(result.status).toBe(1);
                expect(result.stderr).toContain('Another performance harness command');
                expect(fs.readFileSync(summary, 'utf8')).toBe('preserved evidence');
            } finally {
                lock.release();
            }
        }
    );

    it.skipIf(process.platform === 'win32')(
        'user cannot read the previous comparison after snapshot preparation fails',
        () => {
            const root = createEvidenceRoot();
            const manifest = path.join(root, 'source-manifest.json');
            fs.writeFileSync(manifest, '{"comparison":{"stale":true}}\n');
            const bin = path.join(root, 'bin');
            fs.mkdirSync(bin);
            for (const command of ['git', 'tar']) {
                const executable = spawnSync('which', [command], {
                    encoding: 'utf8',
                }).stdout.trim();
                fs.symlinkSync(executable, path.join(bin, command));
            }
            fs.writeFileSync(
                path.join(bin, 'pnpm'),
                '#!/bin/sh\necho injected-pnpm-failure >&2\nexit 1\n',
                { mode: 0o755 }
            );

            const result = spawnSync(
                process.execPath,
                [RUN_CLI, 'prepare', '--baseline', 'HEAD', '--candidate', 'HEAD'],
                {
                    encoding: 'utf8',
                    env: {
                        ...process.env,
                        PATH: bin,
                        TOUCHAI_PERF_EVIDENCE: root,
                        TOUCHAI_PERF_ARTIFACTS: path.join(root, 'artifacts'),
                    },
                    timeout: 60000,
                }
            );

            expect(result.status).toBe(1);
            expect(result.stderr).toContain('injected-pnpm-failure');
            expect(fs.existsSync(manifest)).toBe(false);
        }
    );

    it.each(['changed', 'added configuration', 'added source'])(
        'user cannot build a snapshot with %s inputs after preparation',
        (change) => {
            const root = createEvidenceRoot();
            const snapshot = path.join(root, 'snapshots/current');
            const source = path.join(snapshot, 'package.json');
            fs.mkdirSync(path.dirname(source), { recursive: true });
            fs.writeFileSync(source, '{"name":"prepared"}\n');
            const comparison = {
                baselineCommit: 'a'.repeat(40),
                candidateCommit: 'b'.repeat(40),
            };
            const armManifest = path.join(root, 'manifests/current-source-manifest.json');
            fs.mkdirSync(path.dirname(armManifest), { recursive: true });
            fs.writeFileSync(
                armManifest,
                JSON.stringify({
                    version: MANIFEST_VERSION,
                    arm: 'current',
                    snapshot,
                    comparison,
                    entries: [
                        {
                            path: 'package.json',
                            type: 'file',
                            sha256: sha256File(source),
                        },
                    ],
                })
            );
            fs.writeFileSync(
                path.join(root, 'source-manifest.json'),
                JSON.stringify({
                    version: MANIFEST_VERSION,
                    comparison,
                    current: {
                        path: armManifest,
                        sha256: sha256File(armManifest),
                    },
                })
            );

            expect(() => verifyPreparedSnapshot('current', snapshot, root)).not.toThrow();
            if (change !== 'changed') {
                const added = change === 'added configuration' ? 'vite.config.js' : 'new-module.ts';
                fs.writeFileSync(path.join(snapshot, added), 'export default {};\n');
                expect(() => verifyPreparedSnapshot('current', snapshot, root)).toThrow(added);
                return;
            }
            fs.writeFileSync(source, '{"name":"changed-after-prepare"}\n');
            expect(() => verifyPreparedSnapshot('current', snapshot, root)).toThrow(
                'changed package.json after prepare'
            );
        }
    );

    it('user cannot record a startup settle that the workload does not use', () => {
        const root = createEvidenceRoot();
        const result = runCommand(
            root,
            ['run', '--dry-run', '--flows', 'latency', '--latency-blocks', '1'],
            { TOUCHAI_PERF_STARTUP_SETTLE_MS: '0' }
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('TOUCHAI_PERF_STARTUP_SETTLE_MS');
    });

    it.each([
        ['warm-samples', '1.5'],
        ['latency-blocks', '2.5'],
        ['memory-interval-ms', '250.5'],
    ])('user cannot record fractional --%s', (option, value) => {
        const root = createEvidenceRoot();
        const result = runHarness(root, [
            '--dry-run',
            '--flows',
            'latency',
            '--latency-blocks',
            '1',
            '--warm-samples',
            '0',
            `--${option}`,
            value,
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`--${option}`);
    });

    it.each([
        ['250', 'Unsupported'],
        ['100,100', 'duplicate'],
    ])('user cannot plan unsupported or duplicate history level %s', (historyLevels, error) => {
        const root = createEvidenceRoot();
        const result = runHarness(root, [
            '--dry-run',
            '--flows',
            'long-session',
            '--long-blocks',
            '1',
            '--history-levels',
            historyLevels,
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(error);
    });

    it('user can explicitly plan the supported 1500-message history level', () => {
        const root = createEvidenceRoot();
        const result = runHarness(root, [
            '--dry-run',
            '--flows',
            'long-session',
            '--long-blocks',
            '1',
            '--history-levels',
            '1500',
        ]);

        expect(result.status).toBe(0);
        expect([
            ...new Set(
                JSON.parse(result.stdout).map((item: { historyLevel: number }) => item.historyLevel)
            ),
        ]).toEqual([1500]);
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

    it('user cannot resume the all command because it rebuilds binaries and fixtures', () => {
        const root = createEvidenceRoot();
        const planFile = path.join(root, 'run-plan.json');
        fs.writeFileSync(planFile, 'saved-plan\n');

        const result = runCommand(root, ['all', '--resume']);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('run.mjs run --resume');
        expect(fs.readFileSync(planFile, 'utf8')).toBe('saved-plan\n');
    });

    it.each([
        { exitCode: 1, valid: false },
        { exitCode: 0, valid: false },
        { exitCode: 0, valid: true, notificationFailures: 1 },
    ])('user cannot retry a recorded failed measurement through resume: %o', (failure) => {
        const root = createEvidenceRoot();
        fs.writeFileSync(
            path.join(root, 'run-plan.json'),
            JSON.stringify({ protocol: persistedProtocol(0) })
        );
        const runs = path.join(root, 'raw/formal/runs.jsonl');
        const record =
            JSON.stringify({
                type: 'run',
                runId: 'failed-sample',
                flow: 'latency',
                block: 1,
                sequenceIndex: 1,
                arm: 'baseline',
                ...failure,
            }) + '\n';
        fs.writeFileSync(runs, record);
        const result = runHarness(root, [
            '--resume',
            '--dry-run',
            '--flows',
            'latency',
            '--latency-blocks',
            '1',
            '--warm-samples',
            '0',
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('failed-sample');
        expect(fs.readFileSync(runs, 'utf8')).toBe(record);
    });

    it('user resumes only unattempted measurements after a permitted display startup failure', () => {
        const root = createEvidenceRoot();
        fs.writeFileSync(
            path.join(root, 'run-plan.json'),
            JSON.stringify({ protocol: persistedProtocol(0) })
        );
        fs.writeFileSync(
            path.join(root, 'raw/formal/runs.jsonl'),
            [
                {
                    type: 'run-launch',
                    runId: 'completed-baseline',
                    flow: 'latency',
                    block: 1,
                    sequenceIndex: 1,
                    arm: 'baseline',
                    historyLevel: null,
                    fixture: 'base',
                    attempt: 1,
                },
                {
                    type: 'run',
                    runId: 'completed-baseline',
                    flow: 'latency',
                    block: 1,
                    sequenceIndex: 1,
                    arm: 'baseline',
                    historyLevel: null,
                    fixture: 'base',
                    exitCode: 0,
                    valid: true,
                    attempt: 1,
                },
                {
                    type: 'run-launch',
                    runId: 'retry-current',
                    flow: 'latency',
                    block: 1,
                    sequenceIndex: 2,
                    arm: 'current',
                    historyLevel: null,
                    fixture: 'base',
                    attempt: 1,
                },
                {
                    type: 'run-attempt',
                    runId: 'retry-current',
                    flow: 'latency',
                    block: 1,
                    sequenceIndex: 2,
                    arm: 'current',
                    historyLevel: null,
                    fixture: 'base',
                    exitCode: 1,
                    valid: false,
                    retryReason: 'display-startup-failure',
                    attempt: 1,
                },
            ]
                .map((record) => JSON.stringify(record))
                .join('\n') + '\n'
        );
        fs.writeFileSync(
            path.join(root, 'raw/formal/events.jsonl'),
            `${JSON.stringify({
                type: 'run-start',
                runId: 'completed-baseline',
                arm: 'baseline',
                flow: 'latency',
                block: 1,
            })}\n`
        );
        const result = runHarness(root, [
            '--resume',
            '--dry-run',
            '--flows',
            'latency',
            '--latency-blocks',
            '1',
            '--warm-samples',
            '0',
        ]);
        expect(result.status).toBe(0);
        expect(
            JSON.parse(result.stdout).map(
                (record: { sequenceIndex: number }) => record.sequenceIndex
            )
        ).toEqual([2, 3, 4]);
    });

    it('user cannot repeat a started workload whose terminal record was interrupted', () => {
        const root = createEvidenceRoot();
        fs.writeFileSync(
            path.join(root, 'run-plan.json'),
            JSON.stringify({ protocol: persistedProtocol(0) })
        );
        fs.writeFileSync(
            path.join(root, 'raw/formal/events.jsonl'),
            JSON.stringify({ type: 'run-start', runId: 'interrupted-sample' }) + '\n'
        );
        const result = runHarness(root, [
            '--resume',
            '--dry-run',
            '--flows',
            'latency',
            '--latency-blocks',
            '1',
            '--warm-samples',
            '0',
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('interrupted-sample');
    });

    it('user cannot repeat a workload whose launch record has no terminal result', () => {
        const root = createEvidenceRoot();
        fs.writeFileSync(
            path.join(root, 'run-plan.json'),
            JSON.stringify({ protocol: persistedProtocol(0) })
        );
        fs.writeFileSync(
            path.join(root, 'raw/formal/runs.jsonl'),
            JSON.stringify({ type: 'run-launch', runId: 'interrupted-launch' }) + '\n'
        );
        const result = runHarness(root, [
            '--resume',
            '--dry-run',
            '--flows',
            'latency',
            '--latency-blocks',
            '1',
            '--warm-samples',
            '0',
        ]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('interrupted-launch');
    });
});

describe('user validates desktop performance measurement evidence', () => {
    it('user keeps an early sampler exit even after WebDriver finishes', () => {
        const sampler = createSamplerWatch();
        sampler.noteExit(1, null);

        expect(sampler.earlyExit()).toEqual({ code: 1, signal: null });
        expect(
            samplerFailureReason({
                earlyExit: sampler.earlyExit(),
                error: null,
            })
        ).toBe('stopped before WebDriver completed (exit 1 signal null)');
    });

    it('user does not flag a sampler that only stops after the measurement ends', () => {
        const sampler = createSamplerWatch();

        expect(sampler.earlyExit()).toBeNull();
        expect(
            samplerFailureReason({
                earlyExit: sampler.earlyExit(),
                error: null,
            })
        ).toBeNull();
    });

    it('user sees a sampler crash as a failure even when WebDriver exits cleanly', () => {
        expect(
            samplerFailureReason({
                earlyExit: null,
                error: new Error('spawn failed'),
            })
        ).toBe('failed: spawn failed');
    });

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

    it('user sees a launch failure as an invalid measurement', () => {
        expect(
            measurementInvalidReasons({
                exitCode: null,
                signal: null,
                notificationFailures: 0,
                samplerFailure: null,
                launchError: new Error('spawn failed'),
            })
        ).toEqual(['measurement launch failed: spawn failed']);
    });
});
