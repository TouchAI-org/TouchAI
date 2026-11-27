import fs from 'node:fs';
import path from 'node:path';

import { evidenceRoot, MANIFEST_VERSION } from '../lib/config.mjs';
import { readJsonFile, sha256File } from '../lib/io.mjs';
import { railTickCount, workloadFor } from '../lib/workload.mjs';
import {
    isUsableMemory,
    nearestMemory,
    nearestMemoryBefore,
    nearestMemoryWithin,
} from './statistics.mjs';

function evidenceFile(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) return null;
    const root = fs.realpathSync(evidenceRoot);
    try {
        const file = fs.realpathSync(path.resolve(root, relative));
        const stat = fs.statSync(file);
        return file.startsWith(`${root}${path.sep}`) && stat.isFile() && stat.size > 0
            ? file
            : null;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

export function provenanceError(source, builds, fixtureManifest) {
    if (source?.version !== MANIFEST_VERSION)
        return 'source manifest version is missing or invalid';
    if (!Array.isArray(builds?.builds) || builds.builds.length !== 2)
        return 'build evidence is missing or duplicated';
    for (const arm of ['baseline', 'current']) {
        const reference = source[arm];
        const file = evidenceFile(reference?.path);
        if (!file || sha256File(file) !== reference.sha256)
            return `${arm} source manifest is missing or changed`;
        const manifest = readJsonFile(file);
        if (
            manifest.version !== MANIFEST_VERSION ||
            manifest.arm !== arm ||
            JSON.stringify(manifest.comparison) !== JSON.stringify(source.comparison)
        ) {
            return `${arm} source manifest comparison is inconsistent`;
        }
        const matches = builds.builds.filter((build) => build.arm === arm);
        const build = matches[0];
        const binary = evidenceFile(build?.binary);
        if (
            matches.length !== 1 ||
            build.exitCode !== 0 ||
            build.signal ||
            !binary ||
            build.sourceManifestSha256 !== reference.sha256 ||
            JSON.stringify(build.comparison) !== JSON.stringify(source.comparison) ||
            sha256File(binary) !== build.binarySha256 ||
            build.binarySha256 !== fixtureManifest?.arms?.[arm]?.sourceBinarySha256
        ) {
            return `${arm} build provenance is missing or inconsistent`;
        }
        for (const [name, fixture] of Object.entries(fixtureManifest.arms[arm].fixtures ?? {})) {
            const database = evidenceFile(fixture.path);
            if (!database || sha256File(database) !== fixture.sha256)
                return `${arm}/${name} fixture evidence is missing or changed`;
        }
    }
    return null;
}

export function modelEvidenceError(records, events) {
    const samples = events.filter((event) =>
        ['latency', 'latency-warmup', 'progress-task', 'progress-warmup', 'long-stream'].includes(
            event.type
        )
    );
    const byPrompt = new Map();
    for (const sample of samples) {
        if (!sample.promptId || byPrompt.has(sample.promptId))
            return 'model sample prompt identity is missing or duplicated';
        byPrompt.set(sample.promptId, sample);
    }
    if (!records.length) return 'model server evidence is missing';
    for (const record of records) {
        const sample = byPrompt.get(record.promptId);
        if (
            !sample ||
            !['request', 'complete'].includes(record.type) ||
            record.runId !== sample.runId ||
            record.arm !== sample.arm ||
            record.flow !== sample.flow ||
            Number(record.block) !== Number(sample.block)
        )
            return 'model request identity is missing or inconsistent';
    }
    return null;
}

function workloadEvidenceError(run, observed, protocol, modelRecords) {
    const expected = workloadFor(run.flow);
    const samples = observed.filter((event) =>
        ['latency', 'latency-warmup', 'progress-task', 'progress-warmup', 'long-stream'].includes(
            event.type
        )
    );
    const slots =
        run.flow === 'latency'
            ? [
                  ['latency', 'cold', 'cold'],
                  ...(protocol.warmSamples > 0
                      ? [
                            ['latency-warmup', 'warmup', 'warmup'],
                            ...Array.from({ length: protocol.warmSamples }, (_, index) => [
                                'latency',
                                index,
                                'warm',
                            ]),
                        ]
                      : []),
              ]
            : run.flow === 'progress'
              ? [
                    ...Array.from({ length: protocol.progressWarmups }, (_, index) => [
                        'progress-warmup',
                        `warmup-${index}`,
                        null,
                    ]),
                    ...Array.from({ length: protocol.progressTasks }, (_, index) => [
                        'progress-task',
                        index,
                        null,
                    ]),
                ]
              : [['long-stream', 0, 'long-stream']];
    if (samples.length !== slots.length) return 'workload sample count does not match the protocol';
    for (const [index, sample] of samples.entries()) {
        const [type, id, mode] = slots[index];
        if (
            sample.type !== type ||
            sample.sample !== id ||
            sample.mode !== mode ||
            Object.entries(expected).some(([key, value]) => sample[key] !== value)
        ) {
            return 'sample workload does not match the protocol';
        }
        const history = modelRecords.filter((record) => record.promptId === sample.promptId);
        const requests = history.filter((record) => record.type === 'request');
        if (
            history.length !== expected.rounds + 2 ||
            requests.length !== expected.rounds + 1 ||
            history.at(-1)?.type !== 'complete' ||
            history.at(-1)?.toolCount !== expected.rounds ||
            requests.some((record, index) => record.toolCount !== index) ||
            history.some(
                (record, index) =>
                    !Number.isFinite(record.at) ||
                    record.at <= 0 ||
                    (index > 0 && record.at < history[index - 1].at) ||
                    Object.entries(expected).some(([key, value]) => record[key] !== value)
            )
        ) {
            return 'model tool execution chain is incomplete or inconsistent';
        }
    }
    return null;
}

function fixtureValidationError(run, fixtureManifest, protocol) {
    if (!fixtureManifest) return 'fixture manifest is missing';
    if (fixtureManifest.version !== MANIFEST_VERSION) {
        return `fixture manifest version mismatch: expected ${MANIFEST_VERSION}, got ${fixtureManifest.version ?? 'missing'}`;
    }
    if (!protocol.modelEndpoint || fixtureManifest.modelEndpoint !== protocol.modelEndpoint) {
        return `fixture manifest endpoint mismatch: expected ${protocol.modelEndpoint}, got ${fixtureManifest.modelEndpoint ?? 'missing'}`;
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
    if (
        typeof run.fixtureSha256 !== 'string' ||
        run.fixtureSha256.length === 0 ||
        typeof fixture.sha256 !== 'string' ||
        fixture.sha256.length === 0
    ) {
        return `fixture hash is missing for ${run.arm}/${run.fixture}`;
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

function memoryCoverageError({ run, label, samples, startAt, endAt, intervalMs }) {
    const duration = endAt - startAt;
    if (!Number.isFinite(duration) || duration <= 0) {
        return `${run.flow} ${label} window is invalid`;
    }
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
        return `${run.flow} memory sampling interval is invalid`;
    }
    const observed = samples
        .filter((sample) => sample.at >= startAt && sample.at <= endAt)
        .sort((left, right) => left.at - right.at);
    const nominalSampleCount = Math.floor(duration / intervalMs) + 1;
    const minimumSampleCount = Math.max(1, Math.ceil(nominalSampleCount * 0.75));
    if (observed.length < minimumSampleCount) {
        return `${run.flow} memory coverage for ${label} is too sparse: ${observed.length}/${minimumSampleCount} samples`;
    }
    const maximumGapMs = Math.max(intervalMs * 5, 2000);
    const timestamps = [startAt, ...observed.map((sample) => sample.at), endAt];
    for (let index = 1; index < timestamps.length; index += 1) {
        const gap = timestamps[index] - timestamps[index - 1];
        if (gap > maximumGapMs) {
            return `${run.flow} memory coverage for ${label} has a ${gap}ms gap`;
        }
    }
    return null;
}

function nativeUiError(run, observed, protocol) {
    const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const nonNegative = (value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const railEvents = observed.filter((event) => event.type === 'long-rail');
    if (railEvents.length !== 1) {
        return 'long-session rail evidence is missing or duplicated';
    }
    const rail = railEvents[0];
    const expectedTurns = Math.ceil(Number(run.historyLevel) / 2);
    const policy = protocol.railPolicies?.[run.arm];
    if (!['all', 'sampled'].includes(policy))
        return 'long-session rail policy is missing or invalid';
    const expectedTicks = railTickCount(expectedTurns, policy);
    const expectedSampled = expectedTicks < expectedTurns;
    if (
        rail.historyLevel !== run.historyLevel ||
        rail.turnCount !== expectedTurns ||
        !Number.isInteger(rail.tickCount) ||
        rail.tickCount !== expectedTicks ||
        rail.sampled !== expectedSampled ||
        typeof rail.screenshot !== 'string' ||
        !evidenceFile(rail.screenshot)
    ) {
        return 'long-session rail evidence is invalid';
    }
    if (!Array.isArray(rail.steps) || rail.steps.length !== 2) {
        return 'long-session rail navigation steps are missing';
    }
    const expectedSteps = [
        { target: 'first', index: 0 },
        { target: 'last', index: rail.tickCount - 1 },
    ];
    for (const [index, expected] of expectedSteps.entries()) {
        const step = rail.steps[index];
        if (
            !step ||
            step.target !== expected.target ||
            step.targetIndex !== expected.index ||
            !positive(step.durationMs) ||
            !Number.isFinite(step.scrollTopBefore) ||
            !Number.isFinite(step.scrollTopAfter) ||
            !nonNegative(step.endDistanceAfter) ||
            step.moved !== true ||
            step.focusedBefore !== true ||
            step.focusedAfter !== true ||
            step.activeTarget !== true
        ) {
            return `long-session ${expected.target} rail navigation is invalid`;
        }
        if (expected.target === 'first' && step.scrollTopAfter > 5) {
            return 'long-session first rail destination did not reach the top';
        }
    }

    const streamEvents = observed.filter((event) => event.type === 'long-stream');
    if (streamEvents.length !== 1) {
        return 'long-session streaming evidence is missing or duplicated';
    }
    const stream = streamEvents[0];
    const settled = stream.settled;
    if (
        stream.mode !== 'long-stream' ||
        !positive(stream.durationMs) ||
        !positive(stream.firstTextMs) ||
        stream.firstTextMs > stream.durationMs ||
        typeof stream.screenshot !== 'string' ||
        !evidenceFile(stream.screenshot) ||
        !settled ||
        settled.busy !== 'false' ||
        settled.atEnd !== true ||
        !positive(settled.durationMs) ||
        settled.durationMs < stream.durationMs ||
        !nonNegative(settled.settleMs) ||
        !positive(settled.frameCount) ||
        !positive(settled.mutationCount) ||
        !positive(settled.frameGapSamples) ||
        settled.frameGapSamples !== settled.frameCount - 1 ||
        settled.frameGapDropped !== 0 ||
        !nonNegative(settled.frameGapP95Ms) ||
        !nonNegative(settled.frameGapMaxMs) ||
        settled.frameGapMaxMs < settled.frameGapP95Ms ||
        !nonNegative(settled.frameGapOver50Ms) ||
        settled.frameGapOver50Ms > settled.frameGapSamples ||
        !positive(settled.domNodes) ||
        !positive(settled.messageCount) ||
        !positive(settled.bodyTextChars) ||
        !positive(settled.assistantTextChars) ||
        settled.railTicks !== railTickCount(expectedTurns + 1, policy) ||
        !Number.isFinite(settled.scrollTop) ||
        !Number.isFinite(settled.scrollHeight) ||
        !Number.isFinite(settled.clientHeight)
    ) {
        return 'long-session streaming final-state evidence is invalid';
    }
    return null;
}

function sampleValidationError(run, events, memory, protocol, modelRecords) {
    const observed = events.filter((event) => event.runId === run.runId);
    if (
        observed.some(
            (event) =>
                event.arm !== run.arm ||
                event.flow !== run.flow ||
                Number(event.block) !== run.block
        )
    )
        return 'event measurement identity mismatch';
    const workloadError = workloadEvidenceError(run, observed, protocol, modelRecords);
    if (workloadError) return workloadError;
    const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
    if (run.flow === 'latency') {
        const samples = observed.filter((event) => event.type === 'latency');
        const warmCount = Number(protocol.warmSamples ?? 8);
        if (
            samples.length !== 1 + warmCount ||
            samples.filter((event) => event.mode === 'cold').length !== 1 ||
            samples.filter((event) => event.mode === 'warm').length !== warmCount ||
            samples.some(
                (event) =>
                    !positive(event.durationMs) ||
                    !positive(event.firstTextMs) ||
                    event.firstTextMs > event.durationMs
            )
        ) {
            return 'latency samples are missing or invalid';
        }
        return null;
    }

    const phases =
        run.flow === 'progress'
            ? ['start', 'end']
            : ['baseline', 'open-start', 'retained', 'stream-start', 'terminal', 'settled'];
    const type = run.flow === 'progress' ? 'progress-window' : 'long-phase';
    if (!['progress', 'long-session'].includes(run.flow)) return 'unknown measurement flow';
    const markers = phases.map((phase) =>
        observed.filter((event) => event.type === type && event.phase === phase)
    );
    if (markers.some((items) => items.length !== 1 || !positive(items[0].at))) {
        return `${run.flow} phase markers are missing or invalid`;
    }
    const times = markers.map(([event]) => event.at);
    if (times.some((at, index) => index > 0 && at < times[index - 1]) || times.at(-1) <= times[0]) {
        return `${run.flow} phase markers are out of order`;
    }
    const samples = memory.filter(
        (sample) => sample.runId === run.runId && sample.type === 'memory'
    );
    const intervalMs = Number(protocol.memoryIntervalMs ?? 250);
    const interval = samples.filter((sample) => sample.at >= times[0] && sample.at <= times.at(-1));
    if (
        samples.some(
            (sample) => !positive(sample.at) || sample.arm !== run.arm || sample.flow !== run.flow
        ) ||
        interval.length === 0 ||
        interval.some((sample) => !isUsableMemory(sample))
    ) {
        return `${run.flow} memory samples are missing or invalid`;
    }
    const usable = samples.filter(isUsableMemory);
    if (run.flow === 'progress') {
        const tasks = observed.filter((event) => event.type === 'progress-task');
        if (
            tasks.length !== Number(protocol.progressTasks ?? 8) ||
            tasks.some((event) => !positive(event.durationMs)) ||
            !interval.some((sample) => sample.at >= times[0] + (times[1] - times[0]) / 2)
        ) {
            return 'progress window is incomplete';
        }
        const coverageError = memoryCoverageError({
            run,
            label: 'progress window',
            samples,
            startAt: times[0],
            endAt: times.at(-1),
            intervalMs,
        });
        if (coverageError) return coverageError;
    } else {
        if (
            !positive(markers[2][0].domNodes) ||
            !nearestMemoryBefore(usable, times[1]) ||
            !nearestMemoryWithin(usable, times[2], times[1], times[3]) ||
            !nearestMemory(usable, times[5])
        ) {
            return 'long-session retained observations are missing or invalid';
        }
        const coverageWindows = [
            ['long-session full window', times[0], times.at(-1)],
            ['open plateau', times[1], times[2]],
            ['stream', times[3], times[4]],
        ];
        for (const [label, startAt, endAt] of coverageWindows) {
            const coverageError = memoryCoverageError({
                run,
                label,
                samples,
                startAt,
                endAt,
                intervalMs,
            });
            if (coverageError) return coverageError;
        }
        const uiError = nativeUiError(run, observed, protocol);
        if (uiError) return uiError;
    }
    return null;
}

export function applyEvidenceValidation(
    runs,
    fixtureManifest,
    evidenceError,
    events,
    memory,
    protocol,
    modelRecords
) {
    return runs.map((run) => {
        const reason =
            evidenceError ??
            fixtureValidationError(run, fixtureManifest, protocol) ??
            sampleValidationError(run, events, memory, protocol, modelRecords);
        if (!reason) return run;
        return {
            ...run,
            valid: false,
            invalidReasons: [...(run.invalidReasons ?? []), reason],
        };
    });
}
