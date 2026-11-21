import fs from 'node:fs';
import path from 'node:path';

import { startPerfModelServer } from '../local-model-server.mjs';
import { verifyBuiltArms } from './build.mjs';
import { readComparison } from './comparison.mjs';
import {
    artifactsRoot,
    binariesRoot,
    DEFAULT_PORT,
    evidenceRoot,
    fixturesRoot,
    logsRoot,
    manifestsRoot,
    MAX_DISPLAY_STARTUP_ATTEMPTS,
    rawRoot,
    runtimeRoot,
    snapshotsRoot,
} from './config.mjs';
import { ensureDirectory, nowIso, readJsonFile, readJsonLines, writeJson } from './io.mjs';
import { runOneMeasurement } from './measurement.mjs';
import { buildRunPlan, protocolForOptions, protocolMismatches } from './protocol.mjs';
import { isValidRun, measurementKey } from './records.mjs';

function ensureEvidenceLayout(resume = false) {
    for (const directory of [
        artifactsRoot,
        snapshotsRoot,
        runtimeRoot,
        logsRoot,
        rawRoot,
        fixturesRoot,
        manifestsRoot,
        binariesRoot,
    ]) {
        ensureDirectory(directory);
    }
    for (const file of [
        path.join(rawRoot, 'events.jsonl'),
        path.join(rawRoot, 'pss.jsonl'),
        path.join(rawRoot, 'runs.jsonl'),
        path.join(rawRoot, 'model-server.jsonl'),
    ]) {
        if (resume) {
            fs.closeSync(fs.openSync(file, 'a'));
        } else {
            fs.writeFileSync(file, '');
        }
    }
}

export async function runMeasurements(options) {
    const plan = buildRunPlan(options);
    const protocol = protocolForOptions(options);
    const previousPlan = options.resume
        ? readJsonFile(path.join(evidenceRoot, 'run-plan.json'))
        : null;
    if (options.resume) {
        if (!previousPlan?.protocol) {
            throw new Error('Cannot resume without a persisted performance run protocol.');
        }
        const mismatches = protocolMismatches(previousPlan.protocol, protocol);
        if (mismatches.length > 0) {
            throw new Error(
                `Cannot resume with a different performance protocol: ${mismatches.join(', ')}.`
            );
        }
    }
    const runsPath = path.join(rawRoot, 'runs.jsonl');
    const existingRuns = options.resume ? readJsonLines(runsPath) : [];
    const failedRun = existingRuns.find((record) => {
        if (record.type === 'run') return !isValidRun(record);
        if (record.type === 'run-attempt') {
            return isValidRun(record) || record.retryReason !== 'display-startup-failure';
        }
        return record.type !== 'run-launch';
    });
    if (failedRun)
        throw new Error(
            `Cannot resume after a failed measurement: ${failedRun.runId}. Preserve its evidence.`
        );
    const terminalRunIds = new Set(
        existingRuns
            .filter((record) => record.type === 'run' || record.type === 'run-attempt')
            .map((record) => record.runId)
    );
    const interruptedLaunch = existingRuns.find(
        (record) => record.type === 'run-launch' && !terminalRunIds.has(record.runId)
    );
    if (interruptedLaunch)
        throw new Error(
            `Cannot resume an interrupted measurement: ${interruptedLaunch.runId}. Preserve its evidence.`
        );
    const existingSuccessfulRuns = existingRuns.filter((record) => record.type === 'run');
    const completedIds = new Set(existingSuccessfulRuns.map((record) => record.runId));
    const interruptedRun = (
        options.resume ? readJsonLines(path.join(rawRoot, 'events.jsonl')) : []
    ).find((record) => record.type === 'run-start' && !completedIds.has(record.runId));
    if (interruptedRun)
        throw new Error(
            `Cannot resume an interrupted measurement: ${interruptedRun.runId}. Preserve its evidence.`
        );
    const completedKeys = new Set(existingSuccessfulRuns.map(measurementKey));
    const remainingPlan = options.resume
        ? plan.filter((item) => !completedKeys.has(measurementKey(item)))
        : plan;
    if (options.dryRun) {
        console.log(JSON.stringify(remainingPlan, null, 2));
        return;
    }
    const comparison = readComparison();
    verifyBuiltArms();
    const fixtures = readJsonFile(path.join(evidenceRoot, 'fixture-manifest.json'));
    if (JSON.stringify(fixtures?.comparison) !== JSON.stringify(comparison)) {
        throw new Error('Fixtures belong to a different baseline/candidate comparison.');
    }
    ensureEvidenceLayout(options.resume);
    writeJson(path.join(evidenceRoot, 'run-plan.json'), {
        generatedAt: nowIso(),
        protocol,
        plan,
    });
    const server = await startPerfModelServer({
        port: DEFAULT_PORT,
        logFile: path.join(rawRoot, 'model-server.jsonl'),
    });
    try {
        for (const [index, item] of remainingPlan.entries()) {
            console.log(
                `[${index + 1}/${remainingPlan.length}] ${item.flow} ${
                    item.historyLevel || ''
                } block ${item.block} ${item.arm}`
            );
            const startupAttempts = existingRuns.filter(
                (record) =>
                    record.type === 'run-attempt' && measurementKey(record) === measurementKey(item)
            ).length;
            if (startupAttempts >= MAX_DISPLAY_STARTUP_ATTEMPTS) {
                throw new Error(
                    `Display startup attempt limit reached for ${measurementKey(item)}.`
                );
            }
            await runOneMeasurement({ ...item, options, attempt: startupAttempts + 1 });
        }
    } finally {
        await server.close();
    }
}
