import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node compare.mjs <report-directory>');
const reports = readdirSync(directory)
    .filter((name) => /^sample-\d+-(baseline|head)\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
const groups = Object.fromEntries(
    ['baseline', 'head'].map((variant) => [
        variant,
        reports.filter((report) => report.variant === variant),
    ])
);
const cases = ['menu', 'model', 'confirm', 'import'];
const positive = (value) => Number.isFinite(value) && value > 0;
for (const [variant, samples] of Object.entries(groups)) {
    if (samples.length !== 6 || new Set(samples.map((sample) => sample.block)).size !== 6) {
        throw new Error(`${variant} requires six independent native sessions.`);
    }
    if (new Set(samples.map((sample) => sample.commit)).size !== 1 || !samples[0].commit) {
        throw new Error(`${variant} must identify one tested commit.`);
    }
    for (const sample of samples) {
        if (sample.memory?.length !== 5) throw new Error('Missing steady-state memory samples.');
        for (const memory of sample.memory) {
            for (const metric of ['privateBytes', 'workingSetBytes', 'processes', 'renderers']) {
                if (!positive(memory[metric])) throw new Error(`Invalid native memory ${metric}.`);
            }
        }
        for (const name of cases) {
            const flow = sample.cases?.[name];
            if (!flow || !positive(flow.dom)) throw new Error(`Missing rendered ${name} evidence.`);
            for (const phase of ['openMs', 'closeMs']) {
                if (flow[phase]?.length !== 50 || !flow[phase].every(positive)) {
                    throw new Error(
                        `${name} ${phase} requires 50 finite native samples per session.`
                    );
                }
            }
            if (
                flow.environment?.reducedMotion !== false ||
                flow.environment?.visibility !== 'visible'
            ) {
                throw new Error('Performance must measure visible windows with normal motion.');
            }
        }
    }
}
for (const name of cases) {
    const environment = JSON.stringify(reports[0].cases[name].environment);
    if (reports.some((report) => JSON.stringify(report.cases[name].environment) !== environment)) {
        throw new Error(`${name} must use the same WebView, DPI and viewport in every session.`);
    }
}

const percentile = (values, fraction) =>
    [...values].sort((left, right) => left - right)[
        Math.max(0, Math.ceil(values.length * fraction) - 1)
    ];
const metrics = [];
function compare(name, select, fraction) {
    const baseline = percentile(groups.baseline.flatMap(select), fraction);
    const head = percentile(groups.head.flatMap(select), fraction);
    const change = (head / baseline - 1) * 100;
    metrics.push({ name, baseline, head, change, passed: head <= baseline * 1.05 });
}
for (const name of cases) {
    for (const phase of ['openMs', 'closeMs']) {
        for (const [label, fraction] of [
            ['P50', 0.5],
            ['P95', 0.95],
        ]) {
            compare(`${name} ${phase} ${label}`, (report) => report.cases[name][phase], fraction);
        }
    }
    compare(`${name} retained DOM P95`, (report) => [report.cases[name].dom], 0.95);
}
for (const metric of ['privateBytes', 'workingSetBytes', 'processes', 'renderers']) {
    compare(
        `native ${metric} P95`,
        (report) => report.memory.map((sample) => sample[metric]),
        0.95
    );
}
const passed = metrics.every((metric) => metric.passed);
const summary = {
    passed,
    baseline: groups.baseline[0].commit,
    head: groups.head[0].commit,
    sessionsPerRevision: 6,
    samplesPerPhase: 300,
    metrics,
};
const markdown = [
    '## Native lifecycle release acceptance',
    '',
    `Baseline: \`${summary.baseline}\`; head: \`${summary.head}\`.`,
    'Six sessions per revision in alternating ABBA blocks; 300 warm samples per phase after five unreported warmups per session. Normal motion, identical WebView/DPI/viewport; whole native process-tree memory, not just the JS heap.',
    '',
    '| Metric | Baseline | Head | Change | <=5% |',
    '| --- | ---: | ---: | ---: | :---: |',
    ...metrics.map(
        (metric) =>
            `| ${metric.name} | ${metric.baseline.toFixed(2)} | ${metric.head.toFixed(2)} | ${metric.change.toFixed(2)}% | ${metric.passed ? 'pass' : 'FAIL'} |`
    ),
    '',
    'Long-task durations and every raw latency, DOM and process-memory sample are included in the artifact. Timing starts at DOM input dispatch and ends after the actual native-hosted UI and animations settle; no animation disabling or mocked lifecycle owners.',
    '',
    passed
        ? 'All measured budgets passed.'
        : 'Acceptance failed; do not retry until green or relax the budget.',
    '',
].join('\n');
writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(path.join(directory, 'summary.md'), markdown);
console.log(markdown);
process.exitCode = passed ? 0 : 1;
