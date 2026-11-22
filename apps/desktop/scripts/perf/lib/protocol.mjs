import path from 'node:path';

import { armOrder, evidenceRoot, fixtureLevels, startupSettleMs } from './config.mjs';
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

function integerArg(args, name, fallback, minimum = 1) {
    if (args[name] === undefined) return fallback;
    const raw = String(args[name]);
    if (!/^\d+$/.test(raw)) {
        throw new Error(`--${name} must be an integer of at least ${minimum}.`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`--${name} must be an integer of at least ${minimum}.`);
    }
    return value;
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

function planIdentity(item) {
    if (
        !item ||
        typeof item.flow !== 'string' ||
        !Number.isInteger(item.block) ||
        !Number.isInteger(item.sequenceIndex) ||
        (item.arm !== 'baseline' && item.arm !== 'current') ||
        typeof item.fixture !== 'string'
    ) {
        return null;
    }
    return JSON.stringify([
        item.flow,
        item.block,
        item.sequenceIndex,
        item.arm,
        item.historyLevel || 0,
        item.fixture,
    ]);
}

export function validatePersistedPlan(protocol, plan) {
    if (!Array.isArray(protocol?.flows) || protocol.flows.length === 0) {
        return 'persisted run protocol has no flows';
    }
    const unknownFlow = protocol.flows.find(
        (flow) => !['latency', 'progress', 'long-session'].includes(flow)
    );
    if (unknownFlow) return `persisted run protocol has unknown flow ${unknownFlow}`;
    let expected;
    try {
        expected = buildRunPlan(protocol);
    } catch (error) {
        return `persisted run protocol is invalid: ${
            error instanceof Error ? error.message : String(error)
        }`;
    }
    if (!Array.isArray(plan)) return 'persisted run plan is missing';
    const savedIds = plan.map(planIdentity);
    if (savedIds.some((identity) => identity === null)) {
        return 'persisted run plan contains an invalid slot';
    }
    if (new Set(savedIds).size !== savedIds.length) {
        return 'persisted run plan contains duplicate slots';
    }
    const expectedIds = new Set(expected.map(planIdentity));
    const saved = new Set(savedIds);
    if (expectedIds.size !== saved.size) {
        return `persisted run plan has ${saved.size} slots; the declared protocol requires ${expectedIds.size}`;
    }
    for (const identity of expectedIds) {
        if (!saved.has(identity)) return 'persisted run plan does not match the declared protocol';
    }
    for (const identity of saved) {
        if (!expectedIds.has(identity))
            return 'persisted run plan does not match the declared protocol';
    }
    return null;
}

function parseFlows(value) {
    const flows = String(value)
        .split(',')
        .map((flow) => flow.trim())
        .filter(Boolean);
    if (flows.length === 0) throw new Error('--flows must not be empty.');
    const unknown = flows.find((flow) => !['latency', 'progress', 'long-session'].includes(flow));
    if (unknown) throw new Error(`Unknown performance flow: ${unknown}`);
    if (new Set(flows).size !== flows.length) {
        throw new Error('--flows must not contain duplicates.');
    }
    return flows;
}

export function readOptions(args) {
    return {
        flows: parseFlows(args.flows ?? 'latency,progress,long-session'),
        latencyBlocks: integerArg(args, 'latency-blocks', 60),
        progressBlocks: integerArg(args, 'progress-blocks', 3),
        longBlocks: integerArg(args, 'long-blocks', 6),
        // Keep the default formal levels reproducible; 1500 remains available
        // as an explicit diagnostic because it is not stable on the 3.6 GiB VM.
        historyLevels: parseHistoryLevels(args['history-levels'] ?? '100,500,1000'),
        warmSamples: integerArg(args, 'warm-samples', 8, 0),
        progressWarmups: integerArg(args, 'progress-warmups', 4),
        // Two 16-task pilot attempts hit the same JSC crash at the 16th task.
        progressTasks: integerArg(args, 'progress-tasks', 8),
        memoryIntervalMs: integerArg(args, 'memory-interval-ms', 250),
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
