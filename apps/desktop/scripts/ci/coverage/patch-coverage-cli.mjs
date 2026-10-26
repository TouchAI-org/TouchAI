#!/usr/bin/env node
// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * Gate a pull request on the coverage of the lines it changed.
 *
 * Usage:
 *   node scripts/ci/coverage/patch-coverage.mjs \
 *     --coverage .coverage/unit/coverage-final.json \
 *     --base origin/main \
 *     --root . \
 *     [--floor 85] [--summary "$GITHUB_STEP_SUMMARY"] [--dry-run]
 *
 * The global floor protects the repository as a whole; this protects the diff. A change
 * that adds a feature with no tests fails here even when the total barely moves.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    checkPatchCoverage,
    formatPatchCoverage,
    measurePatchCoverage,
    parseChangedLines,
} from './patch-coverage.mjs';

const USAGE =
    'Usage: node scripts/ci/coverage/patch-coverage.mjs --coverage <coverage-final.json> ' +
    '--base <git-ref> [--root <dir>] [--floor <percent>] [--summary <path>] [--dry-run]';

const DEFAULT_FLOOR = 85;

/** Source files only: tests and config are not the thing being measured. */
const IGNORED = [/^apps\/desktop\/tests\//, /^apps\/desktop\/scripts\//, /\.d\.ts$/, /^docs\//];

function readOption(argv, index, name) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${name}. ${USAGE}`);
    }

    return value;
}

export function parseArgs(argv, env = process.env) {
    const options = {
        coveragePath: undefined,
        base: env.TOUCHAI_PATCH_BASE || 'origin/main',
        root: '.',
        floor: DEFAULT_FLOOR,
        summaryPath: env.GITHUB_STEP_SUMMARY,
        dryRun: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--coverage') {
            options.coveragePath = readOption(argv, index, '--coverage');
            index += 1;
        } else if (argument === '--base') {
            options.base = readOption(argv, index, '--base');
            index += 1;
        } else if (argument === '--root') {
            options.root = readOption(argv, index, '--root');
            index += 1;
        } else if (argument === '--floor') {
            options.floor = Number(readOption(argv, index, '--floor'));
            index += 1;
        } else if (argument === '--summary') {
            options.summaryPath = readOption(argv, index, '--summary');
            index += 1;
        } else if (argument === '--dry-run') {
            options.dryRun = true;
        } else {
            throw new Error(`Unknown argument: ${argument}. ${USAGE}`);
        }
    }

    if (!options.coveragePath) {
        throw new Error(`Missing --coverage. ${USAGE}`);
    }

    if (!Number.isFinite(options.floor)) {
        throw new Error(`--floor must be a number. ${USAGE}`);
    }

    return options;
}

/**
 * `git diff --unified=0 <base> -- <path>` gives just the added lines.
 *
 * A shallow CI checkout often has no `origin/main` ref, so fall back to fetching the base
 * and, failing that, to an empty diff with a loud warning: a missing ref must not be
 * reported as "the change touched nothing", because that would silently pass the gate.
 */
export function readDiff(base, path) {
    const run = (ref) =>
        execFileSync('git', ['diff', '--unified=0', '--no-color', ref, '--', path], {
            encoding: 'utf8',
            maxBuffer: 32 * 1024 * 1024,
        });

    try {
        return run(base);
    } catch {
        // Try to materialise the ref, then retry once.
        try {
            execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base.replace(/^origin\//, '')], {
                stdio: 'ignore',
            });
            return run(base);
        } catch {
            throw new Error(
                `Cannot diff against "${base}": the ref is not available in this checkout. ` +
                    'Pass --base with a commit that exists (CI uses the PR base SHA).'
            );
        }
    }
}

export function runPatchCoverage(options, { readDiff: diff = readDiff } = {}) {
    if (!existsSync(options.coveragePath)) {
        throw new Error(
            `Coverage report not found: ${options.coveragePath}. ` +
                'Run the frontend suite with --coverage first.'
        );
    }

    // Only the app source is measured: the tests and the scripts are the instrument.
    const changed = parseChangedLines(diff(options.base, 'apps/desktop/src'));
    const report = JSON.parse(readFileSync(options.coveragePath, 'utf8'));

    const result = measurePatchCoverage(changed, report, {
        repoRoot: options.root,
        ignore: (path) => IGNORED.some((pattern) => pattern.test(path)),
    });

    const markdown = formatPatchCoverage(result, options.floor);
    if (options.summaryPath && !options.dryRun) {
        appendFileSync(options.summaryPath, `${markdown}\n`);
    }

    return { result, markdown, failures: checkPatchCoverage(result, options.floor) };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const { result, markdown, failures } = runPatchCoverage(options);

    process.stdout.write(`${markdown}\n`);

    if (options.dryRun) {
        return;
    }

    if (failures.length > 0) {
        for (const failure of failures) {
            process.stderr.write(`::error::${failure}\n`);
        }
        process.exitCode = 1;
        return;
    }

    process.stdout.write(
        `Patch coverage ${result.percent.toFixed(2)}% meets the floor of ${options.floor}%.\n`
    );
}

// pathToFileURL handles the Windows drive-letter form; a hand-built string does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
