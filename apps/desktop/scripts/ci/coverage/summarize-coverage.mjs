import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FRONTEND_METRICS = [
    ['statements', 'Statements'],
    ['branches', 'Branches'],
    ['functions', 'Functions'],
    ['lines', 'Lines'],
];

const COVERAGE_KINDS = ['frontend', 'rust'];

// moduleDirectory is apps/desktop/scripts/ci/coverage, so three levels up is apps/desktop.
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(moduleDirectory, '../../..');
const repositoryRoot = resolve(desktopRoot, '..', '..');

const USAGE =
    'Usage: node scripts/ci/coverage/summarize-coverage.mjs --kind <frontend|rust> --input <path> [--summary <path>] | --resolve-rust';

function formatPercent(percent) {
    return `${percent.toFixed(2)}%`;
}

function formatPercentTable(rows) {
    return [
        '| Metric | Percent |',
        '| --- | ---: |',
        ...rows.map(([label, percent]) => `| ${label} | ${formatPercent(percent)} |`),
    ];
}

function formatRustTable(coverage) {
    // Line and region coverage are always reported by cargo-llvm-cov. Branch coverage is
    // only present when the run used a nightly toolchain with --branch, so render it only
    // when it was actually measured rather than printing a zero for a missing measurement.
    const rows = [
        ['Lines', coverage.lines],
        ['Regions', coverage.regions],
    ];
    if (coverage.branches.total > 0) {
        rows.push(['Branches', coverage.branches]);
    }

    const hasCounts = rows.every(
        ([, metric]) => typeof metric.covered === 'number' && typeof metric.total === 'number'
    );

    if (!hasCounts) {
        return formatPercentTable(rows.map(([label, metric]) => [label, metric.percent]));
    }

    return [
        '| Metric | Percent | Covered | Total |',
        '| --- | ---: | ---: | ---: |',
        ...rows.map(
            ([label, metric]) =>
                `| ${label} | ${formatPercent(metric.percent)} | ${metric.covered} | ${metric.total} |`
        ),
    ];
}

function readLlmCovTotal(totals, key, { required = true } = {}) {
    const entry = totals?.[key];

    if (!entry || typeof entry !== 'object') {
        if (!required) {
            return { percent: 0, covered: 0, total: 0 };
        }

        throw new Error(`Rust coverage report is missing totals.${key}.`);
    }

    const percent = Number(entry.percent);
    if (!Number.isFinite(percent)) {
        throw new Error(`Rust coverage report has a non-numeric totals.${key}.percent.`);
    }

    return {
        percent,
        covered: Number(entry.covered),
        total: Number(entry.count),
    };
}

/**
 * cargo-llvm-cov --json emits one entry per crate in `data`, each carrying its own `totals`
 * with lines/regions/branches/functions as {count, covered, percent}. A workspace with a lib
 * and a bin target yields more than one entry, so the totals are summed rather than taking
 * the first crate, and the percentage is derived from the summed counts.
 */
export function parseLlvmCovCoverage(json) {
    if (typeof json !== 'string' || !json.trim()) {
        throw new Error('Rust coverage report is empty.');
    }

    let report;
    try {
        report = JSON.parse(json);
    } catch (error) {
        throw new Error(`Cannot parse Rust coverage report: ${error.message}`);
    }

    const entries = Array.isArray(report?.data) ? report.data : [];
    if (entries.length === 0) {
        throw new Error('Rust coverage report has no "data" entries.');
    }

    const totals = entries.map((entry) => entry?.totals);
    if (totals.some((total) => !total || typeof total !== 'object')) {
        throw new Error('Rust coverage report is missing a "totals" object.');
    }

    const sum = (key, required = true) => {
        const perEntry = totals.map((total) => readLlmCovTotal(total, key, { required }));
        const count = perEntry.reduce((acc, metric) => acc + (metric.total || 0), 0);
        const covered = perEntry.reduce((acc, metric) => acc + (metric.covered || 0), 0);

        return {
            percent: count > 0 ? (covered / count) * 100 : 0,
            covered,
            total: count,
        };
    };

    return {
        lines: sum('lines'),
        regions: sum('regions'),
        // Branch coverage requires a nightly toolchain plus --branch; absent is normal.
        branches: sum('branches', false),
    };
}

export function formatFrontendCoverage(summary) {
    const total = summary?.total;
    if (!total || typeof total !== 'object') {
        throw new Error('Frontend coverage summary is missing the "total" object.');
    }

    const rows = FRONTEND_METRICS.map(([key, label]) => {
        const percent = total[key]?.pct;
        if (typeof percent !== 'number' || Number.isNaN(percent)) {
            throw new Error(`Frontend coverage summary is missing a numeric total.${key}.pct.`);
        }

        return [label, percent];
    });

    return ['## Frontend Coverage', '', ...formatPercentTable(rows), ''].join('\n');
}

export function formatRustCoverage(json) {
    const coverage = parseLlvmCovCoverage(json);
    const lines = ['## Rust Coverage', '', ...formatRustTable(coverage)];

    if (coverage.branches.total === 0) {
        lines.push(
            '',
            '_Branch coverage requires a nightly toolchain with `--branch`, so this run reports line and region coverage only._'
        );
    }

    lines.push('');

    return lines.join('\n');
}

export function appendStepSummary(summaryPath, markdown) {
    if (typeof summaryPath !== 'string' || !summaryPath.trim()) {
        throw new Error(
            'Missing step summary path: set GITHUB_STEP_SUMMARY or pass --summary <path>.'
        );
    }

    const existing = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : '';
    const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';

    appendFileSync(summaryPath, `${separator}${markdown}`);
}

function readInput(inputPath, label) {
    if (!existsSync(inputPath)) {
        throw new Error(`Missing ${label}: ${inputPath}.`);
    }

    return readFileSync(inputPath, 'utf8');
}

function readFrontendSummary(inputPath) {
    const raw = readInput(inputPath, 'frontend coverage summary');

    try {
        return JSON.parse(raw);
    } catch (error) {
        throw new Error(`Cannot parse frontend coverage summary ${inputPath}: ${error.message}`);
    }
}

/**
 * `test:coverage:rust` passes an explicit `--output-path`, so unlike the previous
 * cargo-tarpaulin setup the report location is not ambiguous. The candidate list is kept so
 * a caller can still probe a moved report, and TOUCHAI_COVERAGE_ROOT lets CI (and tests)
 * point the probe at another checkout root.
 */
export function resolveRustCoverageCandidates(root = process.env.TOUCHAI_COVERAGE_ROOT || desktopRoot) {
    return [join(root, 'src-tauri', 'coverage.json'), join(root, 'coverage.json')];
}

export function resolveRustCoverageReport(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error('Cannot resolve the Rust coverage report without candidate paths.');
    }

    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        throw new Error(
            [
                'No Rust coverage report found. cargo-llvm-cov did not produce a coverage.json.',
                'Looked in:',
                ...candidates.map((candidate) => `  - ${candidate}`),
            ].join('\n')
        );
    }

    return found;
}

function displayPath(path) {
    const relativePath = relative(repositoryRoot, path);

    return relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)
        ? relativePath
        : path;
}

export function summarizeCoverageFile({ kind, inputPath, summaryPath }) {
    if (!COVERAGE_KINDS.includes(kind)) {
        throw new Error(
            `Unknown coverage kind: ${kind}. Expected one of: ${COVERAGE_KINDS.join(', ')}.`
        );
    }

    const markdown =
        kind === 'frontend'
            ? formatFrontendCoverage(readFrontendSummary(inputPath))
            : formatRustCoverage(readInput(inputPath, 'rust coverage report'));

    appendStepSummary(summaryPath, markdown);

    return markdown;
}

function readOption(argv, index, name) {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${name}. ${USAGE}`);
    }

    return value;
}

export function parseArgs(argv, env = process.env) {
    const options = {
        kind: null,
        inputPath: null,
        summaryPath: env.GITHUB_STEP_SUMMARY || null,
        resolveRust: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === '--resolve-rust') {
            options.resolveRust = true;
        } else if (argument === '--kind') {
            options.kind = readOption(argv, index, '--kind');
            index += 1;
        } else if (argument === '--input') {
            options.inputPath = readOption(argv, index, '--input');
            index += 1;
        } else if (argument === '--summary') {
            options.summaryPath = readOption(argv, index, '--summary');
            index += 1;
        } else {
            throw new Error(`Unknown argument: ${argument}. ${USAGE}`);
        }
    }

    if (options.resolveRust) {
        return options;
    }

    if (!COVERAGE_KINDS.includes(options.kind)) {
        throw new Error(
            `Missing or invalid --kind. Expected one of: ${COVERAGE_KINDS.join(', ')}. ${USAGE}`
        );
    }

    if (!options.inputPath) {
        throw new Error(`Missing --input path for the coverage report. ${USAGE}`);
    }

    if (!options.summaryPath) {
        throw new Error(
            'Missing step summary path: set GITHUB_STEP_SUMMARY or pass --summary <path>. ' + USAGE
        );
    }

    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));

    if (options.resolveRust) {
        const reportPath = resolveRustCoverageReport(resolveRustCoverageCandidates());
        console.log(displayPath(reportPath));
        return;
    }

    summarizeCoverageFile(options);
    console.log(`Appended ${options.kind} coverage table to ${options.summaryPath}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        main();
    } catch (error) {
        console.error(`Coverage summary failed: ${error.message ?? error}`);
        process.exit(1);
    }
}
