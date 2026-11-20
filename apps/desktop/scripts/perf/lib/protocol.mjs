import path from 'node:path';

import { nonNegativeNumberArg, numberArg } from './cli.mjs';
import { armOrder, DEFAULT_PORT, evidenceRoot } from './config.mjs';
import { readJsonFile } from './io.mjs';

export function buildRunPlan(options) {
    const plan = [];
    if (options.flows.includes('latency')) {
        for (let block = 1; block <= options.latencyBlocks; block += 1) {
            armOrder.forEach((arm, index) => {
                plan.push({
                    arm,
                    flow: 'latency',
                    block,
                    sequenceIndex: index + 1,
                    fixture: 'base',
                    historyLevel: 0,
                });
            });
        }
    }
    if (options.flows.includes('progress')) {
        for (let block = 1; block <= options.progressBlocks; block += 1) {
            armOrder.forEach((arm, index) => {
                plan.push({
                    arm,
                    flow: 'progress',
                    block,
                    sequenceIndex: index + 1,
                    fixture: 'base',
                    historyLevel: 0,
                });
            });
        }
    }
    if (options.flows.includes('long-session')) {
        for (const historyLevel of options.historyLevels) {
            for (let block = 1; block <= options.longBlocks; block += 1) {
                armOrder.forEach((arm, index) => {
                    plan.push({
                        arm,
                        flow: 'long-session',
                        block,
                        sequenceIndex: index + 1,
                        fixture: `long-${historyLevel}`,
                        historyLevel,
                    });
                });
            }
        }
    }
    return plan;
}

export function protocolForOptions(options) {
    return {
        comparison:
            readJsonFile(path.join(evidenceRoot, 'source-manifest.json'))?.comparison ?? null,
        flows: options.flows,
        latencyBlocks: options.latencyBlocks,
        progressBlocks: options.progressBlocks,
        longBlocks: options.longBlocks,
        historyLevels: options.historyLevels,
        warmSamples: options.warmSamples,
        progressWarmups: options.progressWarmups,
        progressTasks: options.progressTasks,
        memoryIntervalMs: options.memoryIntervalMs,
        startupSettleMs: Number(process.env.TOUCHAI_PERF_STARTUP_SETTLE_MS ?? 8000),
        armOrder,
        display: 'xvfb-openbox-dunst-dbus',
        windowManager: 'openbox',
        notificationDaemon: 'dunst',
    };
}

export function protocolMismatches(previous, requested) {
    return Object.entries(requested)
        .filter(([key, value]) => JSON.stringify(previous?.[key]) !== JSON.stringify(value))
        .map(([key]) => key);
}

export function readOptions(args) {
    return {
        flows: (args.flows ?? 'latency,progress,long-session').split(',').filter(Boolean),
        latencyBlocks: numberArg(args, 'latency-blocks', 60),
        progressBlocks: numberArg(args, 'progress-blocks', 3),
        longBlocks: numberArg(args, 'long-blocks', 6),
        // Keep the default formal levels reproducible; 1500 remains available
        // as an explicit diagnostic because it is not stable on the 3.6 GiB VM.
        historyLevels: (args['history-levels'] ?? '100,500,1000')
            .split(',')
            .map(Number)
            .filter((value) => Number.isFinite(value) && value > 0),
        warmSamples: nonNegativeNumberArg(args, 'warm-samples', 8),
        progressWarmups: numberArg(args, 'progress-warmups', 4),
        // Two 16-task pilot attempts hit the same JSC crash at the 16th task.
        progressTasks: numberArg(args, 'progress-tasks', 8),
        memoryIntervalMs: numberArg(args, 'memory-interval-ms', 250),
        modelPort: DEFAULT_PORT,
        dryRun: args['dry-run'] === 'true',
        resume: args.resume === 'true',
    };
}
