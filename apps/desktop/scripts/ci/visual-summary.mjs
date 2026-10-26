/**
 * Turns Playwright's JSON report into the markdown a reviewer reads on the PR.
 *
 * Failing a job is not a report: it tells the reviewer that something moved, not
 * what, and leaves the images on a runner that is about to be destroyed. This
 * writes the missing half to `$GITHUB_STEP_SUMMARY` — which snapshot differs, and
 * where the actual and diff images live — so the reviewer never has to open the
 * Actions log to find out what to look at.
 *
 * Usage: node scripts/ci/visual-summary.mjs [report.json]
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const reportPath = process.argv[2] ?? 'test-results/results.json';
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

/**
 * Playwright nests specs inside arbitrarily deep suites, so the walk collects
 * every spec it can reach rather than assuming a flat shape.
 */
const collectSpecs = (suite, collected = []) => {
    for (const spec of suite.specs ?? []) {
        collected.push(spec);
    }

    for (const child of suite.suites ?? []) {
        collectSpecs(child, collected);
    }

    return collected;
};

const readReport = () => {
    if (!existsSync(reportPath)) {
        return null;
    }

    try {
        return JSON.parse(readFileSync(reportPath, 'utf8'));
    } catch {
        return null;
    }
};

const describeAttachment = (attachments, name) => {
    const attachment = (attachments ?? []).find((entry) => entry.name === name);

    return attachment?.path ? path.basename(attachment.path) : null;
};

const report = readReport();

if (!report) {
    // A crash before the reporter ran leaves no report; say so instead of
    // claiming there were no visual differences.
    const fallback = [
        '## Component visual tests',
        '',
        `No JSON report was written to \`${reportPath}\`, so this run failed before or`,
        'outside the visual comparison. Check the job log.',
        '',
    ].join('\n');

    if (summaryPath) {
        appendFileSync(summaryPath, fallback);
    } else {
        process.stdout.write(fallback);
    }

    process.exit(0);
}

const specs = collectSpecs(report.suites?.[0] ?? {});

const failures = specs
    .map((spec) => {
        const results = spec.tests?.flatMap((test) => test.results ?? []) ?? [];
        const failed = results.filter((result) => result.status !== 'passed');

        if (failed.length === 0) {
            return null;
        }

        const attachments = failed.flatMap((result) => result.attachments ?? []);

        return {
            title: spec.title,
            file: spec.file,
            expected: describeAttachment(attachments, 'expected'),
            actual: describeAttachment(attachments, 'actual'),
            diff: describeAttachment(attachments, 'diff'),
        };
    })
    .filter(Boolean);

const lines = ['## Component visual tests', ''];

if (failures.length === 0) {
    lines.push('Every component baseline matched.', '');
} else {
    lines.push(
        `${failures.length} baseline${failures.length === 1 ? '' : 's'} differ${failures.length === 1 ? 's' : ''} from the committed images.`,
        '',
        'Open the `component-visual-diffs` artifact from this run to compare them;',
        'each row names the files it contains.',
        '',
        '| Story | Expected | Actual | Diff |',
        '| --- | --- | --- | --- |'
    );

    for (const failure of failures) {
        lines.push(
            `| ${failure.title} | ${failure.expected ?? '—'} | ${failure.actual ?? '—'} | ${failure.diff ?? '—'} |`
        );
    }

    lines.push(
        '',
        'If the change is intended, the reviewer approves it with a `/approve-visuals`',
        'comment; the baselines are then regenerated in the pinned renderer and committed',
        'to this branch. Do not regenerate them locally — the pixels would come from a',
        'different environment than the one that gates the pull request.',
        ''
    );
}

const markdown = lines.join('\n');

if (summaryPath) {
    appendFileSync(summaryPath, markdown);
} else {
    process.stdout.write(markdown);
}
