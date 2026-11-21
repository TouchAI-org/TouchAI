import { MANIFEST_VERSION } from '../lib/config.mjs';
import { isUsableMemory, nearestMemory, nearestMemoryWithin } from './statistics.mjs';

export function fixtureValidationError(run, fixtureManifest) {
    if (!fixtureManifest) return 'fixture manifest is missing';
    if (fixtureManifest.version !== MANIFEST_VERSION) {
        return `fixture manifest version mismatch: expected ${MANIFEST_VERSION}, got ${fixtureManifest.version ?? 'missing'}`;
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

export function sampleValidationError(run, events, memory, protocol) {
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
    } else if (
        !positive(markers[2][0].domNodes) ||
        !nearestMemory(usable, times[0]) ||
        !nearestMemoryWithin(usable, times[2], times[1], times[3]) ||
        !nearestMemory(usable, times[5])
    ) {
        return 'long-session retained observations are missing or invalid';
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
