import { createHash } from 'node:crypto';

import { arms } from '../lib/config.mjs';
import { measurementKey } from '../lib/records.mjs';

export const bootstrapIterations = 10000;
export const minimumRunsPerArm = 3;
export const minimumBlocksPerArm = 3;
export const regressionUpperBound = 1.05;

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

function groupRunArrays(rows, valueSelector) {
    const grouped = new Map();
    for (const row of rows) {
        const values = valueSelector(row);
        if (!Array.isArray(values)) continue;
        const numeric = values.filter(
            (value) => typeof value === 'number' && Number.isFinite(value)
        );
        if (numeric.length === 0) continue;
        const groupedValues = grouped.get(row.runId) ?? [];
        groupedValues.push(...numeric);
        grouped.set(row.runId, groupedValues);
    }
    return grouped;
}

function blockKeyForRun(run) {
    const block = Number(run?.block);
    if (!Number.isInteger(block) || block <= 0) return null;
    return `${run.flow ?? 'unknown'}:h${run.historyLevel ?? 0}:b${block}`;
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

export function buildLatencyStats(events, runs, modes, plannedItems) {
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
    const scopedPlan = plannedItems.filter((item) => item.flow === 'latency');
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
                    plannedItems: scopedPlan,
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
                    plannedItems: scopedPlan,
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

export function isUsableMemory(record) {
    return (
        record.type === 'memory' &&
        Number.isFinite(record.at) &&
        typeof record.totalPssKb === 'number' &&
        Number.isFinite(record.totalPssKb) &&
        record.totalPssKb > 0 &&
        Array.isArray(record.processes) &&
        record.processes.length > 0
    );
}

function groupMemoryByRun(memory) {
    const byRun = new Map();
    for (const record of memory) {
        if (!isUsableMemory(record)) continue;
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

export function nearestMemory(samples, at, maxDistanceMs = 3000) {
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

export function nearestMemoryBefore(samples, at, maxDistanceMs = 3000) {
    return nearestMemory(
        samples.filter((sample) => sample.at <= at),
        at,
        maxDistanceMs
    );
}

export function nearestMemoryWithin(samples, at, startAt, endAt, maxDistanceMs = 3000) {
    return nearestMemory(
        samples.filter((sample) => sample.at >= startAt && sample.at <= endAt),
        at,
        maxDistanceMs
    );
}

export function buildProgressStats(events, memory, runs, enabled, plannedItems) {
    if (!enabled) {
        return { status: 'NOT_RUN', metrics: [] };
    }
    const runById = new Map(runs.map((run) => [run.runId, run]));
    const memoryByRun = groupMemoryByRun(memory);
    const scopedPlan = plannedItems.filter((item) => item.flow === 'progress');
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
        plannedItems: scopedPlan,
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
        plannedItems: scopedPlan,
    });
    const status = steady.status;
    return { status, metrics: [steady, peak] };
}

export function buildLongSessionStats(
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
            const rail = eventForRun(events, run.runId, 'long-rail', undefined);
            const stream = eventForRun(events, run.runId, 'long-stream', undefined);
            const samples = memoryByRun.get(run.runId) ?? [];
            if (!baselineEvent || !openStart || !retained || !streamStart || !terminal || !settled)
                continue;
            const baselineMemory = nearestMemoryBefore(samples, openStart.at);
            const retainedMemory = nearestMemoryWithin(
                samples,
                retained.at,
                openStart.at,
                streamStart.at
            );
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
                railTickCount: rail?.tickCount,
                railNavigationMs:
                    rail?.steps?.map((step) => step.durationMs).filter(Number.isFinite) ?? [],
                streamSettledMs: stream?.settled?.durationMs,
                streamFrameGapP95Ms: stream?.settled?.frameGapP95Ms,
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
        const scopedPlan = plannedItems.filter(
            (item) => item.flow === 'long-session' && Number(item.historyLevel) === Number(level)
        );
        const railNavigationByArm = Object.fromEntries(
            arms.map((arm) => [
                arm,
                groupRunArrays(
                    levelRows.filter((row) => row.arm === arm),
                    (row) => row.railNavigationMs
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
                plannedItems: scopedPlan,
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
                plannedItems: scopedPlan,
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
                plannedItems: scopedPlan,
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
                plannedItems: scopedPlan,
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
                plannedItems: scopedPlan,
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
                plannedItems: scopedPlan,
            }),
        ];
        const uiMetrics = [
            summarizeMetric({
                id: `long-${level}.rail.ticks`,
                label: `Long-session ${level} rendered rail ticks`,
                unit: 'ticks',
                groupedByArm: makeGrouped('railTickCount'),
                runById,
                metric: 'median',
                gate: false,
                seed: `long-${level}-rail-ticks`,
                notes: 'Auxiliary count of available rail destinations after opening the history.',
                plannedItems: scopedPlan,
            }),
            summarizeMetric({
                id: `long-${level}.rail.navigation.median`,
                label: `Long-session ${level} first/last rail navigation P50`,
                unit: 'ms',
                groupedByArm: railNavigationByArm,
                runById,
                metric: 'median',
                gate: true,
                seed: `long-${level}-rail-navigation-p50`,
                notes: 'Native click-to-settled navigation between the two rail ends.',
                plannedItems: scopedPlan,
            }),
            summarizeMetric({
                id: `long-${level}.rail.navigation.p95`,
                label: `Long-session ${level} first/last rail navigation P95`,
                unit: 'ms',
                groupedByArm: railNavigationByArm,
                runById,
                metric: 'p95',
                gate: true,
                seed: `long-${level}-rail-navigation-p95`,
                notes: 'Native click-to-settled navigation between the two rail ends.',
                plannedItems: scopedPlan,
            }),
            summarizeMetric({
                id: `long-${level}.stream.settled.median`,
                label: `Long-session ${level} Enter to final idle P50`,
                unit: 'ms',
                groupedByArm: makeGrouped('streamSettledMs'),
                runById,
                metric: 'median',
                gate: true,
                seed: `long-${level}-stream-settled-p50`,
                notes: 'Enter to two idle animation frames after the final content.',
                plannedItems: scopedPlan,
            }),
            summarizeMetric({
                id: `long-${level}.stream.settled.p95`,
                label: `Long-session ${level} Enter to final idle P95`,
                unit: 'ms',
                groupedByArm: makeGrouped('streamSettledMs'),
                runById,
                metric: 'p95',
                gate: true,
                seed: `long-${level}-stream-settled-p95`,
                notes: 'Enter to two idle animation frames after the final content.',
                plannedItems: scopedPlan,
            }),
            summarizeMetric({
                id: `long-${level}.stream.frame-gap.p95`,
                label: `Long-session ${level} streaming frame-gap P95`,
                unit: 'ms',
                groupedByArm: makeGrouped('streamFrameGapP95Ms'),
                runById,
                metric: 'median',
                gate: false,
                seed: `long-${level}-stream-frame-gap-p95`,
                notes: 'Auxiliary per-run 95th percentile of animation-frame gaps from Enter to final idle; scheduler noise makes this unsuitable as a hard gate.',
                plannedItems: scopedPlan,
            }),
        ];
        const gates = [...metrics, ...uiMetrics].filter((metric) => metric.gate);
        const status = gates.some((metric) => metric.status === 'FAIL')
            ? 'FAIL'
            : gates.some((metric) => metric.status === 'BLOCKED')
              ? 'BLOCKED'
              : 'PASS';
        levelResults.push({ level, status, metrics, uiMetrics });
    }
    const status = levelResults.some((level) => level.status === 'FAIL')
        ? 'FAIL'
        : levelResults.length === 0 || levelResults.some((level) => level.status === 'BLOCKED')
          ? 'BLOCKED'
          : 'PASS';
    return { status, levels: levelResults };
}
