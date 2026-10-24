#!/usr/bin/env node
/**
 * Ratchet the frontend coverage floor up to what the suite actually reaches.
 *
 * The floor in vitest.config.ts is a one-way ratchet: this script may only raise it.
 * Lowering it would let a change quietly trade covered behavior for uncovered code,
 * which is exactly what the floor exists to prevent. If a change legitimately removes
 * covered code (a feature deletion, not a test deletion), move the number by hand in
 * the same PR and say why.
 *
 * Usage: pnpm test:coverage:raise [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const METRICS = ['statements', 'branches', 'functions', 'lines'];

// This file lives in apps/desktop/scripts, so one level up is the desktop package root.
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const summaryPath = join(desktopRoot, '.coverage/unit/coverage-summary.json');
const configPath = join(desktopRoot, 'vitest.config.ts');

/**
 * The floor always keeps at least one point of headroom below the measured value, so a
 * single refactor that shifts a few lines does not fail the build for no reason while a
 * genuine regression still does.
 */
const HEADROOM_POINTS = 1;

function readMeasuredTotals() {
    let summary;
    try {
        summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    } catch (error) {
        throw new Error(
            `Cannot read the coverage summary at ${summaryPath}. Run "pnpm test:coverage" first.`,
            { cause: error }
        );
    }

    const total = summary?.total;
    if (!total || typeof total !== 'object') {
        throw new Error('The coverage summary has no "total" object.');
    }

    return total;
}

export function decideNextFloor(configured, measured) {
    const next = {};
    const raised = [];

    for (const metric of METRICS) {
        const reachable = Math.max(0, Math.floor(measured[metric].pct - HEADROOM_POINTS));

        // The ratchet only turns one way.
        if (reachable <= configured[metric]) {
            next[metric] = configured[metric];
            continue;
        }

        next[metric] = reachable;
        raised.push({
            metric,
            from: configured[metric],
            to: reachable,
            measured: measured[metric].pct,
        });
    }

    return { next, raised };
}

export function readConfiguredFloor(config) {
    const start = config.indexOf('thresholds: {');
    if (start < 0) {
        throw new Error('vitest.config.ts has no "thresholds:" block.');
    }

    const block = config.slice(start);
    const floor = {};

    for (const metric of METRICS) {
        const match = block.match(new RegExp(`^\\s{8}${metric}: (\\d+(?:\\.\\d+)?),`, 'm'));
        if (!match) {
            throw new Error(`Cannot find the global "${metric}" floor in vitest.config.ts.`);
        }
        floor[metric] = Number(match[1]);
    }

    return floor;
}

export function applyFloor(config, floor) {
    const start = config.indexOf('thresholds: {');
    const head = config.slice(0, start);
    const tail = config.slice(start);

    const nextTail = METRICS.reduce((acc, metric) => {
        const pattern = new RegExp(`^(\\s{8})${metric}: \\d+(?:\\.\\d+)?,`, 'm');
        if (!pattern.test(acc)) {
            throw new Error(`Cannot rewrite the global "${metric}" floor.`);
        }

        return acc.replace(pattern, `$1${metric}: ${floor[metric]},`);
    }, tail);

    return head + nextTail;
}

function main() {
    const dryRun = process.argv.includes('--dry-run');

    const measured = readMeasuredTotals();
    const config = readFileSync(configPath, 'utf8');
    const configured = readConfiguredFloor(config);
    const { next, raised } = decideNextFloor(configured, measured);

    if (raised.length === 0) {
        console.log('Coverage floor is already at or above the measured level; nothing to raise.');
        for (const metric of METRICS) {
            console.log(
                `  ${metric.padEnd(11)} floor ${configured[metric]}%  measured ${measured[metric].pct}%`
            );
        }
        return;
    }

    for (const { metric, from, to, measured: pct } of raised) {
        console.log(`  ${metric.padEnd(11)} floor ${from}% -> ${to}%  (measured ${pct}%)`);
    }

    if (dryRun) {
        console.log('--dry-run: vitest.config.ts not written.');
        return;
    }

    writeFileSync(configPath, applyFloor(config, next), 'utf8');
    console.log(
        'Raised the coverage floor in vitest.config.ts. Commit it with the change that earned it.'
    );
}

// Only run when invoked directly. Without this guard, importing the module for its pure
// helpers runs main() against whatever cwd the importer has, and process.exit() would take
// the whole test file down with it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        console.error(`Coverage ratchet failed: ${error.message ?? error}`);
        process.exit(1);
    }
}
