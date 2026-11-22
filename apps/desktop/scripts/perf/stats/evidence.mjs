import { MANIFEST_VERSION, MAX_RAIL_TICKS, modelEndpoint } from '../lib/config.mjs';
import {
    isUsableMemory,
    nearestMemory,
    nearestMemoryBefore,
    nearestMemoryWithin,
} from './statistics.mjs';

function fixtureValidationError(run, fixtureManifest) {
    if (!fixtureManifest) return 'fixture manifest is missing';
    if (fixtureManifest.version !== MANIFEST_VERSION) {
        return `fixture manifest version mismatch: expected ${MANIFEST_VERSION}, got ${fixtureManifest.version ?? 'missing'}`;
    }
    if (fixtureManifest.modelEndpoint !== modelEndpoint) {
        return `fixture manifest endpoint mismatch: expected ${modelEndpoint}, got ${fixtureManifest.modelEndpoint ?? 'missing'}`;
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

function nativeUiError(run, observed) {
    const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
    const nonNegative = (value) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const railEvents = observed.filter((event) => event.type === 'long-rail');
    if (railEvents.length !== 1) {
        return 'long-session rail evidence is missing or duplicated';
    }
    const rail = railEvents[0];
    const expectedTurns = Math.ceil(Number(run.historyLevel) / 2);
    const expectedTicks = Math.min(expectedTurns, MAX_RAIL_TICKS);
    const expectedSampled = expectedTurns > MAX_RAIL_TICKS;
    if (
        rail.historyLevel !== run.historyLevel ||
        rail.turnCount !== expectedTurns ||
        !Number.isInteger(rail.tickCount) ||
        rail.tickCount !== expectedTicks ||
        rail.sampled !== expectedSampled ||
        typeof rail.screenshot !== 'string' ||
        rail.screenshot.length === 0
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
        stream.screenshot.length === 0 ||
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
        settled.railTicks !== Math.min(expectedTurns + 1, MAX_RAIL_TICKS) ||
        !Number.isFinite(settled.scrollTop) ||
        !Number.isFinite(settled.scrollHeight) ||
        !Number.isFinite(settled.clientHeight)
    ) {
        return 'long-session streaming final-state evidence is invalid';
    }
    return null;
}

function sampleValidationError(run, events, memory, protocol) {
    const observed = events.filter((event) => event.runId === run.runId);
    if (observed.some((event) => event.arm !== run.arm)) return 'event arm identity mismatch';
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
        samples.some((sample) => !positive(sample.at) || sample.arm !== run.arm) ||
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
        const uiError = nativeUiError(run, observed);
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
    protocol
) {
    return runs.map((run) => {
        const reason =
            evidenceError ??
            fixtureValidationError(run, fixtureManifest) ??
            sampleValidationError(run, events, memory, protocol);
        if (!reason) return run;
        return {
            ...run,
            valid: false,
            invalidReasons: [...(run.invalidReasons ?? []), reason],
        };
    });
}
