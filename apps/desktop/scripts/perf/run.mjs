import { pathToFileURL } from 'node:url';

import { buildBoth } from './lib/build.mjs';
import { parseArgs } from './lib/cli.mjs';
import { evidenceRoot, logsRoot } from './lib/config.mjs';
import { prepareFixtures } from './lib/fixtures.mjs';
import { appendLog, ensureDirectory, nowIso } from './lib/io.mjs';
import { runMeasurements } from './lib/orchestrator.mjs';
import { readOptions } from './lib/protocol.mjs';
import { prepareSnapshots } from './lib/snapshots.mjs';
import { generateStats } from './stats/generate.mjs';

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

    ensureDirectory(logsRoot);
    ensureDirectory(evidenceRoot);

    if (command === 'prepare') {
        const manifest = prepareSnapshots(args);
        console.log(
            `Prepared snapshots. Current manifest ${manifest.current.sha256}; baseline ${manifest.baseline.sha256}.`
        );
        return;
    }
    if (command === 'build') {
        const builds = await buildBoth();
        for (const build of builds) {
            console.log(
                `${build.arm}: ${build.binarySha256} (${build.binarySize} bytes, ${build.elapsedMs}ms)`
            );
        }
        return;
    }
    if (command === 'fixture') {
        const manifest = await prepareFixtures();
        console.log(JSON.stringify(manifest.arms, null, 2));
        return;
    }
    if (command === 'run') {
        await runMeasurements(readOptions(args));
        return;
    }
    if (command === 'stats') {
        await generateStats();
        return;
    }
    if (command === 'all') {
        prepareSnapshots(args);
        await buildBoth();
        await prepareFixtures();
        try {
            await runMeasurements(readOptions(args));
        } finally {
            const stats = await generateStats();
            if (stats.overallStatus !== 'PASS') process.exitCode = 1;
        }
        return;
    }

    throw new Error(
        'Usage: run.mjs <prepare|build|fixture|run|stats|all> [--flows ...] [--dry-run] [--resume]'
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const log = `${logsRoot}/runner-error.log`;
        appendLog(log, `\nat=${nowIso()}\n${error?.stack ?? String(error)}\n`);
        console.error(error);
        process.exitCode = 1;
    });
}
