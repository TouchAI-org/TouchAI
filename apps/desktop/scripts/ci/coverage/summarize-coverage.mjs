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
    const rows = [
        ['Lines', coverage.lines],
        ['Branches', coverage.branches],
    ];
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

function readCount(attributes, name) {
    if (!attributes.has(name)) {
        return null;
    }

    const value = Number(attributes.get(name));
    return Number.isFinite(value) ? value : null;
}

function readMetric(attributes, rateName, coveredName, totalName) {
    if (!attributes.has(rateName)) {
        throw new Error(
            `Rust coverage report is missing the ${rateName} attribute on the <coverage> element.`
        );
    }

    const rate = Number(attributes.get(rateName));
    if (!Number.isFinite(rate)) {
        throw new Error(
            `Rust coverage report has a non-numeric ${rateName} attribute: ${attributes.get(rateName)}.`
        );
    }

    return {
        percent: rate * 100,
        covered: readCount(attributes, coveredName),
        total: readCount(attributes, totalName),
    };
}

export function parseCoberturaCoverage(xml) {
    if (typeof xml !== 'string' || !xml.trim()) {
        throw new Error('Rust coverage report is empty.');
    }

    // Only the root element carries the aggregate rates; nested <class> elements repeat
    // line-rate/branch-rate per file and would otherwise win the match.
    const rootElement = xml.match(/<coverage\b([\s\S]*?)>/);
    if (!rootElement) {
        throw new Error('Rust coverage report is missing the <coverage> root element.');
    }

    const attributes = new Map();
    for (const match of rootElement[1].matchAll(/([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/g)) {
        attributes.set(match[1], match[2]);
    }

    return {
        lines: readMetric(attributes, 'line-rate', 'lines-covered', 'lines-valid'),
        branches: readMetric(attributes, 'branch-rate', 'branches-covered', 'branches-valid'),
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

export function formatRustCoverage(xml) {
    const coverage = parseCoberturaCoverage(xml);
    const lines = ['## Rust Coverage', '', ...formatRustTable(coverage)];

    if (coverage.branches.total === 0) {
        lines.push(
            '',
            '_cargo-tarpaulin writes zero branch totals in its Cobertura report, so the branch rate is always 0._'
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
 * cargo-tarpaulin writes cobertura.xml into `Config::output_dir()`, which defaults to the
 * Cargo workspace root (`--manifest-path` resolves it) but has historically been reported at
 * the working directory instead. `test:coverage:rust` runs from apps/desktop with
 * `--manifest-path src-tauri/Cargo.toml`, so both are plausible; probe both rather than guess.
 * TOUCHAI_COVERAGE_ROOT lets CI (and tests) point the probe at another checkout root.
 */
export function resolveRustCoverageCandidates(root = process.env.TOUCHAI_COVERAGE_ROOT || desktopRoot) {
    return [join(root, 'src-tauri', 'cobertura.xml'), join(root, 'cobertura.xml')];
}

export function resolveRustCoverageReport(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error('Cannot resolve the Rust coverage report without candidate paths.');
    }

    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        throw new Error(
            [
                'No Rust coverage report found. cargo-tarpaulin did not produce a cobertura.xml.',
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
