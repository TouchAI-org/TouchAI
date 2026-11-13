import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const evidenceRoot = path.resolve(
    process.env.TOUCHAI_PERF_EVIDENCE ?? '/root/.cache/touchai-verify/710/perf-20261101'
);
const rawRoot = path.join(evidenceRoot, 'raw', 'formal');
const bootstrapIterations = 10000;
const minimumRunsPerArm = 3;
const minimumBlocksPerArm = 3;
const regressionUpperBound = 1.05;
const arms = ['baseline', 'current'];
const fixtureManifestVersion = 1;

function readJsonLines(file) {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const records = [];
    for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try {
            records.push(JSON.parse(line));
        } catch (error) {
            throw new Error(
                `Invalid JSONL at ${file}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            );
        }
    }
    return records;
}

function readJsonFile(file) {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isValidRun(record) {
    return (
        record.valid !== false &&
        record.exitCode === 0 &&
        (record.signal === null || record.signal === undefined) &&
        (record.notificationFailures ?? 0) === 0
    );
}

function fixtureValidationError(run, fixtureManifest) {
    if (!fixtureManifest) return 'fixture manifest is missing';
    if (fixtureManifest.version !== fixtureManifestVersion) {
        return `fixture manifest version mismatch: expected ${fixtureManifestVersion}, got ${fixtureManifest.version ?? 'missing'}`;
    }
    const arm = fixtureManifest.arms?.[run.arm];
    if (!arm) return `fixture manifest is missing arm ${run.arm ?? 'unknown'}`;
    if (!arm.sourceBinarySha256) {
        return `fixture manifest is missing source binary hash for ${run.arm}`;
    }
    if (!run.binarySha256) {
        return `run is missing binary hash for ${run.arm}`;
    }
    if (run.binarySha256 !== arm.sourceBinarySha256) {
        return `fixture manifest binary mismatch for ${run.arm}`;
    }
    const fixture = arm.fixtures?.[run.fixture];
    if (!fixture) {
        return `fixture manifest is missing ${run.arm}/${run.fixture ?? 'unknown'}`;
    }
    if (run.fixtureSha256 !== fixture.sha256) {
        return `fixture hash mismatch for ${run.arm}/${run.fixture}`;
    }
    if (!fixture.businessOracleSha256) {
        return `fixture manifest is missing business oracle for ${run.arm}/${run.fixture}`;
    }
    const oraclePair = fixtureManifest.businessOracles?.[run.fixture];
    if (
        !oraclePair ||
        !oraclePair.baseline ||
        !oraclePair.current ||
        oraclePair.baseline !== oraclePair.current
    ) {
        return `fixture business oracle mismatch for ${run.fixture}`;
    }
    if (fixture.businessOracleSha256 !== oraclePair[run.arm]) {
        return `fixture business oracle does not match ${run.arm}/${run.fixture}`;
    }
    return null;
}

function applyFixtureValidation(runs, fixtureManifest) {
    return runs.map((run) => {
        const reason = fixtureValidationError(run, fixtureManifest);
        if (!reason) return run;
        return {
            ...run,
            valid: false,
            invalidReasons: [...(run.invalidReasons ?? []), reason],
        };
    });
}

function quantile(values, probability) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 1) return sorted[0];
    const index = (sorted.length - 1) * probability;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    const weight = index - lower;
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values) {
    return quantile(values, 0.5);
}

function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function ratio(numerator, denominator) {
    if (
        typeof numerator !== 'number' ||
        typeof denominator !== 'number' ||
        !Number.isFinite(numerator) ||
        !Number.isFinite(denominator) ||
        denominator <= 0
    ) {
        return null;
    }
    return numerator / denominator;
}

function seededRandom(seedText) {
    let state = Number.parseInt(
        createHash('sha256').update(seedText).digest('hex').slice(0, 8),
        16
    );
    return () => {
        state += 0x6d2b79f5;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function sampleWithReplacement(values, random) {
    return Array.from(
        { length: values.length },
        () => values[Math.floor(random() * values.length)]
    );
}

function groupRunValues(rows, valueSelector) {
    const grouped = new Map();
    for (const row of rows) {
        const value = valueSelector(row);
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const values = grouped.get(row.runId) ?? [];
        values.push(value);
        grouped.set(row.runId, values);
    }
    return grouped;
}

function blockKeyForRun(run) {
    const block = Number(run?.block);
    if (!Number.isInteger(block) || block <= 0) return null;
    return `${run.flow ?? 'unknown'}:h${run.historyLevel ?? 0}:b${block}`;
}

function measurementKey(item) {
    return [item.flow, item.block, item.sequenceIndex, item.arm, item.historyLevel || 0].join(':');
}

function appendCluster(clusters, key, runId, values) {
    const cluster = clusters.get(key) ?? { values: [], runIds: new Set() };
    cluster.values.push(...values);
    cluster.runIds.add(runId);
    clusters.set(key, cluster);
}

function buildClusterModel(groupedByArm, runById, plannedItems = []) {
    const allRunIds = arms.flatMap((arm) => [...(groupedByArm[arm]?.keys() ?? [])]);
    const canPair =
        allRunIds.length > 0 &&
        allRunIds.every((runId) => blockKeyForRun(runById.get(runId)) !== null);

    if (!canPair) {
        const clustersByArm = Object.fromEntries(
            arms.map((arm) => {
                const clusters = new Map();
                for (const [runId, values] of groupedByArm[arm] ?? []) {
                    appendCluster(clusters, runId, runId, values);
                }
                return [arm, clusters];
            })
        );
        return {
            mode: 'independent-run',
            clustersByArm,
            clusterKeys: null,
            excludedClusterCount: 0,
        };
    }

    const clustersByArm = Object.fromEntries(
        arms.map((arm) => {
            const clusters = new Map();
            for (const [runId, values] of groupedByArm[arm] ?? []) {
                appendCluster(clusters, blockKeyForRun(runById.get(runId)), runId, values);
            }
            return [arm, clusters];
        })
    );
    const allKeys = new Set(arms.flatMap((arm) => [...clustersByArm[arm].keys()]));
    const availableKeysByArm = Object.fromEntries(
        arms.map((arm) => {
            const keys = new Set();
            for (const runId of groupedByArm[arm]?.keys() ?? []) {
                const run = runById.get(runId);
                if (run) keys.add(measurementKey(run));
            }
            return [arm, keys];
        })
    );
    const plannedByBlock = new Map();
    for (const item of plannedItems) {
        const key = blockKeyForRun(item);
        if (!key) continue;
        const items = plannedByBlock.get(key) ?? [];
        items.push(item);
        plannedByBlock.set(key, items);
    }
    const clusterKeys = [...allKeys]
        .filter((key) => {
            if (!arms.every((arm) => clustersByArm[arm].has(key))) return false;
            const planned = plannedByBlock.get(key);
            if (!planned || planned.length === 0) return plannedItems.length === 0;
            return planned.every((item) => availableKeysByArm[item.arm]?.has(measurementKey(item)));
        })
        .sort();
    const plannedKeys = new Set(plannedByBlock.keys());
    for (const key of allKeys) plannedKeys.add(key);
    return {
        mode: 'paired-block',
        clustersByArm,
        clusterKeys,
        excludedClusterCount: plannedKeys.size - clusterKeys.length,
    };
}

function flattenClusters(model, arm, clusterKeys) {
    return clusterKeys.flatMap((key) => model.clustersByArm[arm].get(key)?.values ?? []);
}

function runIdsForClusters(model, arm, clusterKeys) {
    const runIds = new Set();
    for (const key of clusterKeys) {
        for (const runId of model.clustersByArm[arm].get(key)?.runIds ?? []) {
            runIds.add(runId);
        }
    }
    return runIds;
}

function bootstrapClusterMetric(model, metric, seed) {
    const random = seededRandom(seed);
    const ratios = [];
    if (model.mode === 'paired-block') {
        if (model.clusterKeys.length < minimumBlocksPerArm) return null;
        for (let iteration = 0; iteration < bootstrapIterations; iteration += 1) {
            const selectedBlocks = sampleWithReplacement(model.clusterKeys, random);
            const baselineSamples = flattenClusters(model, 'baseline', selectedBlocks);
            const currentSamples = flattenClusters(model, 'current', selectedBlocks);
            const baselineMetric =
                metric === 'median' ? median(baselineSamples) : quantile(baselineSamples, 0.95);
            const currentMetric =
                metric === 'median' ? median(currentSamples) : quantile(currentSamples, 0.95);
            const value = ratio(currentMetric, baselineMetric);
            if (value !== null) ratios.push(value);
        }
    } else {
        const runGroups = Object.fromEntries(
            arms.map((arm) => [
                arm,
                [...model.clustersByArm[arm].values()].map((cluster) => cluster.values),
            ])
        );
        if (arms.some((arm) => runGroups[arm].length < minimumRunsPerArm)) {
            return null;
        }
        for (let iteration = 0; iteration < bootstrapIterations; iteration += 1) {
            const sampled = {};
            for (const arm of arms) {
                const selectedRuns = sampleWithReplacement(runGroups[arm], random);
                sampled[arm] = selectedRuns.flat();
            }
            const baselineMetric =
                metric === 'median' ? median(sampled.baseline) : quantile(sampled.baseline, 0.95);
            const currentMetric =
                metric === 'median' ? median(sampled.current) : quantile(sampled.current, 0.95);
            const value = ratio(currentMetric, baselineMetric);
            if (value !== null) ratios.push(value);
        }
    }
    if (ratios.length < bootstrapIterations * 0.95) return null;
    return {
        iterations: ratios.length,
        lower95: quantile(ratios, 0.025),
        upper95: quantile(ratios, 0.975),
    };
}

function summarizeMetric({
    id,
    label,
    unit,
    groupedByArm,
    runById,
    metric,
    gate,
    seed,
    notes = '',
    plannedItems = [],
}) {
    const model = buildClusterModel(groupedByArm, runById, plannedItems);
    const clusterKeysByArm =
        model.mode === 'paired-block'
            ? Object.fromEntries(arms.map((arm) => [arm, model.clusterKeys]))
            : Object.fromEntries(arms.map((arm) => [arm, [...model.clustersByArm[arm].keys()]]));
    const values = Object.fromEntries(
        arms.map((arm) => [arm, flattenClusters(model, arm, clusterKeysByArm[arm])])
    );
    const armStats = Object.fromEntries(
        arms.map((arm) => {
            const runIds = runIdsForClusters(model, arm, clusterKeysByArm[arm]);
            const includedRuns = [...(groupedByArm[arm]?.entries() ?? [])].filter(([runId]) =>
                runIds.has(runId)
            );
            return [
                arm,
                {
                    runCount: runIds.size,
                    blockCount: model.mode === 'paired-block' ? clusterKeysByArm[arm].length : null,
                    sampleCount: values[arm].length,
                    median: median(values[arm]),
                    p95: quantile(values[arm], 0.95),
                    mean: mean(values[arm]),
                    runs: includedRuns,
                },
            ];
        })
    );
    const observedRatio = ratio(armStats.current[metric], armStats.baseline[metric]);
    const bootstrap = bootstrapClusterMetric(model, metric, seed);
    const status =
        observedRatio === null || bootstrap === null
            ? 'BLOCKED'
            : !gate
              ? 'AUX'
              : bootstrap.upper95 <= regressionUpperBound
                ? 'PASS'
                : 'FAIL';
    return {
        id,
        label,
        unit,
        metric,
        gate,
        status,
        observedRatio,
        bootstrap,
        clusterMethod: model.mode,
        excludedClusterCount: model.excludedClusterCount,
        armStats,
        notes,
    };
}

function buildLatencyStats(events, runs, modes, plannedItems) {
    if (modes.length === 0) {
        return { status: 'NOT_RUN', modes, metrics: [] };
    }
    const runById = new Map(runs.map((run) => [run.runId, run]));
    const successfulRunIds = new Set(runs.map((run) => run.runId));
    const measured = events.filter(
        (event) =>
            event.type === 'latency' &&
            modes.includes(event.mode) &&
            successfulRunIds.has(event.runId)
    );
    const metricGroups = {};
    for (const mode of modes) {
        metricGroups[mode] = {};
        for (const field of ['durationMs', 'firstTextMs']) {
            metricGroups[mode][field] = Object.fromEntries(
                arms.map((arm) => [
                    arm,
                    groupRunValues(
                        measured.filter((event) => event.arm === arm && event.mode === mode),
                        (event) => event[field]
                    ),
                ])
            );
        }
    }

    const metrics = [];
    for (const mode of modes) {
        for (const metric of ['median', 'p95']) {
            metrics.push(
                summarizeMetric({
                    id: `${mode}.duration.${metric}`,
                    label: `${mode} Enter -> rendered DOM sentinel ${metric === 'median' ? 'P50' : 'P95'}`,
                    unit: 'ms',
                    groupedByArm: metricGroups[mode].durationMs,
                    runById,
                    metric,
                    gate: true,
                    seed: `latency-duration-${mode}-${metric}`,
                    plannedItems,
                })
            );
            metrics.push(
                summarizeMetric({
                    id: `${mode}.first-text.${metric}`,
                    label: `${mode} Enter -> first assistant text ${metric === 'median' ? 'P50' : 'P95'}`,
                    unit: 'ms',
                    groupedByArm: metricGroups[mode].firstTextMs,
                    runById,
                    metric,
                    gate: false,
                    seed: `latency-first-text-${mode}-${metric}`,
                    notes: 'Auxiliary user-visible metric; the RFC gate is Enter-to-sentinel.',
                    plannedItems,
                })
            );
        }
    }
    const gates = metrics.filter((item) => item.gate);
    const status = gates.some((item) => item.status === 'FAIL')
        ? 'FAIL'
        : gates.some((item) => item.status === 'BLOCKED')
          ? 'BLOCKED'
          : 'PASS';
    return { status, modes, metrics };
}

function groupMemoryByRun(memory) {
    const byRun = new Map();
    for (const record of memory) {
        if (
            record.type !== 'memory' ||
            typeof record.totalPssKb !== 'number' ||
            !Number.isFinite(record.totalPssKb) ||
            record.totalPssKb <= 0 ||
            !Array.isArray(record.processes) ||
            record.processes.length === 0
        ) {
            continue;
        }
        const values = byRun.get(record.runId) ?? [];
        values.push(record);
        byRun.set(record.runId, values);
    }
    return byRun;
}

function eventForRun(events, runId, type, phase) {
    return events.find(
        (event) => event.runId === runId && event.type === type && event.phase === phase
    );
}

function nearestMemory(samples, at, maxDistanceMs = 3000) {
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const sample of samples) {
        const distance = Math.abs(sample.at - at);
        if (distance < bestDistance) {
            best = sample;
            bestDistance = distance;
        }
    }
    return bestDistance <= maxDistanceMs ? best : null;
}

function buildProgressStats(events, memory, runs, enabled, plannedItems) {
    if (!enabled) {
        return { status: 'NOT_RUN', metrics: [], samples: [] };
    }
    const runById = new Map(runs.map((run) => [run.runId, run]));
    const memoryByRun = groupMemoryByRun(memory);
    const runRows = runs.filter((run) => run.flow === 'progress' && run.exitCode === 0);
    const steadyRows = [];
    const peakRows = [];
    for (const run of runRows) {
        const start = eventForRun(events, run.runId, 'progress-window', 'start');
        const end = eventForRun(events, run.runId, 'progress-window', 'end');
        const samples = memoryByRun.get(run.runId) ?? [];
        if (!start || !end) continue;
        const interval = samples.filter((sample) => sample.at >= start.at && sample.at <= end.at);
        if (interval.length === 0) continue;
        const lastHalfAt = start.at + (end.at - start.at) / 2;
        const lastHalf = interval.filter((sample) => sample.at >= lastHalfAt);
        const steadyValues = (lastHalf.length ? lastHalf : interval).map(
            (sample) => sample.totalPssKb
        );
        steadyRows.push({
            runId: run.runId,
            arm: run.arm,
            totalPssKb: median(steadyValues),
        });
        peakRows.push({
            runId: run.runId,
            arm: run.arm,
            totalPssKb: Math.max(...interval.map((sample) => sample.totalPssKb)),
        });
    }
    const groupedSteady = Object.fromEntries(
        arms.map((arm) => [
            arm,
            groupRunValues(
                steadyRows.filter((row) => row.arm === arm),
                (row) => row.totalPssKb
            ),
        ])
    );
    const groupedPeak = Object.fromEntries(
        arms.map((arm) => [
            arm,
            groupRunValues(
                peakRows.filter((row) => row.arm === arm),
                (row) => row.totalPssKb
            ),
        ])
    );
    const steady = summarizeMetric({
        id: 'progress.steady.pss',
        label: 'Progress-write steady-state PSS',
        unit: 'KiB',
        groupedByArm: groupedSteady,
        runById,
        metric: 'median',
        gate: true,
        seed: 'progress-steady-pss',
        notes: 'Median of the last half of the measured progress window, after warmups.',
        plannedItems,
    });
    const peak = summarizeMetric({
        id: 'progress.peak.pss',
        label: 'Progress-write measured-window peak PSS',
        unit: 'KiB',
        groupedByArm: groupedPeak,
        runById,
        metric: 'median',
        gate: false,
        seed: 'progress-peak-pss',
        notes: 'Auxiliary; peak is not the RFC steady-state budget.',
        plannedItems,
    });
    const status = steady.status;
    return { status, metrics: [steady, peak], samples: steadyRows };
}

function buildLongSessionStats(
    events,
    memory,
    runs,
    expectedHistoryLevels = [],
    enabled = true,
    plannedItems = []
) {
    if (!enabled) {
        return { status: 'NOT_RUN', levels: [] };
    }
    const runById = new Map(runs.map((run) => [run.runId, run]));
    const memoryByRun = groupMemoryByRun(memory);
    const observedLevels = [
        ...new Set(
            runs
                .filter((run) => run.flow === 'long-session' && run.exitCode === 0)
                .map((run) => run.historyLevel)
                .filter(Boolean)
        ),
    ];
    const levels = [...new Set([...expectedHistoryLevels, ...observedLevels])].sort(
        (left, right) => left - right
    );
    const levelResults = [];
    for (const level of levels) {
        const levelRows = [];
        for (const run of runs.filter(
            (candidate) =>
                candidate.flow === 'long-session' &&
                candidate.historyLevel === level &&
                candidate.exitCode === 0
        )) {
            const baselineEvent = eventForRun(events, run.runId, 'long-phase', 'baseline');
            const openStart = eventForRun(events, run.runId, 'long-phase', 'open-start');
            const retained = eventForRun(events, run.runId, 'long-phase', 'retained');
            const streamStart = eventForRun(events, run.runId, 'long-phase', 'stream-start');
            const terminal = eventForRun(events, run.runId, 'long-phase', 'terminal');
            const settled = eventForRun(events, run.runId, 'long-phase', 'settled');
            const samples = memoryByRun.get(run.runId) ?? [];
            if (!baselineEvent || !retained || !streamStart || !terminal || !settled) continue;
            const baselineMemory = nearestMemory(samples, baselineEvent.at);
            const retainedMemory = nearestMemory(samples, retained.at);
            const settledMemory = nearestMemory(samples, settled.at);
            if (!baselineMemory || !retainedMemory || !settledMemory) continue;
            const openSamples = samples.filter(
                (sample) => openStart && sample.at >= openStart.at && sample.at <= retained.at
            );
            const streamSamples = samples.filter(
                (sample) => sample.at >= streamStart.at && sample.at <= terminal.at
            );
            levelRows.push({
                runId: run.runId,
                arm: run.arm,
                retainedTotalPssKb: retainedMemory.totalPssKb,
                historyGrowthPssKb: retainedMemory.totalPssKb - baselineMemory.totalPssKb,
                retainedDomNodes: retained.domNodes,
                temporaryOpenPeakPssKb: openSamples.length
                    ? Math.max(
                          0,
                          Math.max(...openSamples.map((sample) => sample.totalPssKb)) -
                              baselineMemory.totalPssKb
                      )
                    : null,
                temporaryStreamPeakPssKb: streamSamples.length
                    ? Math.max(
                          0,
                          Math.max(...streamSamples.map((sample) => sample.totalPssKb)) -
                              baselineMemory.totalPssKb
                      )
                    : null,
                settledTotalPssKb: settledMemory.totalPssKb,
            });
        }

        const makeGrouped = (field) =>
            Object.fromEntries(
                arms.map((arm) => [
                    arm,
                    groupRunValues(
                        levelRows.filter((row) => row.arm === arm),
                        (row) => row[field]
                    ),
                ])
            );
        const metrics = [
            summarizeMetric({
                id: `long-${level}.retained.pss`,
                label: `Long-session ${level} post-open retained total PSS`,
                unit: 'KiB',
                groupedByArm: makeGrouped('retainedTotalPssKb'),
                runById,
                metric: 'median',
                gate: true,
                seed: `long-${level}-retained-pss`,
                notes: 'Steady-state post-open plateau PSS, app + WebKit. Compared directly across arms; history-only growth is reported separately.',
                plannedItems,
            }),
            summarizeMetric({
                id: `long-${level}.retained.dom`,
                label: `Long-session ${level} retained DOM nodes`,
                unit: 'nodes',
                groupedByArm: makeGrouped('retainedDomNodes'),
                runById,
                metric: 'median',
                gate: true,
                seed: `long-${level}-retained-dom`,
                notes: 'Rendered message-container DOM after opening the seeded history.',
                plannedItems,
            }),
            summarizeMetric({
                id: `long-${level}.history-growth.pss`,
                label: `Long-session ${level} history-only PSS growth`,
                unit: 'KiB',
                groupedByArm: makeGrouped('historyGrowthPssKb'),
                runById,
                metric: 'median',
                gate: false,
                seed: `long-${level}-history-growth`,
                notes: 'Post-open plateau minus idle baseline. Auxiliary because small histories can cancel into zero or negative deltas.',
                plannedItems,
            }),
            summarizeMetric({
                id: `long-${level}.open-peak.pss`,
                label: `Long-session ${level} temporary open peak PSS`,
                unit: 'KiB',
                groupedByArm: makeGrouped('temporaryOpenPeakPssKb'),
                runById,
                metric: 'median',
                gate: false,
                seed: `long-${level}-open-peak`,
                notes: 'Auxiliary temporary clone/queue signal.',
                plannedItems,
            }),
            summarizeMetric({
                id: `long-${level}.stream-peak.pss`,
                label: `Long-session ${level} temporary stream peak PSS`,
                unit: 'KiB',
                groupedByArm: makeGrouped('temporaryStreamPeakPssKb'),
                runById,
                metric: 'median',
                gate: false,
                seed: `long-${level}-stream-peak`,
                notes: 'Auxiliary temporary work signal.',
                plannedItems,
            }),
            summarizeMetric({
                id: `long-${level}.settled.pss`,
                label: `Long-session ${level} settled PSS`,
                unit: 'KiB',
                groupedByArm: makeGrouped('settledTotalPssKb'),
                runById,
                metric: 'median',
                gate: false,
                seed: `long-${level}-settled`,
                notes: 'Auxiliary post-stream settled total memory, app + WebKit.',
                plannedItems,
            }),
        ];
        const gates = metrics.filter((metric) => metric.gate);
        const status = gates.some((metric) => metric.status === 'FAIL')
            ? 'FAIL'
            : gates.some((metric) => metric.status === 'BLOCKED')
              ? 'BLOCKED'
              : 'PASS';
        levelResults.push({ level, status, metrics, samples: levelRows });
    }
    const status = levelResults.some((level) => level.status === 'FAIL')
        ? 'FAIL'
        : levelResults.length === 0 || levelResults.some((level) => level.status === 'BLOCKED')
          ? 'BLOCKED'
          : 'PASS';
    return { status, levels: levelResults };
}

function formatNumber(value, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toLocaleString('en-US', {
              maximumFractionDigits: digits,
              minimumFractionDigits: 0,
          })
        : '—';
}

function formatRatio(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(4)}x` : '—';
}

function formatCi(bootstrap) {
    return bootstrap ? `[${bootstrap.lower95.toFixed(4)}, ${bootstrap.upper95.toFixed(4)}]` : '—';
}

function metricMarkdownRows(metrics) {
    return metrics.map((metric) => {
        const baseline = metric.armStats.baseline;
        const current = metric.armStats.current;
        const baselineCluster = baseline.blockCount ?? '—';
        const currentCluster = current.blockCount ?? '—';
        return `| ${metric.label} | ${baseline.runCount}/${baselineCluster}/${baseline.sampleCount} | ${current.runCount}/${currentCluster}/${current.sampleCount} | ${formatNumber(baseline[metric.metric])} | ${formatNumber(current[metric.metric])} | ${formatRatio(metric.observedRatio)} | ${formatCi(metric.bootstrap)} | ${metric.status} |`;
    });
}

function writeSummaryMarkdown(stats) {
    const lines = [
        '# RFC #710 performance bootstrap report',
        '',
        `Generated: ${stats.generatedAt}`,
        '',
        'A ratio is `current / baseline`; the 95% interval is a paired A/B/B/A block-cluster percentile bootstrap with 10,000 iterations. Runs without block metadata fall back to an independent run-cluster bootstrap. A gated row is PASS only when the interval upper bound is at most 1.05 and each arm has at least three clusters.',
    ];
    if (stats.latency.status !== 'NOT_RUN') {
        lines.push(
            '',
            '## Streamed task loop',
            '',
            '| Metric | Baseline runs/blocks/samples | Current runs/blocks/samples | Baseline | Current | Ratio | 95% CI | Status |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            ...metricMarkdownRows(stats.latency.metrics)
        );
    }
    if (stats.progress.status !== 'NOT_RUN') {
        lines.push(
            '',
            '## Progress-write steady-state memory',
            '',
            '| Metric | Baseline runs/blocks/samples | Current runs/blocks/samples | Baseline | Current | Ratio | 95% CI | Status |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            ...metricMarkdownRows(stats.progress.metrics)
        );
    }
    if (stats.longSession.status !== 'NOT_RUN') {
        lines.push('', '## Long-session retention');
    }
    for (const level of stats.longSession.levels) {
        lines.push(
            '',
            `### ${level.level} messages (${level.status})`,
            '',
            '| Metric | Baseline runs/blocks/samples | Current runs/blocks/samples | Baseline | Current | Ratio | 95% CI | Status |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            ...metricMarkdownRows(level.metrics)
        );
    }
    lines.push(
        '',
        '## Interpretation',
        '',
        '- Only rows marked PASS support the RFC 5% regression budget.',
        '- AUX rows describe first-text latency and transient/quantized memory; they do not replace the gated rows.',
        '- A BLOCKED row means the run set or PSS body was insufficient, not that the regression is acceptable.',
        '- The run count is independent app processes per arm; the block count is the number of paired A/B/B/A clusters. Repeated prompts inside one process are clustered under that run.'
    );
    const file = path.join(evidenceRoot, 'summary.md');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
}

function writeSamplesCsv(stats) {
    const rows = [['family', 'level', 'metric', 'arm', 'run_id', 'value', 'unit']];
    for (const metric of [...stats.latency.metrics, ...stats.progress.metrics]) {
        for (const arm of arms) {
            for (const [runId, values] of metric.armStats[arm].runs ?? []) {
                for (const value of values) {
                    rows.push([
                        metric.id.split('.')[0],
                        '',
                        metric.id,
                        arm,
                        runId,
                        value,
                        metric.unit,
                    ]);
                }
            }
        }
    }
    for (const level of stats.longSession.levels) {
        for (const metric of level.metrics) {
            for (const arm of arms) {
                for (const [runId, values] of metric.armStats[arm].runs ?? []) {
                    for (const value of values) {
                        rows.push([
                            'long-session',
                            level.level,
                            metric.id,
                            arm,
                            runId,
                            value,
                            metric.unit,
                        ]);
                    }
                }
            }
        }
    }
    const csv = rows
        .map((row) =>
            row
                .map((value) => {
                    const text = String(value ?? '');
                    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
                })
                .join(',')
        )
        .join('\n');
    const file = path.join(evidenceRoot, 'samples.csv');
    fs.writeFileSync(file, `${csv}\n`);
    return file;
}

export async function generateStats() {
    const runPlanFile = path.join(evidenceRoot, 'run-plan.json');
    const runPlan = fs.existsSync(runPlanFile)
        ? JSON.parse(fs.readFileSync(runPlanFile, 'utf8'))
        : {};
    const protocol = runPlan.protocol ?? runPlan.options ?? {};
    const configuredFlows = Array.isArray(protocol.flows)
        ? protocol.flows
        : typeof protocol.flows === 'string'
          ? protocol.flows.split(',')
          : ['latency', 'progress', 'long-session'];
    const enabledFlows = ['latency', 'progress', 'long-session'].filter((flow) =>
        configuredFlows.includes(flow)
    );
    const expectedHistoryLevels = Array.isArray(protocol.historyLevels)
        ? protocol.historyLevels.filter((level) => Number.isFinite(Number(level)))
        : [];
    const warmSamples = Number(protocol.warmSamples ?? 8);
    const latencyModes = enabledFlows.includes('latency')
        ? ['cold', ...(Number.isFinite(warmSamples) && warmSamples > 0 ? ['warm'] : [])]
        : [];
    const events = readJsonLines(path.join(rawRoot, 'events.jsonl'));
    const memory = readJsonLines(path.join(rawRoot, 'pss.jsonl'));
    const fixtureManifest = readJsonFile(path.join(evidenceRoot, 'fixture-manifest.json'));
    const recordedRuns = readJsonLines(path.join(rawRoot, 'runs.jsonl')).filter(
        (record) => record.type === 'run'
    );
    const runs = applyFixtureValidation(recordedRuns, fixtureManifest);
    const validRuns = runs.filter(isValidRun);
    const invalidRuns = runs.filter((run) => !isValidRun(run));
    const plannedRuns = Array.isArray(runPlan.plan) ? runPlan.plan : [];
    const validRunKeys = new Set(validRuns.map(measurementKey));
    const missingPlannedRuns = plannedRuns.filter(
        (item) => !validRunKeys.has(measurementKey(item))
    );
    const latency = buildLatencyStats(events, validRuns, latencyModes, plannedRuns);
    const progress = buildProgressStats(
        events,
        memory,
        validRuns,
        enabledFlows.includes('progress'),
        plannedRuns
    );
    const longSession = buildLongSessionStats(
        events,
        memory,
        validRuns,
        expectedHistoryLevels,
        enabledFlows.includes('long-session'),
        plannedRuns
    );
    const statuses = [
        enabledFlows.includes('latency') ? latency.status : null,
        enabledFlows.includes('progress') ? progress.status : null,
        enabledFlows.includes('long-session') ? longSession.status : null,
    ].filter(Boolean);
    const overallStatus =
        statuses.length === 0
            ? 'BLOCKED'
            : statuses.includes('FAIL')
              ? 'FAIL'
              : statuses.includes('BLOCKED') || missingPlannedRuns.length > 0
                ? 'BLOCKED'
                : 'PASS';
    const stats = {
        generatedAt: new Date().toISOString(),
        baselineCommit: '21e261a1343087d7dc75414dbb46a12a98630da6',
        enabledFlows,
        method: {
            bootstrapIterations,
            confidence: 0.95,
            regressionUpperBound,
            minimumRunsPerArm,
            minimumBlocksPerArm,
            clusterUnit:
                'paired A/B/B/A block when every contributing run has block metadata; independent run otherwise',
        },
        rawCounts: {
            events: events.length,
            memorySamples: memory.filter((record) => record.type === 'memory').length,
            runs: runs.length,
            plannedRuns: plannedRuns.length,
            validRuns: validRuns.length,
            invalidRuns: invalidRuns.length,
            successfulRuns: validRuns.length,
            failedRuns: invalidRuns.length,
            missingPlannedRuns: missingPlannedRuns.length,
        },
        planCompleteness: {
            expectedRuns: plannedRuns.length,
            missingRuns: missingPlannedRuns.map(measurementKey),
        },
        fixtureManifest: {
            present: fixtureManifest !== null,
            version: fixtureManifest?.version ?? null,
            arms: fixtureManifest
                ? Object.fromEntries(
                      Object.entries(fixtureManifest.arms ?? {}).map(([arm, value]) => [
                          arm,
                          {
                              sourceBinarySha256: value.sourceBinarySha256 ?? null,
                              migrationTags: value.migrationTags ?? [],
                          },
                      ])
                  )
                : null,
        },
        invalidRuns: invalidRuns.map((run) => ({
            runId: run.runId,
            flow: run.flow,
            arm: run.arm,
            block: run.block,
            sequenceIndex: run.sequenceIndex,
            historyLevel: run.historyLevel,
            exitCode: run.exitCode,
            signal: run.signal,
            notificationFailures: run.notificationFailures ?? 0,
            invalidReasons: run.invalidReasons ?? [],
            log: run.log,
        })),
        overallStatus,
        latency,
        progress,
        longSession,
    };
    const statsPath = path.join(evidenceRoot, 'stats.json');
    fs.writeFileSync(statsPath, `${JSON.stringify(stats, null, 2)}\n`);
    const markdownPath = writeSummaryMarkdown(stats);
    const csvPath = writeSamplesCsv(stats);
    console.log(
        JSON.stringify(
            {
                statsPath,
                markdownPath,
                csvPath,
                overallStatus,
                rawCounts: stats.rawCounts,
            },
            null,
            2
        )
    );
    return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    generateStats().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}
