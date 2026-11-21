import fs from 'node:fs';
import path from 'node:path';

import { evidenceRoot, rawRoot } from '../lib/config.mjs';
import { readJsonFile, readJsonLines } from '../lib/io.mjs';
import { isValidRun, measurementKey } from '../lib/records.mjs';
import { applyEvidenceValidation } from './evidence.mjs';
import { writeSamplesCsv, writeSummaryMarkdown } from './report.mjs';
import {
    bootstrapIterations,
    buildLatencyStats,
    buildLongSessionStats,
    buildProgressStats,
    minimumBlocksPerArm,
    minimumRunsPerArm,
    regressionUpperBound,
} from './statistics.mjs';

export async function generateStats() {
    const runPlanFile = path.join(evidenceRoot, 'run-plan.json');
    const runPlan = readJsonFile(runPlanFile) ?? {};
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
    const comparison = readJsonFile(path.join(evidenceRoot, 'source-manifest.json'))?.comparison;
    const evidenceError =
        !comparison ||
        !/^[a-f0-9]{40}$/.test(comparison.baselineCommit ?? '') ||
        !/^[a-f0-9]{40}$/.test(comparison.candidateCommit ?? '') ||
        JSON.stringify(comparison) !== JSON.stringify(protocol.comparison) ||
        JSON.stringify(comparison) !== JSON.stringify(fixtureManifest?.comparison)
            ? 'baseline/candidate comparison identity is missing or inconsistent'
            : null;
    const runs = applyEvidenceValidation(
        recordedRuns,
        fixtureManifest,
        evidenceError,
        events,
        memory,
        protocol
    );
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
              : statuses.includes('BLOCKED') ||
                  missingPlannedRuns.length > 0 ||
                  invalidRuns.length > 0 ||
                  plannedRuns.length === 0
                ? 'BLOCKED'
                : 'PASS';
    const stats = {
        generatedAt: new Date().toISOString(),
        baselineCommit: comparison?.baselineCommit ?? null,
        candidateCommit: comparison?.candidateCommit ?? null,
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
            missingPlannedRuns: missingPlannedRuns.length,
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
