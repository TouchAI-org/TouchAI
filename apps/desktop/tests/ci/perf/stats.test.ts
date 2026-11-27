// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { MANIFEST_VERSION, modelEndpoint } from '../../../scripts/perf/lib/config.mjs';
import { nearestMemoryBefore } from '../../../scripts/perf/stats/statistics.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const RUN_CLI = path.resolve(testDirectory, '../../../scripts/perf/run.mjs');
const cleanup: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const comparison = {
    baselineCommit: 'a'.repeat(40),
    candidateCommit: 'b'.repeat(40),
};

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
    const sources: Record<string, { path: string; sha256: string }> = {};
    const builds = ['baseline', 'current'].map((arm) => {
        const manifest = JSON.stringify({
            version: MANIFEST_VERSION,
            comparison,
            arm,
            entries: [],
        });
        const relative = `manifests/${arm}.json`;
        fs.mkdirSync(path.join(root, 'manifests'), { recursive: true });
        fs.writeFileSync(path.join(root, relative), manifest);
        sources[arm] = { path: relative, sha256: hash(manifest) };
        const binary = `binaries/${arm}/TouchAI`;
        fs.mkdirSync(path.dirname(path.join(root, binary)), { recursive: true });
        fs.writeFileSync(path.join(root, binary), `${arm}-binary`);
        return {
            arm,
            binary,
            comparison,
            exitCode: 0,
            signal: null,
            binarySha256: hash(`${arm}-binary`),
            sourceManifestSha256: hash(manifest),
        };
    });
    fs.writeFileSync(
        path.join(root, 'source-manifest.json'),
        JSON.stringify({ version: MANIFEST_VERSION, comparison, ...sources })
    );
    fs.writeFileSync(path.join(root, 'builds.json'), JSON.stringify({ builds }));
    fs.writeFileSync(
        path.join(root, 'run-plan.json'),
        `${JSON.stringify(
            {
                protocol: {
                    comparison,
                    flows: ['latency'],
                    historyLevels: [],
                    latencyBlocks: 4,
                    warmSamples: 0,
                },
            },
            null,
            4
        )}\n`
    );
    return root;
}

function writeFixtureManifest(root: string, historyLevels = [100]): void {
    fs.mkdirSync(path.join(root, 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(root, 'fixtures/base.db'), 'base-fixture');
    for (const level of historyLevels)
        fs.writeFileSync(path.join(root, `fixtures/long-${level}.db`), 'long-fixture');
    const fixtures = {
        base: {
            path: 'fixtures/base.db',
            sha256: hash('base-fixture'),
            businessOracleSha256: 'base-oracle',
        },
        ...Object.fromEntries(
            historyLevels.map((level) => [
                `long-${level}`,
                {
                    path: `fixtures/long-${level}.db`,
                    sha256: hash('long-fixture'),
                    businessOracleSha256: 'long-oracle',
                },
            ])
        ),
    };
    fs.writeFileSync(
        path.join(root, 'fixture-manifest.json'),
        `${JSON.stringify(
            {
                version: MANIFEST_VERSION,
                comparison,
                modelEndpoint,
                arms: {
                    baseline: {
                        sourceBinarySha256: hash('baseline-binary'),
                        migrationTags: ['0000_lyrical_toad', '0004_ordinary_solo'],
                        fixtures,
                    },
                    current: {
                        sourceBinarySha256: hash('current-binary'),
                        migrationTags: ['0000_lyrical_toad', '0004_ordinary_solo'],
                        fixtures,
                    },
                },
                businessOracles: {
                    base: {
                        baseline: 'base-oracle',
                        current: 'base-oracle',
                    },
                    ...Object.fromEntries(
                        historyLevels.map((level) => [
                            `long-${level}`,
                            {
                                baseline: 'long-oracle',
                                current: 'long-oracle',
                            },
                        ])
                    ),
                },
            },
            null,
            4
        )}\n`
    );
}

function writeRunPlan(
    root: string,
    runs: Array<{
        arm: 'baseline' | 'current';
        flow?: string;
        block: number;
        sequenceIndex: number;
        fixture?: string;
        historyLevel?: number | null;
    }>
): void {
    const planFile = path.join(root, 'run-plan.json');
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    plan.plan = runs.map((run) => ({
        arm: run.arm,
        flow: run.flow ?? 'latency',
        block: run.block,
        sequenceIndex: run.sequenceIndex,
        fixture: run.fixture ?? 'base',
        historyLevel: run.historyLevel ?? 0,
    }));
    const planItems = plan.plan as Array<{
        arm: 'baseline' | 'current';
        flow: string;
        block: number;
        sequenceIndex: number;
        fixture: string;
        historyLevel: number;
    }>;
    plan.protocol.flows = [...new Set(planItems.map((item) => item.flow))];
    for (const [flow, key] of [
        ['latency', 'latencyBlocks'],
        ['progress', 'progressBlocks'],
        ['long-session', 'longBlocks'],
    ] as const) {
        const blocks = planItems.filter((item) => item.flow === flow).map((item) => item.block);
        if (blocks.length > 0) plan.protocol[key] = Math.max(...blocks);
    }
    plan.protocol.historyLevels = [
        ...new Set(
            planItems
                .filter((item) => item.flow === 'long-session')
                .map((item) => item.historyLevel)
        ),
    ];
    plan.protocol.modelEndpoint = modelEndpoint;
    fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 4)}\n`);
    writeModelEvidence(root);
}

function writeModelEvidence(root: string): void {
    const raw = path.join(root, 'raw/formal');
    const runs = fs
        .readFileSync(path.join(raw, 'runs.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const events = fs
        .readFileSync(path.join(raw, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    const model = [];
    for (const event of events) {
        const run = runs.find((run) => run.runId === event.runId);
        event.flow ??= run.flow;
        event.block ??= run.block;
        if (!['latency', 'long-stream', 'progress-task', 'progress-warmup'].includes(event.type))
            continue;
        Object.assign(
            event,
            event.flow === 'latency'
                ? {
                      rounds: 12,
                      chunks: 24,
                      chunkBytes: 32,
                      chunkDelayMs: 8,
                      alternate: false,
                      sample: 'cold',
                  }
                : event.flow === 'progress'
                  ? { rounds: 24, chunks: 128, chunkBytes: 1024, chunkDelayMs: 1, alternate: true }
                  : {
                        rounds: 2,
                        chunks: 32,
                        chunkBytes: 256,
                        chunkDelayMs: 8,
                        alternate: false,
                        sample: 0,
                    }
        );
        event.promptId = `${run.runId}-${event.sample}`;
        const identity = {
            runId: event.runId,
            arm: event.arm,
            block: event.block,
            flow: event.flow,
            promptId: event.promptId,
            rounds: event.rounds,
            chunks: event.chunks,
            chunkBytes: event.chunkBytes,
            chunkDelayMs: event.chunkDelayMs,
            alternate: event.alternate,
        };
        for (let toolCount = 0; toolCount <= event.rounds; toolCount++) {
            model.push({ ...identity, type: 'request', toolCount, at: 1000 + toolCount });
        }
        model.push({ ...identity, type: 'complete', toolCount: event.rounds, at: 2000 });
        if (event.screenshot) {
            event.screenshot = `logs/${event.runId}-stream.png`;
            fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
            fs.writeFileSync(path.join(root, event.screenshot), 'test screenshot');
        }
    }
    for (const event of events.filter((event) => event.type === 'long-rail')) {
        event.screenshot = `logs/${event.runId}-rail.png`;
        fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
        fs.writeFileSync(path.join(root, event.screenshot), 'test screenshot');
    }
    fs.writeFileSync(
        path.join(raw, 'events.jsonl'),
        events.map((event) => JSON.stringify(event)).join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(raw, 'model-server.jsonl'),
        model.map((event) => JSON.stringify(event)).join('\n') + '\n'
    );
}

function writeSyntheticRuns(root: string, runs: SyntheticRun[], plannedRuns = runs): void {
    const records = runs.flatMap((run) => {
        const identity = {
            runId: run.runId,
            arm: run.arm,
            flow: 'latency',
            block: run.block,
            sequenceIndex: run.sequenceIndex,
            historyLevel: null,
            fixture: 'base',
            fixtureSha256: hash('base-fixture'),
            binarySha256: hash(`${run.arm}-binary`),
            attempt: 1,
        };
        return [
            { type: 'run-launch', ...identity },
            {
                type: 'run',
                ...identity,
                exitCode: run.valid === false ? 1 : 0,
                signal: null,
                notificationFailures: run.notificationFailures ?? 0,
                valid: run.valid ?? true,
                invalidReasons: run.invalidReasons ?? [],
            },
        ];
    });
    fs.writeFileSync(
        path.join(root, 'raw/formal/runs.jsonl'),
        records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    );
    fs.writeFileSync(
        path.join(root, 'raw/formal/events.jsonl'),
        runs
            .flatMap((run) => [
                {
                    type: 'run-start',
                    runId: run.runId,
                    arm: run.arm,
                    flow: 'latency',
                    block: run.block,
                },
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
    writeRunPlan(root, plannedRuns);
}

function writeSyntheticLongSessionRuns(root: string, historyLevel = 100): void {
    const fixture = `long-${historyLevel}`;
    const turnCount = Math.ceil(historyLevel / 2);
    fs.writeFileSync(
        path.join(root, 'run-plan.json'),
        `${JSON.stringify(
            {
                protocol: {
                    comparison,
                    flows: ['long-session'],
                    historyLevels: [historyLevel],
                    warmSamples: 0,
                    memoryIntervalMs: 250,
                    railPolicies: { baseline: 'all', current: 'sampled' },
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
            const runId = `long-session-h${historyLevel}-b${block}-s${sequenceIndex}-${arm}`;
            const at = block * 100_000 + sequenceIndex * 10_000;
            const isBaseline = arm === 'baseline';
            const tickCount = isBaseline ? turnCount : Math.min(turnCount, 96);
            const baselinePss = isBaseline ? 1_000_000 : 980_000;
            const retainedPss = isBaseline ? 1_100_000 : 1_080_000;
            const settledPss = isBaseline ? 1_050_000 : 1_040_000;
            runs.push({
                type: 'run-launch',
                runId,
                arm,
                flow: 'long-session',
                block,
                sequenceIndex,
                historyLevel,
                fixture,
                fixtureSha256: hash('long-fixture'),
                binarySha256: hash(`${arm}-binary`),
                attempt: 1,
            });
            runs.push({
                type: 'run',
                runId,
                arm,
                flow: 'long-session',
                block,
                sequenceIndex,
                historyLevel,
                exitCode: 0,
                signal: null,
                notificationFailures: 0,
                valid: true,
                invalidReasons: [],
                fixture,
                fixtureSha256: hash('long-fixture'),
                binarySha256: hash(`${arm}-binary`),
                attempt: 1,
            });
            events.push(
                {
                    type: 'run-start',
                    runId,
                    arm,
                    flow: 'long-session',
                    block,
                },
                {
                    type: 'long-phase',
                    runId,
                    arm,
                    phase: 'open-start',
                    at: at + 200,
                },
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
            events.push(
                {
                    type: 'long-rail',
                    runId,
                    arm,
                    historyLevel,
                    turnCount,
                    tickCount,
                    sampled: tickCount < turnCount,
                    screenshot: `/tmp/${runId}-rail.png`,
                    steps: [
                        {
                            target: 'first',
                            targetIndex: 0,
                            durationMs: isBaseline ? 40 : 38,
                            scrollTopBefore: 5_000,
                            scrollTopAfter: 0,
                            endDistanceAfter: 5_000,
                            moved: true,
                            focusedBefore: true,
                            focusedAfter: true,
                            activeTarget: true,
                        },
                        {
                            target: 'last',
                            targetIndex: tickCount - 1,
                            durationMs: isBaseline ? 45 : 42,
                            scrollTopBefore: 0,
                            scrollTopAfter: 5_000,
                            endDistanceAfter: 0,
                            moved: true,
                            focusedBefore: true,
                            focusedAfter: true,
                            activeTarget: true,
                        },
                    ],
                },
                {
                    type: 'long-stream',
                    runId,
                    arm,
                    mode: 'long-stream',
                    durationMs: isBaseline ? 500 : 480,
                    firstTextMs: isBaseline ? 200 : 190,
                    screenshot: `/tmp/${runId}-stream.png`,
                    settled: {
                        busy: 'false',
                        atEnd: true,
                        durationMs: isBaseline ? 550 : 525,
                        settleMs: isBaseline ? 50 : 45,
                        mutationCount: isBaseline ? 100 : 90,
                        frameCount: isBaseline ? 30 : 32,
                        frameGapSamples: isBaseline ? 29 : 31,
                        frameGapDropped: 0,
                        frameGapP95Ms: isBaseline ? 20 : 19,
                        frameGapMaxMs: isBaseline ? 30 : 28,
                        frameGapOver50Ms: 0,
                        domNodes: 2_000,
                        messageCount: 100,
                        bodyTextChars: 20_000,
                        assistantTextChars: 1_000,
                        railTicks: isBaseline ? turnCount + 1 : Math.min(turnCount + 1, 96),
                        scrollTop: 5_000,
                        scrollHeight: 5_400,
                        clientHeight: 400,
                    },
                }
            );
            const memorySamples = new Map<number, number>();
            for (let sampleAt = at + 100; sampleAt <= at + 3_000; sampleAt += 250) {
                memorySamples.set(
                    sampleAt,
                    sampleAt >= at + 3_000
                        ? settledPss
                        : sampleAt >= at + 1_000
                          ? retainedPss
                          : baselinePss
                );
            }
            for (const phaseAt of [at + 200, at + 1_000, at + 1_100, at + 2_000]) {
                memorySamples.set(phaseAt, phaseAt >= at + 1_000 ? retainedPss : baselinePss);
            }
            memorySamples.delete(at + 3_000);
            memorySamples.set(at + 2_900, settledPss);
            memorySamples.set(at + 3_001, 0);
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
    writeRunPlan(
        root,
        runs.filter((run) => run.type === 'run').map((run) => ({ ...run, historyLevel }))
    );
}

function runStats(root: string) {
    const result = spawnStats(root);
    expect(result.error).toBeUndefined();
    return result;
}

function spawnStats(root: string) {
    return spawnSync(process.execPath, [RUN_CLI, 'stats'], {
        encoding: 'utf8',
        env: { ...process.env, TOUCHAI_PERF_EVIDENCE: root },
        timeout: 30000,
    });
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

function writeSyntheticProgressRuns(root: string, sparse = true): void {
    fs.writeFileSync(
        path.join(root, 'run-plan.json'),
        `${JSON.stringify(
            {
                protocol: {
                    comparison,
                    flows: ['progress'],
                    historyLevels: [],
                    warmSamples: 0,
                    progressWarmups: 1,
                    progressTasks: 1,
                    memoryIntervalMs: 250,
                },
            },
            null,
            4
        )}\n`
    );
    const order = ['baseline', 'current', 'current', 'baseline'] as const;
    const records = [];
    const events = [];
    const memory = [];
    const plan = [];
    for (let block = 1; block <= 3; block += 1) {
        for (const [offset, arm] of order.entries()) {
            const sequenceIndex = offset + 1;
            const runId = `progress-b${block}-s${sequenceIndex}-${arm}`;
            const startAt = block * 1_000_000 + sequenceIndex * 200_000;
            const endAt = startAt + 120_000;
            const identity = {
                runId,
                arm,
                flow: 'progress',
                block,
                sequenceIndex,
                historyLevel: 0,
                fixture: 'base',
                fixtureSha256: hash('base-fixture'),
                binarySha256: hash(`${arm}-binary`),
                attempt: 1,
            };
            records.push(
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
                    type: 'progress-warmup',
                    runId,
                    arm,
                    sample: 'warmup-0',
                    mode: null,
                    durationMs: 1000,
                },
                { type: 'progress-window', runId, arm, phase: 'start', at: startAt },
                { type: 'progress-task', runId, arm, sample: 0, mode: null, durationMs: 1000 },
                { type: 'progress-window', runId, arm, phase: 'end', at: endAt }
            );
            for (const at of sparse
                ? [startAt + 60_000]
                : Array.from({ length: 481 }, (_, index) => startAt + index * 250))
                memory.push({
                    type: 'memory',
                    at,
                    runId,
                    arm,
                    flow: 'progress',
                    processes: [{ pid: 1, name: 'TouchAI', pssKb: 1_000_000 }],
                    totalPssKb: 1_000_000,
                });
            plan.push(identity);
        }
    }
    fs.writeFileSync(
        path.join(root, 'raw/formal/runs.jsonl'),
        `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    fs.writeFileSync(
        path.join(root, 'raw/formal/events.jsonl'),
        `${events.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    fs.writeFileSync(
        path.join(root, 'raw/formal/pss.jsonl'),
        `${memory.map((record) => JSON.stringify(record)).join('\n')}\n`
    );
    writeRunPlan(root, plan);
}

afterAll(() => {
    for (const root of cleanup) fs.rmSync(root, { recursive: true, force: true });
});

describe('user reads the desktop performance statistics', () => {
    it('user keeps the idle baseline from before history opening starts', () => {
        const samples = [
            { at: 800, totalPssKb: 900_000 },
            { at: 1_040, totalPssKb: 1_000_000 },
        ];

        expect(nearestMemoryBefore(samples, 1_000)?.totalPssKb).toBe(900_000);
    });

    it('user cannot pass fixtures generated for a different model endpoint', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        const manifestPath = path.join(root, 'fixture-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.modelEndpoint = 'http://127.0.0.1:9999/v1';
        fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).toBe('BLOCKED');
        expect(stats.rawCounts.validRuns).toBe(0);
        expect(stats.invalidRuns[0].invalidReasons[0]).toContain(
            'fixture manifest endpoint mismatch'
        );
    });

    it.each([
        ['builds.json', 'missing'],
        ['builds.json', 'malformed'],
        ['raw/formal/model-server.jsonl', 'missing'],
        ['raw/formal/model-server.jsonl', 'malformed'],
        ['manifests/baseline.json', 'missing'],
        ['binaries/current/TouchAI', 'changed'],
    ])('user cannot pass when required evidence %s is %s', (file, damage) => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        runStats(root);
        expect(readStats(root).overallStatus).toBe('PASS');
        if (damage === 'missing') fs.rmSync(path.join(root, file), { force: true });
        else fs.writeFileSync(path.join(root, file), 'changed or malformed');
        const result = spawnSync(process.execPath, [RUN_CLI, 'gate'], {
            encoding: 'utf8',
            env: { ...process.env, TOUCHAI_PERF_EVIDENCE: root },
            timeout: 30000,
        });
        expect(result.status).toBe(1);
        if (fs.existsSync(path.join(root, 'stats.json'))) {
            expect(readStats(root).overallStatus).not.toBe('PASS');
        }
    });

    it.each([
        'missing completion',
        'duplicate request',
        'wrong rounds',
        'wrong identity',
        'failed tool history',
    ])('user rejects model evidence with %s', (damage) => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        const file = path.join(root, 'raw/formal/model-server.jsonl');
        const records = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        if (damage === 'missing completion')
            records.splice(
                records.findIndex((record) => record.type === 'complete'),
                1
            );
        if (damage === 'duplicate request') records.push(records[0]);
        if (damage === 'wrong rounds') records[0].rounds = 0;
        if (damage === 'wrong identity') records[0].runId = 'other-run';
        if (damage === 'failed tool history') records[0].type = 'invalid-tool-history';
        fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
        runStats(root);
        expect(readStats(root).overallStatus).toBe('BLOCKED');
    });

    it('user validates a downloaded evidence package without the original machine paths', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root, [500]);
        writeSyntheticLongSessionRuns(root, 500);
        const relocated = createEvidenceRoot();
        fs.cpSync(root, relocated, { recursive: true });
        fs.rmSync(root, { recursive: true });
        const result = spawnSync(process.execPath, [RUN_CLI, 'gate'], {
            encoding: 'utf8',
            env: { ...process.env, TOUCHAI_PERF_EVIDENCE: relocated, TOUCHAI_PERF_PORT: '4445' },
            timeout: 30000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(readStats(relocated).overallStatus).toBe('PASS');
    });

    it('user cannot validate long-session screenshots missing from the downloaded package', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root, [500]);
        writeSyntheticLongSessionRuns(root, 500);
        fs.rmSync(path.join(root, 'logs'), { recursive: true });
        runStats(root);
        expect(readStats(root).overallStatus).toBe('BLOCKED');
        expect(readStats(root).rawCounts.invalidRuns).toBe(12);
    });

    it.each(['binarySha256', 'fixtureSha256'])(
        'user cannot pass when a launch changes its %s before completion',
        (field) => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            writeSyntheticRuns(root, coldOnlyRuns());
            const file = path.join(root, 'raw/formal/runs.jsonl');
            const records = fs
                .readFileSync(file, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            records[0][field] = '0'.repeat(64);
            fs.writeFileSync(
                file,
                records.map((record) => JSON.stringify(record)).join('\n') + '\n'
            );
            runStats(root);
            expect(readStats(root).overallStatus).toBe('BLOCKED');
            expect(readStats(root).lifecycleErrors.join('\n')).toContain(field);
        }
    );

    it.each([
        ['flow', 'progress'],
        ['block', 99],
        ['rounds', 0],
    ])('user cannot pass a sample whose %s contradicts its workload', (field, value) => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        const file = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        events.find((event) => event.type === 'latency')[field] = value;
        fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
        runStats(root);
        expect(readStats(root).overallStatus).toBe('BLOCKED');
        expect(readStats(root).rawCounts.invalidRuns).toBe(1);
    });

    it('user cannot pass when an extra invalid launch exists beside enough complete blocks', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        const runs = coldOnlyRuns(4);
        writeSyntheticRuns(root, runs);
        const record = fs
            .readFileSync(path.join(root, 'raw/formal/runs.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .find((candidate) => candidate.type === 'run');
        if (!record) throw new Error('Synthetic terminal run is missing.');
        record.runId = 'invalid-extra';
        record.valid = false;
        fs.appendFileSync(path.join(root, 'raw/formal/runs.jsonl'), `${JSON.stringify(record)}\n`);

        runStats(root);
        expect(readStats(root).overallStatus).not.toBe('PASS');
        const summary = fs.readFileSync(path.join(root, 'summary.md'), 'utf8');
        expect(summary).toContain('Overall: **BLOCKED**');
        expect(summary).toContain('Invalid runs: 1');
    });

    it('user cannot pass with an unfinished launch beside an otherwise complete plan', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        fs.appendFileSync(
            path.join(root, 'raw/formal/runs.jsonl'),
            `${JSON.stringify({
                type: 'run-launch',
                runId: 'unfinished-extra',
                arm: 'baseline',
                flow: 'latency',
                block: 1,
                sequenceIndex: 1,
                historyLevel: 0,
                attempt: 2,
            })}\n`
        );

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).toBe('BLOCKED');
        expect(stats.rawCounts.lifecycleErrors).toBe(1);
        expect(stats.lifecycleErrors[0]).toContain('unfinished-extra');
    });

    it('user cannot pass when two successful runs occupy the same planned slot', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        const runs = coldOnlyRuns();
        writeSyntheticRuns(root, [...runs, { ...runs[0]!, runId: 'duplicate-planned-slot' }], runs);

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).toBe('BLOCKED');
        expect(stats.rawCounts.lifecycleErrors).toBeGreaterThan(0);
        expect(stats.lifecycleErrors.join('\n')).toContain('duplicate-planned-slot');
    });

    it('user cannot pass when a successful run is outside the persisted plan', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        const runs = coldOnlyRuns();
        writeSyntheticRuns(
            root,
            [
                ...runs,
                {
                    runId: 'outside-plan',
                    arm: 'baseline',
                    block: 99,
                    sequenceIndex: 1,
                    durationMs: 1000,
                    firstTextMs: 400,
                },
            ],
            runs
        );

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).toBe('BLOCKED');
        expect(stats.lifecycleErrors.join('\n')).toContain('outside-plan');
    });

    it('user cannot pass when a workload start has the wrong identity', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        const file = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const start = events.find((event) => event.type === 'run-start');
        if (!start) throw new Error('Synthetic workload start is missing.');
        start.arm = start.arm === 'baseline' ? 'current' : 'baseline';
        fs.writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).toBe('BLOCKED');
        expect(stats.lifecycleErrors.join('\n')).toContain('mismatched identity');
    });

    it('user cannot pass with an extra allowed retry after a successful run', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        const first = coldOnlyRuns()[0]!;
        const identity = {
            runId: 'retry-after-success',
            arm: first.arm,
            flow: 'latency',
            block: first.block,
            sequenceIndex: first.sequenceIndex,
            historyLevel: null,
            fixture: 'base',
            fixtureSha256: hash('base-fixture'),
            binarySha256: hash(`${first.arm}-binary`),
            attempt: 2,
        };
        fs.appendFileSync(
            path.join(root, 'raw/formal/runs.jsonl'),
            [
                { type: 'run-launch', ...identity },
                {
                    type: 'run-attempt',
                    ...identity,
                    exitCode: 1,
                    signal: null,
                    notificationFailures: 0,
                    valid: false,
                    invalidReasons: ['display failed'],
                    retryReason: 'display-startup-failure',
                },
            ]
                .map((record) => JSON.stringify(record))
                .join('\n') + '\n'
        );

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).toBe('BLOCKED');
        expect(stats.lifecycleErrors.join('\n')).toContain('continued after a successful run');
    });

    it('user cannot pass a successful run that skipped the approved startup retry', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        const runs = coldOnlyRuns();
        writeSyntheticRuns(root, runs);
        const file = path.join(root, 'raw/formal/runs.jsonl');
        const records = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        for (const record of records) {
            if (record.runId === runs[0]!.runId) record.attempt = 2;
        }
        fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).toBe('BLOCKED');
        expect(stats.lifecycleErrors.join('\n')).toContain('unapproved attempt sequence');
    });

    it('user cannot pass a two-minute progress window with one memory sample', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticProgressRuns(root);

        runStats(root);
        const stats = readStats(root);

        expect(stats.overallStatus).not.toBe('PASS');
        expect(stats.rawCounts.invalidRuns).toBe(12);
        expect(
            stats.invalidRuns.every((run: { invalidReasons: string[] }) =>
                run.invalidReasons.some((reason) => reason.includes('memory coverage'))
            )
        ).toBe(true);
    });

    it('user can validate a complete progress workload and adequately sampled memory window', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticProgressRuns(root, false);

        runStats(root);
        expect(readStats(root).overallStatus).toBe('PASS');
        expect(readStats(root).rawCounts.validRuns).toBe(12);
    });

    it('user sees the selected baseline and candidate instead of a historical hardcoded commit', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());

        runStats(root);
        expect(readStats(root)).toMatchObject(comparison);
    });

    it('user cannot combine a run plan with fixtures from a different comparison', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        fs.writeFileSync(
            path.join(root, 'source-manifest.json'),
            JSON.stringify({ comparison: { ...comparison, baselineCommit: 'c'.repeat(40) } })
        );

        runStats(root);
        expect(readStats(root).overallStatus).not.toBe('PASS');
    });

    it('user cannot pass by dropping a missing latency sample from an otherwise complete run', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns());
        const file = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const latency = events.find((event) => event.type === 'latency');
        if (!latency) throw new Error('Synthetic latency event is missing.');
        latency.durationMs = null;
        fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

        runStats(root);
        expect(readStats(root).overallStatus).not.toBe('PASS');
        expect(readStats(root).rawCounts.invalidRuns).toBe(1);
    });

    it('user cannot pass a memory run whose retained observation has no usable sample', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticLongSessionRuns(root);
        const file = path.join(root, 'raw/formal/pss.jsonl');
        const samples = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const firstRun = samples[0].runId;
        fs.writeFileSync(
            file,
            samples
                .filter((sample) => sample.runId !== firstRun)
                .map((sample) => JSON.stringify(sample))
                .join('\n') + '\n'
        );

        runStats(root);
        expect(readStats(root).overallStatus).not.toBe('PASS');
        expect(readStats(root).rawCounts.invalidRuns).toBe(1);
    });

    it('user cannot pass a long-session run without a retained sample before streaming', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticLongSessionRuns(root);
        const eventsFile = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(eventsFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const firstRunId = events[0].runId;
        const retained = events.find(
            (event) =>
                event.runId === firstRunId &&
                event.type === 'long-phase' &&
                event.phase === 'retained'
        );
        const streamStart = events.find(
            (event) =>
                event.runId === firstRunId &&
                event.type === 'long-phase' &&
                event.phase === 'stream-start'
        );
        const firstRun = JSON.parse(
            fs.readFileSync(path.join(root, 'raw/formal/runs.jsonl'), 'utf8').split('\n')[0]!
        );
        const memoryFile = path.join(root, 'raw/formal/pss.jsonl');
        const samples = fs
            .readFileSync(memoryFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter(
                (sample) =>
                    !(
                        sample.runId === firstRunId &&
                        sample.at >= retained.at - 1_000 &&
                        sample.at <= streamStart.at
                    )
            );
        samples.push({
            type: 'memory',
            at: streamStart.at + 60,
            runId: firstRunId,
            arm: firstRun.arm,
            flow: 'long-session',
            processes: [{ pid: 1, name: 'TouchAI', pssKb: 1_090_000 }],
            totalPssKb: 1_090_000,
        });
        fs.writeFileSync(
            memoryFile,
            `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`
        );

        runStats(root);
        const stats = readStats(root);

        expect(stats.rawCounts.invalidRuns).toBe(1);
        expect(stats.invalidRuns[0].invalidReasons).toContain(
            'long-session retained observations are missing or invalid'
        );
    });

    it('user cannot pass a native long-session run without rail navigation evidence', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticLongSessionRuns(root);
        const eventsFile = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(eventsFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
            .filter((event) => event.type !== 'long-rail');
        fs.writeFileSync(
            eventsFile,
            `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
        );

        runStats(root);
        const stats = readStats(root);

        expect(stats.rawCounts.invalidRuns).toBe(12);
        expect(
            stats.invalidRuns.every((run: { invalidReasons: string[] }) =>
                run.invalidReasons.includes('long-session rail evidence is missing or duplicated')
            )
        ).toBe(true);
    });

    it.each([500, 1000])(
        'user compares an unsampled baseline with a sampled candidate at %s messages',
        (level) => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root, [level]);
            writeSyntheticLongSessionRuns(root, level);

            runStats(root);
            const stats = readStats(root);

            expect(stats.rawCounts.invalidRuns).toBe(0);
            expect(stats.longSession.status).toBe('PASS');
            const metrics = stats.longSession.levels[0].uiMetrics;
            const railTicks = metrics.find(
                (metric: { id: string }) => metric.id === `long-${level}.rail.ticks`
            );
            const frameGap = metrics.find(
                (metric: { id: string }) => metric.id === `long-${level}.stream.frame-gap.p95`
            );
            expect(railTicks.armStats.current.median).toBe(96);
            expect(railTicks.armStats.baseline.median).toBe(level / 2);
            expect(frameGap.gate).toBe(false);
            expect(frameGap.status).toBe('AUX');
        }
    );

    it('user cannot pass rail evidence above the 96-tick rendering bound', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root, [500]);
        writeSyntheticLongSessionRuns(root, 500);
        const eventsFile = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(eventsFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const rail = events.find((event) => event.type === 'long-rail' && event.arm === 'current');
        rail.tickCount = 97;
        rail.steps[1].targetIndex = 96;
        fs.writeFileSync(
            eventsFile,
            `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
        );

        runStats(root);
        const stats = readStats(root);

        expect(stats.rawCounts.invalidRuns).toBe(1);
        expect(stats.invalidRuns[0].invalidReasons).toContain(
            'long-session rail evidence is invalid'
        );
    });

    it('user compares two sampled rails when the declared baseline already has sampling', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root, [500]);
        writeSyntheticLongSessionRuns(root, 500);
        const planFile = path.join(root, 'run-plan.json');
        const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        plan.protocol.railPolicies.baseline = 'sampled';
        fs.writeFileSync(planFile, JSON.stringify(plan));
        const file = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(file, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        for (const event of events.filter((event) => event.arm === 'baseline')) {
            if (event.type === 'long-rail') {
                event.tickCount = 96;
                event.sampled = true;
                event.steps[1].targetIndex = 95;
            }
            if (event.type === 'long-stream') event.settled.railTicks = 96;
        }
        fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

        runStats(root);
        expect(readStats(root).overallStatus).toBe('PASS');
    });

    it('user cannot pass a native long-session run without a final streaming snapshot', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticLongSessionRuns(root);
        const eventsFile = path.join(root, 'raw/formal/events.jsonl');
        const events = fs
            .readFileSync(eventsFile, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        const firstRunId = events[0].runId;
        const stream = events.find(
            (event) => event.runId === firstRunId && event.type === 'long-stream'
        );
        stream.settled.busy = 'true';
        fs.writeFileSync(
            eventsFile,
            `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
        );

        runStats(root);
        const stats = readStats(root);

        expect(stats.rawCounts.invalidRuns).toBe(1);
        expect(stats.invalidRuns[0].invalidReasons).toContain(
            'long-session streaming final-state evidence is invalid'
        );
    });

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
            expect(stats.fixtureManifest.arms.baseline.migrationTags).toEqual(
                stats.fixtureManifest.arms.current.migrationTags
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
            expect(stats.longSession.status).toBe('PASS');
            expect(stats.rawCounts.lifecycleErrors).toBe(0);
            expect(settled.status).toBe('AUX');
            expect(settled.armStats.current.median).toBe(1_040_000);
            expect(settled.armStats.baseline.median).toBe(1_050_000);
            expect(
                settled.armStats.current.runs.every(
                    ([, values]: [string, number[]]) => (values[0] ?? 0) > 0
                )
            ).toBe(true);
            const summary = fs.readFileSync(path.join(root, 'summary.md'), 'utf8');
            expect(summary).toContain('#### Native UI');
            expect(summary).toContain('rail navigation P95');
            expect(summary).toContain('streaming frame-gap P95');
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
            const baselineRun = records.find(
                (record) => record.type === 'run' && record.arm === 'baseline'
            );
            if (!baselineRun) throw new Error('Synthetic baseline run is missing.');
            baselineRun.fixtureSha256 = 'fixture-generated-by-current';
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

    describe('given a run and manifest without fixture hashes', () => {
        it('user sees the run invalidated instead of matching two missing hashes', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            writeSyntheticRuns(root, coldOnlyRuns());
            const runsPath = path.join(root, 'raw/formal/runs.jsonl');
            const records = fs
                .readFileSync(runsPath, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            for (const record of records) delete record.fixtureSha256;
            fs.writeFileSync(
                runsPath,
                `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
            );
            const manifestPath = path.join(root, 'fixture-manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            for (const arm of ['baseline', 'current']) {
                delete manifest.arms[arm].fixtures.base.sha256;
            }
            fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);

            runStats(root);
            const stats = readStats(root);

            expect(stats.rawCounts.validRuns).toBe(0);
            expect(stats.invalidRuns[0].invalidReasons).toContain(
                'baseline/base fixture evidence is missing or changed'
            );
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

    describe('given malformed raw evidence', () => {
        it('user sees the source file and line instead of a silently omitted record', () => {
            const root = createEvidenceRoot();
            const eventsPath = path.join(root, 'raw/formal/events.jsonl');
            fs.writeFileSync(eventsPath, '{"type":"valid"}\nnot-json\n');

            const result = spawnStats(root);

            expect(result.status).toBe(1);
            expect(result.stderr).toContain(`${eventsPath}:2`);
            expect(result.stderr).toContain('Invalid JSONL');
        });
    });

    describe('given only part of the persisted run plan', () => {
        it('user sees incomplete planned blocks excluded from a passing gate', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            const planned = coldOnlyRuns(4);
            const completed = planned.filter((run) => run.block <= 2);
            writeSyntheticRuns(root, completed, planned);

            const result = runStats(root);
            const stats = readStats(root);

            expect(result.status).toBe(0);
            expect(stats.rawCounts.missingPlannedRuns).toBe(8);
            expect(stats.latency.metrics[0].excludedClusterCount).toBe(2);
            expect(stats.overallStatus).toBe('BLOCKED');
        });
    });

    describe('given a plan that omits required A/B/B/A slots', () => {
        it('user sees the declared protocol reject the incomplete saved plan', () => {
            const root = createEvidenceRoot();
            writeFixtureManifest(root);
            const truncated = coldOnlyRuns(3).filter((run) => run.sequenceIndex <= 2);
            writeSyntheticRuns(root, truncated, truncated);

            const result = runStats(root);
            const stats = readStats(root);

            expect(result.status).toBe(0);
            expect(stats.overallStatus).toBe('BLOCKED');
            expect(stats.lifecycleErrors.join('\n')).toContain('declared protocol requires 12');
        });
    });

    it('user sees excluded cluster counts scoped to the metric flow', () => {
        const root = createEvidenceRoot();
        writeFixtureManifest(root);
        writeSyntheticRuns(root, coldOnlyRuns(3));
        const planPath = path.join(root, 'run-plan.json');
        const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
        plan.plan.push({
            arm: 'baseline',
            flow: 'progress',
            block: 1,
            sequenceIndex: 1,
            fixture: 'base',
            historyLevel: 0,
        });
        fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 4)}\n`);

        runStats(root);
        const latency = readStats(root).latency.metrics[0];

        expect(latency.excludedClusterCount).toBe(0);
    });
});
