import { pathToFileURL } from 'node:url';

import { buildBoth } from './lib/build.mjs';
import { artifactsRoot, evidenceRoot, logsRoot } from './lib/config.mjs';
import { prepareFixtures } from './lib/fixtures.mjs';
import { appendLog, ensureDirectory, nowIso } from './lib/io.mjs';
import { acquirePerformanceHarnessLock } from './lib/lock.mjs';
import { runMeasurements } from './lib/orchestrator.mjs';
import { parseArgs, readOptions } from './lib/protocol.mjs';
import { prepareSnapshots } from './lib/snapshots.mjs';
import { generateStats } from './stats/generate.mjs';

function performanceGateError(stats) {
    if (!stats) return 'Desktop performance evidence is missing stats.json.';
    if (!Number.isInteger(stats.rawCounts?.invalidRuns)) {
        return 'Desktop performance evidence is missing a valid rawCounts.invalidRuns.';
    }
    if (stats.rawCounts.invalidRuns !== 0) {
        return `Desktop performance protocol recorded ${stats.rawCounts.invalidRuns} invalid run(s).`;
    }
    if (stats.overallStatus !== 'PASS') {
        return `Desktop performance gate is ${stats.overallStatus ?? 'missing'}.`;
    }
    return null;
}

async function executeCommand(command, args, options) {
    if (command === 'prepare') {
        ensureDirectory(evidenceRoot);
        const manifest = prepareSnapshots(args);
        console.log(
            `Prepared snapshots. Current manifest ${manifest.current.sha256}; baseline ${manifest.baseline.sha256}.`
        );
        return;
    }
    if (command === 'build') {
        ensureDirectory(evidenceRoot);
        const builds = await buildBoth();
        for (const build of builds) {
            console.log(
                `${build.arm}: ${build.binarySha256} (${build.binarySize} bytes, ${build.elapsedMs}ms)`
            );
        }
        return;
    }
    if (command === 'fixture') {
        ensureDirectory(evidenceRoot);
        const manifest = await prepareFixtures();
        console.log(JSON.stringify(manifest.arms, null, 2));
        return;
    }
    if (command === 'run') {
        if (!options.dryRun) ensureDirectory(evidenceRoot);
        await runMeasurements(options);
        return;
    }
    if (command === 'stats') {
        ensureDirectory(evidenceRoot);
        await generateStats();
        return;
    }
    if (command === 'gate') {
        ensureDirectory(evidenceRoot);
        const stats = await generateStats();
        const error = performanceGateError(stats);
        if (error) throw new Error(error);
        console.log('Desktop performance gate passed.');
        return;
    }
    if (command === 'all') {
        ensureDirectory(evidenceRoot);
        prepareSnapshots(args);
        await buildBoth();
        await prepareFixtures();
        try {
            await runMeasurements(options);
        } finally {
            const stats = await generateStats();
            if (stats.overallStatus !== 'PASS') process.exitCode = 1;
        }
        return;
    }

    throw new Error(
        'Usage: run.mjs <prepare|build|fixture|run|stats|gate|all> [--flows ...] [--dry-run] [--resume]'
    );
}

function commandNeedsLock(command, options) {
    if (command === 'run') return !options.dryRun;
    return ['prepare', 'build', 'fixture', 'stats', 'gate', 'all'].includes(command);
}

async function main() {
    const [command = 'all', ...rest] = process.argv.slice(2);
    const args = parseArgs(rest);

    // `all` rebuilds both binaries and regenerates every fixture before it
    // measures. Resuming must not silently compare against a new baseline, so
    // resume is only supported on the `run` command.
    if (command === 'all' && args.resume === 'true') {
        throw new Error(
            'Usage: run.mjs run --resume preserves the saved plan and fixtures; `all` rebuilds them.'
        );
    }

    const options = command === 'run' || command === 'all' ? readOptions(args) : null;
    if (!commandNeedsLock(command, options)) {
        await executeCommand(command, args, options);
        return;
    }

    const lock = acquirePerformanceHarnessLock({
        command,
        evidenceRoot,
        artifactsRoot,
    });
    try {
        await executeCommand(command, args, options);
    } finally {
        lock.release();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        if (error?.code !== 'PERF_HARNESS_LOCKED') {
            const log = `${logsRoot}/runner-error.log`;
            appendLog(log, `\nat=${nowIso()}\n${error?.stack ?? String(error)}\n`);
        }
        console.error(error);
        process.exitCode = 1;
    });
}
