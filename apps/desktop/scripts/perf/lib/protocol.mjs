import path from 'node:path';

import { armOrder, DEFAULT_PORT, evidenceRoot, fixtureLevels, startupSettleMs } from './config.mjs';
import { readJsonFile } from './io.mjs';

export function parseArgs(argv) {
    const values = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next && !next.startsWith('--')) {
            values[key] = next;
            index += 1;
        } else {
            values[key] = 'true';
        }
    }
    return values;
}

function numberArg(args, name, fallback) {
    const value = Number(args[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberArg(args, name, fallback) {
    const value = Number(args[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
}

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
        startupSettleMs,
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
        historyLevels: parseHistoryLevels(args['history-levels'] ?? '100,500,1000'),
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

function parseHistoryLevels(value) {
    const levels = String(value)
        .split(',')
        .map((part) => part.trim())
        .map((part) => {
            if (!/^\d+$/.test(part)) {
                throw new Error(`Invalid --history-levels value: ${part || '(empty)'}`);
            }
            const level = Number(part);
            if (!fixtureLevels.includes(level)) {
                throw new Error(
                    `Unsupported --history-levels value ${level}; choose from ${fixtureLevels.join(', ')}.`
                );
            }
            return level;
        });
    if (levels.length === 0) throw new Error('--history-levels must not be empty.');
    if (new Set(levels).size !== levels.length) {
        throw new Error('--history-levels must not contain duplicate values.');
    }
    return levels;
}
