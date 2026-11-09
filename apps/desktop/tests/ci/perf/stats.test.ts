// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const STATS_CLI = path.resolve(testDirectory, '../../../scripts/perf/710/stats.mjs');
const cleanup: string[] = [];

interface SyntheticRun {
    runId: string;
    arm: 'baseline' | 'current';
    block: number;
    sequenceIndex: number;
    durationMs: number;
    firstTextMs: number;
    valid?: boolean;
    notificationFailures?: number;
    invalidReasons?: string[];
}

function createEvidenceRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-stats-'));
    cleanup.push(root);
    fs.mkdirSync(path.join(root, 'raw/formal'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'run-plan.json'),
        `${JSON.stringify(
            {
                protocol: {
                    flows: ['latency'],
                    historyLevels: [],
                    warmSamples: 0,
                },
            },
            null,
            4
        )}\n`
    );
    return root;
}

function writeFixtureManifest(root: string): void {
    const fixtures = {
        base: { sha256: 'base-fixture-sha', businessOracleSha256: 'base-oracle' },
        'long-100': { sha256: 'long-fixture-sha', businessOracleSha256: 'long-oracle' },
    };
    fs.writeFileSync(
        path.join(root, 'fixture-manifest.json'),
        `${JSON.stringify(
            {
                version: 1,
                arms: {
                    baseline: {
                        sourceBinarySha256: 'baseline-binary-sha',
                        migrationTags: ['0000_lyrical_toad', '0004_ordinary_solo'],
                        fixtures,
                    },
                    current: {
                        sourceBinarySha256: 'current-binary-sha',
                        migrationTags: [
                            '0000_lyrical_toad',
                            '0004_ordinary_solo',
                            '0005_performance_query_indexes',
                        ],
                        fixtures,
                    },
                },
                businessOracles: {
                    base: {
                        baseline: 'base-oracle',
                        current: 'base-oracle',
                    },
                    'long-100': {
                        baseline: 'long-oracle',
                        current: 'long-oracle',
                    },
                },
            },
            null,
            4
        )}\n`
    );
}

function writeSyntheticRuns(root: string, runs: SyntheticRun[]): void {
    const records = runs.map((run) => ({
        type: 'run',
        runId: run.runId,
        arm: run.arm,
        flow: 'latency',
        block: run.block,
        sequenceIndex: run.sequenceIndex,
        historyLevel: null,
        exitCode: 0,
        signal: null,
        notificationFailures: run.notificationFailures ?? 0,
        valid: run.valid ?? true,
        invalidReasons: run.invalidReasons ?? [],
        fixture: 'base',
        fixtureSha256: 'base-fixture-sha',
        binarySha256: `${run.arm}-binary-sha`,
    }));
    fs.writeFileSync(
        path.join(root, 'raw/formal/runs.jsonl'),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(root, 'raw/formal/events.jsonl'),
        runs
            .flatMap((run) => [
                {
                    type: 'latency',
                    runId: run.runId,
                    arm: run.arm,
                    mode: 'cold',
                    durationMs: run.durationMs,
                    firstTextMs: run.firstTextMs,
                },
            ])
            .map((event) => JSON.stringify(event))
            .join('\n') + '\n'
    );
    fs.writeFileSync(path.join(root, 'raw/formal/pss.jsonl'), '');
}

function writeSyntheticLongSessionRuns(root: string): void {
    fs.writeFileSync(
        path.join(root, 'run-plan.json'),
        `${JSON.stringify(
            {
                protocol: {
                    flows: ['long-session'],
                    historyLevels: [100],
                    warmSamples: 0,
                },
            },
            null,
            4
        )}\n`
    );
    const order = ['baseline', 'current', 'current', 'baseline'] as const;
    const runs = [];
    const events = [];
    const memory = [];
    for (let block = 1; block <= 3; block += 1) {
        for (const [offset, arm] of order.entries()) {
            const sequenceIndex = offset + 1;
            const runId = `long-session-h100-b${block}-s${sequenceIndex}-${arm}`;
            const at = block * 100_000 + sequenceIndex * 10_000;
            const isBaseline = arm === 'baseline';
            const baselinePss = isBaseline ? 1_000_000 : 980_000;
            const retainedPss = isBaseline ? 1_100_000 : 1_080_000;
            const settledPss = isBaseline ? 1_050_000 : 1_040_000;
            runs.push({
                type: 'run',
                runId,
                arm,
                flow: 'long-session',
                block,
                sequenceIndex,
                historyLevel: 100,
                exitCode: 0,
                signal: null,
                notificationFailures: 0,
                valid: true,
                invalidReasons: [],
                fixture: 'long-100',
                fixtureSha256: 'long-fixture-sha',
                binarySha256: `${arm}-binary-sha`,
            });
            events.push(
                {
                    type: 'long-phase',
                    runId,
                    arm,
                    flow: 'long-session',
                    block,
                    phase: 'baseline',
                    at: at + 100,
                },
                {
                    type: 'long-phase',
                    runId,
                    arm,
                    flow: 'long-session',
                    block,
                    phase: 'retained',
                    at: at + 1_000,
                    domNodes: isBaseline ? 2_000 : 2_001,
                },
                {
                    type: 'long-phase',
                    runId,
                    arm,
                    flow: 'long-session',
                    block,
                    phase: 'stream-start',
                    at: at + 1_100,
                },
                {
                    type: 'long-phase',
                    runId,
                    arm,
                    flow: 'long-session',
                    block,
                    phase: 'terminal',
                    at: at + 2_000,
                },
                {
                    type: 'long-phase',
                    runId,
                    arm,
                    flow: 'long-session',
                    block,
                    phase: 'settled',
                    at: at + 3_000,
                }
            );
            const memorySamples: Array<[number, number]> = [
                [at + 100, baselinePss],
                [at + 1_000, retainedPss],
                [at + 2_900, settledPss],
                [at + 3_001, 0],
            ];
            for (const [sampleAt, totalPssKb] of memorySamples) {
                memory.push({
                    type: 'memory',
                    at: sampleAt,
                    runId,
                    arm,
                    flow: 'long-session',
                    processes:
                        totalPssKb > 0 ? [{ pid: 1, name: 'TouchAI', pssKb: totalPssKb }] : [],
                    totalPssKb,
                });
            }
        }
    }
    fs.writeFileSync(
        path.join(root, 'raw/formal/runs.jsonl'),
        runs.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(root, 'raw/formal/events.jsonl'),
        events.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(root, 'raw/formal/pss.jsonl'),
        memory.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );
}

function runStats(root: string) {
    const result = spawnSync(process.execPath, [STATS_CLI], {
        encoding: 'utf8',
        env: { ...process.env, TOUCHAI_PERF_EVIDENCE: root },
        timeout: 30000,
    });
    expect(result.error).toBeUndefined();
    return result;
}

function readStats(root: string) {
    return JSON.parse(fs.readFileSync(path.join(root, 'stats.json'), 'utf8'));
}

function coldOnlyRuns(blocks = 4): SyntheticRun[] {
    const order = ['baseline', 'current', 'current', 'baseline'] as const;
    return Array.from({ length: blocks }, (_, blockIndex) =>
        order.map((arm, sequenceIndex) => ({
            runId: `latency-b${blockIndex + 1}-s${sequenceIndex + 1}-${arm}`,
            arm,
            block: blockIndex + 1,
            sequenceIndex: sequenceIndex + 1,
            durationMs: 1000,
            firstTextMs: 400,
        }))
    ).flat();
}

afterAll(() => {
    for (const root of cleanup) fs.rmSync(root, { recursive: true, force: true });
});

describe('user reads the RFC 710 performance statistics', () => {
    describe('given a cold-only protocol', () => {
        it('user sees only cold gates and no misleading BLOCKED warm rows', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            writeSyntheticRuns(root, coldOnlyRuns());

            const result = runStats(root);
            const stats = readStats(root);

            expect(result.status).toBe(0);
            expect(stats.enabledFlows).toEqual(['latency']);
            expect(stats.overallStatus).toBe('PASS');
            expect(stats.latency.modes).toEqual(['cold']);
            expect(stats.latency.metrics.map((metric: { id: string }) => metric.id)).not.toContain(
                'warm.duration.median'
            );
            expect(stats.progress.status).toBe('NOT_RUN');
            expect(stats.longSession.status).toBe('NOT_RUN');
            expect(stats.fixtureManifest.present).toBe(true);
            expect(stats.fixtureManifest.arms.baseline.migrationTags).not.toContain(
                '0005_performance_query_indexes'
            );
            expect(stats.fixtureManifest.arms.current.migrationTags).toContain(
                '0005_performance_query_indexes'
            );
            expect(
                stats.latency.metrics.every(
                    (metric: { clusterMethod: string }) => metric.clusterMethod === 'paired-block'
                )
            ).toBe(true);
        });
    });

    describe('given a run with a native notification failure', () => {
        it('user sees the invalid launch excluded from the gate', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            const runs = coldOnlyRuns(3);
            for (const index of [9, 10]) {
                const run = runs[index];
                if (!run) throw new Error(`Synthetic run ${index} is missing.`);
                runs[index] = {
                    ...run,
                    valid: false,
                    notificationFailures: 2,
                    invalidReasons: ['2 native notification failures'],
                };
            }
            writeSyntheticRuns(root, runs);

            const result = runStats(root);
            const stats = readStats(root);

            expect(result.status).toBe(0);
            expect(stats.rawCounts.validRuns).toBe(10);
            expect(stats.rawCounts.invalidRuns).toBe(2);
            expect(stats.invalidRuns[0].notificationFailures).toBe(2);
            expect(stats.overallStatus).toBe('BLOCKED');
            expect(stats.latency.status).toBe('BLOCKED');
        });
    });

    describe('given a settled event after the app exits', () => {
        it('user sees settled memory from the last live sample instead of the zero tail', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            writeSyntheticLongSessionRuns(root);

            const result = runStats(root);
            const stats = readStats(root);
            const settled = stats.longSession.levels[0].metrics.find(
                (metric: { id: string }) => metric.id === 'long-100.settled.pss'
            );

            expect(result.status).toBe(0);
            expect(settled.status).toBe('AUX');
            expect(settled.armStats.current.median).toBeGreaterThan(0);
            expect(
                settled.armStats.current.runs.every(
                    ([, values]: [string, number[]]) => (values[0] ?? 0) > 0
                )
            ).toBe(true);
        });
    });

    describe('given a fixture generated by the wrong binary arm', () => {
        it('user sees a fixture mismatch invalidate the affected run instead of passing', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            const runs = coldOnlyRuns(4);
            for (const run of runs.filter((candidate) => candidate.arm === 'baseline')) {
                run.durationMs = 900;
            }
            writeSyntheticRuns(root, runs);
            const runsPath = path.join(root, 'raw/formal/runs.jsonl');
            const records = fs
                .readFileSync(runsPath, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            records[0].fixtureSha256 = 'fixture-generated-by-current';
            fs.writeFileSync(
                runsPath,
                `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
            );

            const result = runStats(root);
            const stats = readStats(root);

            expect(result.status).toBe(0);
            expect(stats.rawCounts.invalidRuns).toBe(1);
            expect(stats.invalidRuns[0].invalidReasons).toContain(
                'fixture hash mismatch for baseline/base'
            );
            expect(stats.overallStatus).toBe('FAIL');
        });
    });

    describe('given a run without the binary hash', () => {
        it('user sees the run invalidated instead of trusting an incomplete manifest', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            writeSyntheticRuns(root, coldOnlyRuns());
            const runsPath = path.join(root, 'raw/formal/runs.jsonl');
            const records = fs
                .readFileSync(runsPath, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            for (const record of records) delete record.binarySha256;
            fs.writeFileSync(
                runsPath,
                `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
            );

            const result = runStats(root);
            const stats = readStats(root);

            expect(result.status).toBe(0);
            expect(stats.invalidRuns[0].invalidReasons).toContain(
                'run is missing binary hash for baseline'
            );
            expect(stats.rawCounts.validRuns).toBe(0);
            expect(stats.overallStatus).toBe('BLOCKED');
        });
    });

    describe('given fixtures with different business oracles', () => {
        it('user sees every run for that fixture invalidated', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            const manifestPath = path.join(root, 'fixture-manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            manifest.businessOracles.base.current = 'different-oracle';
            fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
            writeSyntheticRuns(root, coldOnlyRuns());

            const result = runStats(root);
            const stats = readStats(root);

            expect(result.status).toBe(0);
            expect(
                stats.invalidRuns.every((run: { invalidReasons: string[] }) =>
                    run.invalidReasons.includes('fixture business oracle mismatch for base')
                )
            ).toBe(true);
            expect(stats.rawCounts.validRuns).toBe(0);
            expect(stats.overallStatus).toBe('BLOCKED');
        });
    });
});
