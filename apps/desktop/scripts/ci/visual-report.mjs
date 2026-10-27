/**
 * Turns one visual layer's comparison into the markdown a reviewer reads on the PR.
 *
 * Failing a job is not a report: it tells the reviewer that something moved, not
 * what, and leaves the images on a runner that is about to be destroyed. This writes
 * the missing half — which snapshot differs, and where its images are — to the job
 * summary and to the pull request, so nobody has to open the Actions log to find out
 * what to look at.
 *
 * Both layers write the same shape, because one pull request comment holds both:
 * `visual-comment.mjs` merges each section into that comment under a marker, and the
 * heading below is what tells the reviewer which layer moved.
 *
 * Usage:
 *   node scripts/ci/visual-report.mjs --layer components [--report test-results/results.json]
 *   node scripts/ci/visual-report.mjs --layer e2e \
 *       --diff-dir <dir> --baseline-dir <dir> --actual-dir <dir>
 *
 * Env: VISUAL_SUMMARY_OUTPUT, GITHUB_STEP_SUMMARY, VISUAL_EVIDENCE_URLS, RUN_URL, and
 * VISUAL_TESTS_OUTCOME — the e2e test step's outcome, which is what separates "no
 * baseline differed" from "the suite died before it compared anything".
 */

import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
    options: {
        layer: { type: 'string' },
        report: { type: 'string', default: 'test-results/results.json' },
        'diff-dir': { type: 'string' },
        'baseline-dir': { type: 'string' },
        'actual-dir': { type: 'string' },
    },
});

/**
 * What differs per layer, defined once: the heading is what the reviewer reads, the
 * artifact name is where the images are when they could not be published, and the noun
 * names the baselines in prose.
 */
const LAYERS = {
    components: {
        heading: 'Components',
        artifact: 'component-visual-diffs',
        noun: 'component',
    },
    e2e: {
        heading: 'App window',
        artifact: 'app-visual-diffs',
        noun: 'app',
    },
};

const layerName = values.layer;
const layer = LAYERS[layerName];

if (!layer) {
    // A typo would otherwise produce a clean-looking section that says nothing, which is
    // indistinguishable from a run where every baseline matched.
    console.error(
        `--layer is required and must be one of: ${Object.keys(LAYERS).join(', ')} (got ${JSON.stringify(layerName)})`
    );
    process.exit(1);
}

const reportPath = values.report;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;
/**
 * The same markdown goes to two places. The job summary is where a failure is
 * documented; the output file is what the workflow posts as a pull request comment,
 * because a summary is only visible to someone who already suspected the job failed.
 */
const outputPath = process.env.VISUAL_SUMMARY_OUTPUT;
const runUrl = process.env.RUN_URL;
/**
 * Maps an image file name to the URL it was published at.
 *
 * GitHub's attachment store returns a distinct URL per file
 * (`https://github.com/user-attachments/assets/<uuid>`), so this cannot be a base URL
 * with a name appended. Empty when nothing was uploaded — a fork pull request, or no
 * images produced — in which case the report names the files and links the artifact
 * instead of pretending to show them.
 */
const evidencePath = process.env.VISUAL_EVIDENCE_URLS;

const evidenceUrls = (() => {
    if (!evidencePath || !existsSync(evidencePath)) {
        return {};
    }

    try {
        return JSON.parse(readFileSync(evidencePath, 'utf8'));
    } catch {
        // A malformed map must not take the whole report down: the comparison result
        // is the thing being reported, and the images are supporting evidence.
        return {};
    }
})();

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

        // The attachment *name* is the file name in `test-results/`, which is what gets
        // uploaded, so it is preferred over the path's basename. The two differ for the
        // expected image: Playwright attaches it as `<stem>-expected.png` but points at
        // the committed baseline, whose basename is `<stem>.png`. Using the path there
        // would build a URL for a file that was never uploaded.
        if (pattern.test(attachment.name ?? '')) {
            return attachment.name;
        }

        if (pattern.test(base)) {
            return base;
        }
    }

    return null;
};

/**
 * Makes a value safe to drop into markdown that a bot posts.
 *
 * The spec titles come from the Playwright report, and Playwright serialises them
 * verbatim. A title is therefore attacker-controlled by anyone who can add a file under
 * `tests/visual/` — which is also what triggers this workflow. Left raw, a title can
 * close the table cell, start a new heading, or inject a link, letting a pull request
 * author put words in the trusted automation's mouth on the very report a reviewer uses
 * as evidence. Line breaks, table pipes, backticks and angle brackets are stripped, and
 * the length is bounded.
 */
const plain = (value) =>
    String(value ?? '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/[`|<>\\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200);

/**
 * Whether a test failed in the sense the reviewer cares about.
 *
 * CI runs with `retries: 1`, so `test.results` can hold a failed attempt followed by a
 * passing one, and the job is green. Filtering every non-passed result would report that
 * baseline as differing on a run that passed, which is worse than saying nothing: it
 * sends the reviewer looking at an image that was never a problem. The last result is
 * the one Playwright itself judges the test by, so that is the one used here. A skipped
 * test is not a failure either.
 */
const isFailedTest = (test) => {
    const results = test.results ?? [];

    if (results.length === 0) {
        return false;
    }

    return results[results.length - 1].status === 'failed';
};

/**
 * The component layer: every failing spec in Playwright's JSON report, or `null` when
 * the reporter never wrote one.
 */
const collectComponentsFailures = () => {
    const report = readReport();

    if (!report) {
        return null;
    }

    // Every root suite, not just the first. Playwright's JSON report keeps one root suite
    // per test file, so reading `suites[0]` would report on the first file and silently
    // drop failures from every other one — and then claim the run was clean.
    const specs = (report.suites ?? []).flatMap((suite) => collectSpecs(suite));

    return specs
        .map((spec) => {
            const tests = spec.tests ?? [];
            const failedTests = tests.filter(isFailedTest);

            if (failedTests.length === 0) {
                return null;
            }

            // Only the attempts that actually failed carry the comparison images; a
            // passing retry attaches nothing useful.
            const attachments = failedTests.flatMap((test) =>
                (test.results ?? [])
                    .filter((result) => result.status === 'failed')
                    .flatMap((result) => result.attachments ?? [])
            );
            const expected = describeAttachment(attachments, 'expected');

            return {
                // Sanitised here rather than at each use, so no future line can print it
                // raw.
                title: plain(spec.title),
                file: plain(spec.file),
                stem: plain(expected ? expected.replace(/-expected\.\w+$/, '') : spec.title),
                expected: describeAttachment(attachments, 'expected'),
                actual: describeAttachment(attachments, 'actual'),
                diff: describeAttachment(attachments, 'diff'),
            };
        })
        .filter(Boolean);
};

/**
 * The e2e layer: one entry per snapshot `@wdio/visual-service` found different.
 *
 * The service writes only what it compared — `diff/<name>.png` on a mismatch, with
 * `actual/<name>.png` beside it — while the baseline of the same name is already
 * committed under `--baseline-dir`. All three files therefore carry one name, so the
 * workflow's gather step renames them with the same `-expected` / `-actual` / `-diff`
 * suffix the component layer's attachments use. The names below are those published
 * ones, not the paths on disk.
 */
const collectE2eFailures = () => {
    const diffDir = values['diff-dir'];
    const baselineDir = values['baseline-dir'];
    const actualDir = values['actual-dir'];

    if (!diffDir || !baselineDir || !actualDir) {
        console.error('--layer e2e needs --diff-dir, --baseline-dir and --actual-dir');
        process.exit(1);
    }

    // A missing directory is the clean run: the service creates it only when it has
    // something to put there.
    if (!existsSync(diffDir)) {
        return [];
    }

    return readdirSync(diffDir)
        .filter((name) => /\.png$/i.test(name))
        .sort()
        .map((name) => {
            const stem = plain(name.replace(/\.png$/i, ''));
            const published = (suffix) => plain(`${stem}-${suffix}.png`);

            return {
                title: stem,
                file: plain(diffDir),
                stem,
                // A missing file is reported as missing, exactly as a missing attachment
                // is: a baseline that was never committed, or an actual image the
                // comparison never produced, must not be dressed up as one.
                expected: existsSync(path.join(baselineDir, name)) ? published('expected') : null,
                actual: existsSync(path.join(actualDir, name)) ? published('actual') : null,
                diff: existsSync(path.join(diffDir, name)) ? published('diff') : null,
            };
        });
};

const failures = layerName === 'components' ? collectComponentsFailures() : collectE2eFailures();

if (failures === null) {
    // A crash before the reporter ran leaves no report; say so instead of
    // claiming there were no visual differences.
    emit(
        [
            `### ${layer.heading}`,
            '',
            `No JSON report was written to \`${reportPath}\`, so this run failed before or`,
            'outside the visual comparison. Check the job log.',
            '',
        ].join('\n')
    );

    process.exit(0);
}

const lines = [`### ${layer.heading}`, ''];

if (failures.length === 0) {
    // The e2e layer writes a diff image only when something differs, so an empty
    // directory is the clean run — unless the suite itself failed, in which case the
    // comparison may never have run and "everything matched" would be a claim the data
    // does not support.
    if (layerName === 'e2e' && process.env.VISUAL_TESTS_OUTCOME === 'failure') {
        lines.push(
            'The suite failed without writing a diff image, so no comparison reached this',
            'report. Check the job log for the step that failed.',
            ''
        );
    } else {
        lines.push(`Every ${layer.noun} baseline matched.`, '');
    }
} else {
    lines.push(
        `${failures.length} baseline${failures.length === 1 ? '' : 's'} differ${failures.length === 1 ? 's' : ''} from the committed images.`,
        ''
    );

    const embedded = Object.keys(evidenceUrls).length > 0;

    if (embedded) {
        // The images are embedded so the reviewer can judge the change without leaving
        // the conversation. `expected` is what is committed, `actual` is this run, and
        // `diff` marks the pixels that moved.
        for (const failure of failures) {
            const stem = failure.stem ?? failure.title;
            // Attachment names are file names from `test-results/`, so they cannot carry
            // markdown, but they are encoded anyway: the value ends up inside a URL.
            const url = (name) => (name ? evidenceUrls[name] : null);

            // One level under the layer's heading, so both sections keep the same
            // outline once they share a comment.
            lines.push(`#### \`${stem}\``, '');

            const cells = [
                ['Expected', failure.expected],
                ['Actual', failure.actual],
                ['Diff', failure.diff],
            ].filter(([, name]) => url(name));

            if (cells.length === 0) {
                lines.push(
                    'No images were produced for this snapshot, so there is nothing to show.',
                    ''
                );
                continue;
            }

            lines.push(`| ${cells.map(([label]) => label).join(' | ')} |`);
            lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
            lines.push(
                `| ${cells.map(([label, name]) => `![${label}](${url(name)})`).join(' | ')} |`,
                ''
            );
        }
    } else {
        // Uploading is unavailable (a fork pull request) or produced nothing. Naming the
        // files is still better than saying only "some pixels differ".
        if (runUrl) {
            lines.push(
                `[Open the \`${layer.artifact}\` artifact](${runUrl}#artifacts) to see`,
                'the images themselves.',
                ''
            );
        } else {
            lines.push(
                `Open the \`${layer.artifact}\` artifact from this run to see the images`,
                'themselves.',
                ''
            );
        }

        lines.push('| Snapshot | Expected | Actual | Diff |', '| --- | --- | --- | --- |');

        for (const failure of failures) {
            // `stem` and the attachment names are already sanitised; the em dash marks a
            // file the comparison never produced.
            lines.push(
                `| \`${failure.stem}\` | ${failure.expected ?? '—'} | ${failure.actual ?? '—'} | ${failure.diff ?? '—'} |`
            );
        }

        lines.push('');
    }

    // A row with no actual or diff means the comparison never produced pixels: the
    // baseline did not decode, or the screen never rendered. That is a different problem
    // from "the design changed", and saying so saves a confusing round trip.
    const withoutPixels = failures.filter((failure) => !failure.actual);

    if (withoutPixels.length > 0) {
        lines.push(
            `> ${withoutPixels.length} of these never produced a pixel comparison, so there is`,
            '> nothing to compare — the baseline file or the screen itself is broken rather',
            '> than the design having changed. Check the job log for the decode or render',
            '> error.',
            ''
        );
    }
}

// Only the component section carries the hint: the comment holds both layers, and the
// same instructions twice is what makes a report unreadable.
if (layerName === 'components') {
    // The hint is unconditional: a green run needs it too, because the next reader may be
    // looking at why a previous run was refreshed.
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
}

emit(lines.join('\n'));
