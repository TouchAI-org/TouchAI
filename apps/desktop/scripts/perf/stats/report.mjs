import fs from 'node:fs';
import path from 'node:path';

import { arms, evidenceRoot } from '../lib/config.mjs';

function formatNumber(value, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toLocaleString('en-US', {
              maximumFractionDigits: digits,
              minimumFractionDigits: 0,
          })
        : '—';
}

function formatRatio(value) {
    return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(4)}x` : '—';
}

function formatCi(bootstrap) {
    return bootstrap ? `[${bootstrap.lower95.toFixed(4)}, ${bootstrap.upper95.toFixed(4)}]` : '—';
}

function metricMarkdownRows(metrics) {
    return metrics.map((metric) => {
        const baseline = metric.armStats.baseline;
        const current = metric.armStats.current;
        const baselineCluster = baseline.blockCount ?? '—';
        const currentCluster = current.blockCount ?? '—';
        return `| ${metric.label} | ${baseline.runCount}/${baselineCluster}/${baseline.sampleCount} | ${current.runCount}/${currentCluster}/${current.sampleCount} | ${formatNumber(baseline[metric.metric])} | ${formatNumber(current[metric.metric])} | ${formatRatio(metric.observedRatio)} | ${formatCi(metric.bootstrap)} | ${metric.status} |`;
    });
}

export function writeSummaryMarkdown(stats) {
    const lines = [
        '# RFC #710 performance bootstrap report',
        '',
        `Generated: ${stats.generatedAt}`,
        '',
        `Baseline: ${stats.baselineCommit ?? 'missing'}; candidate: ${stats.candidateCommit ?? 'missing'}.`,
        'This comparison measures the selected commits; it is not evidence for the historical pre-refactor RFC acceptance.',
        '',
        'A ratio is `current / baseline`; the 95% interval is a paired A/B/B/A block-cluster percentile bootstrap with 10,000 iterations. Runs without block metadata fall back to an independent run-cluster bootstrap. A gated row is PASS only when the interval upper bound is at most 1.05 and each arm has at least three clusters.',
    ];
    if (stats.latency.status !== 'NOT_RUN') {
        lines.push(
            '',
            '## Streamed task loop',
            '',
            '| Metric | Baseline runs/blocks/samples | Current runs/blocks/samples | Baseline | Current | Ratio | 95% CI | Status |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            ...metricMarkdownRows(stats.latency.metrics)
        );
    }
    if (stats.progress.status !== 'NOT_RUN') {
        lines.push(
            '',
            '## Progress-write steady-state memory',
            '',
            '| Metric | Baseline runs/blocks/samples | Current runs/blocks/samples | Baseline | Current | Ratio | 95% CI | Status |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            ...metricMarkdownRows(stats.progress.metrics)
        );
    }
    if (stats.longSession.status !== 'NOT_RUN') {
        lines.push('', '## Long-session retention');
    }
    for (const level of stats.longSession.levels) {
        lines.push(
            '',
            `### ${level.level} messages (${level.status})`,
            '',
            '| Metric | Baseline runs/blocks/samples | Current runs/blocks/samples | Baseline | Current | Ratio | 95% CI | Status |',
            '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
            ...metricMarkdownRows(level.metrics)
        );
    }
    lines.push(
        '',
        '## Interpretation',
        '',
        '- Only rows marked PASS support the RFC 5% regression budget.',
        '- AUX rows describe first-text latency and transient/quantized memory; they do not replace the gated rows.',
        '- A BLOCKED row means the run set or PSS body was insufficient, not that the regression is acceptable.',
        '- The run count is independent app processes per arm; the block count is the number of paired A/B/B/A clusters. Repeated prompts inside one process are clustered under that run.'
    );
    const file = path.join(evidenceRoot, 'summary.md');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
}

export function writeSamplesCsv(stats) {
    const rows = [['family', 'level', 'metric', 'arm', 'run_id', 'value', 'unit']];
    for (const metric of [...stats.latency.metrics, ...stats.progress.metrics]) {
        for (const arm of arms) {
            for (const [runId, values] of metric.armStats[arm].runs ?? []) {
                for (const value of values) {
                    rows.push([
                        metric.id.split('.')[0],
                        '',
                        metric.id,
                        arm,
                        runId,
                        value,
                        metric.unit,
                    ]);
                }
            }
        }
    }
    for (const level of stats.longSession.levels) {
        for (const metric of level.metrics) {
            for (const arm of arms) {
                for (const [runId, values] of metric.armStats[arm].runs ?? []) {
                    for (const value of values) {
                        rows.push([
                            'long-session',
                            level.level,
                            metric.id,
                            arm,
                            runId,
                            value,
                            metric.unit,
                        ]);
                    }
                }
            }
        }
    }
    const csv = rows
        .map((row) =>
            row
                .map((value) => {
                    const text = String(value ?? '');
                    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
                })
                .join(',')
        )
        .join('\n');
    const file = path.join(evidenceRoot, 'samples.csv');
    fs.writeFileSync(file, `${csv}\n`);
    return file;
}
