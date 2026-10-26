/**
 * Turns Playwright's JSON report into the markdown a reviewer reads on the PR.
 *
 * Failing a job is not a report: it tells the reviewer that something moved, not
 * what, and leaves the images on a runner that is about to be destroyed. This writes
 * the missing half — which snapshot differs, and where its images are — to the job
 * summary and to the pull request, so nobody has to open the Actions log to find out
 * what to look at.
 *
 * Usage: node scripts/ci/visual-summary.mjs [report.json]
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const reportPath = process.argv[2] ?? 'test-results/results.json';
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
/**
 * The same markdown goes to two places. The job summary is where a failure is
 * documented; the output file is what the workflow posts as a pull request comment,
 * because a summary is only visible to someone who already suspected the job failed.
 */
const outputPath = process.env.VISUAL_SUMMARY_OUTPUT;
const runUrl = process.env.RUN_URL;

/**
 * Writes the report to every sink that is configured, and to stdout when none is, so
 * running the script by hand still prints something useful.
 */
const emit = (markdown) => {
    if (outputPath) {
        writeFileSync(outputPath, markdown, 'utf8');
    }

    if (summaryPath) {
        appendFileSync(summaryPath, markdown);
        return;
    }

    if (!outputPath) {
        process.stdout.write(markdown);
    }
};

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

/**
 * Finds one image of a failed screenshot comparison.
 *
 * On a pixel mismatch Playwright attaches all three, named
 * `<snapshot-stem>-{expected,actual,diff}.png`. A comparison that never got as far as
 * producing pixels — an undecodable baseline, a story that never rendered — attaches
 * only `-expected.png` or nothing at all. Each name is therefore looked up on its own
 * rather than assuming the trio exists, and a missing one is reported as missing
 * instead of being invented.
 */
const describeAttachment = (attachments, suffix) => {
    const pattern = new RegExp(`-${suffix}\\.(png|webp|jpg|jpeg)$`, 'i');

    for (const attachment of attachments ?? []) {
        const base = attachment.path ? path.basename(attachment.path) : '';

        if (pattern.test(attachment.name ?? '') || pattern.test(base)) {
            return base || attachment.name;
        }
    }

    return null;
};

const report = readReport();

if (!report) {
    // A crash before the reporter ran leaves no report; say so instead of
    // claiming there were no visual differences.
    emit(
        [
            '## Component visual tests',
            '',
            `No JSON report was written to \`${reportPath}\`, so this run failed before or`,
            'outside the visual comparison. Check the job log.',
            '',
        ].join('\n')
    );

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
        const expected = describeAttachment(attachments, 'expected');

        return {
            title: spec.title,
            file: spec.file,
            stem: expected ? expected.replace(/-expected\.\w+$/, '') : null,
            expected,
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
        ''
    );

    if (runUrl) {
        lines.push(
            `[Open the \`component-visual-diffs\` artifact](${runUrl}#artifacts) to see the`,
            'images themselves.',
            ''
        );
    } else {
        lines.push(
            'Open the `component-visual-diffs` artifact from this run to see the images',
            'themselves.',
            ''
        );
    }

    lines.push('| Snapshot | Expected | Actual | Diff |', '| --- | --- | --- | --- |');

    for (const failure of failures) {
        lines.push(
            `| \`${failure.stem ?? failure.title}\` | ${failure.expected ?? '—'} | ${failure.actual ?? '—'} | ${failure.diff ?? '—'} |`
        );
    }

    lines.push('');

    // A row with no actual or diff means the comparison never produced pixels: the
    // baseline did not decode, or the story never rendered. That is a different problem
    // from "the design changed", and saying so saves a confusing round trip.
    const withoutPixels = failures.filter((failure) => !failure.actual);

    if (withoutPixels.length > 0) {
        lines.push(
            `> ${withoutPixels.length} of these never produced a pixel comparison, so there is`,
            '> nothing to compare — the baseline file or the story itself is broken rather',
            '> than the design having changed. Check the job log for the decode or render',
            '> error.',
            ''
        );
    }
}

// The hint is unconditional: a green run needs it too, because the next reader may be
// looking at why a previous run was refreshed. GitHub cannot render the artifact images
// inline — they need authentication, and a comment cannot embed them — so the command
// is the useful thing to leave behind.
lines.push(
    '<details>',
    '<summary>Updating these baselines</summary>',
    '',
    'If a change above is intended, comment:',
    '',
    '```',
    '/approve-visuals',
    '```',
    '',
    'That regenerates the baselines in the pinned renderer — the same one that produced',
    'the comparison — and commits them to this branch. Use',
    '`/approve-visuals components` or `/approve-visuals e2e` to refresh only one layer.',
    '',
    'Do not regenerate them locally: the pixels would come from a different environment',
    'than the one that gates this pull request, which is how a wrong baseline gets',
    'committed and then fails for everyone.',
    '',
    '</details>',
    ''
);

emit(lines.join('\n'));
