import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The report is posted as a pull request comment by a bot with write access, so its
 * content has to be safe even when a test title is hostile. Playwright serialises
 * `spec.title` verbatim from the test file, and adding a file under `tests/visual/` is
 * also what triggers the workflow — so the title is attacker-controlled by the PR
 * author. These tests run the real script and read what it would post.
 */
const SCRIPT = path.join(__dirname, '../../scripts/ci/visual-report.mjs');

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'visual-report-'));

/**
 * Runs the script the way the workflow does and returns the section it wrote. The
 * script is an ES module entry point, so it is run as a child process rather than
 * imported: importing would execute its top-level code in this file's scope.
 */
const runScript = (
    directory: string,
    args: string[],
    evidence?: Record<string, string>,
    extraEnv: Record<string, string> = {}
): string => {
    const outputPath = path.join(directory, 'summary.md');

    const env: Record<string, string> = {
        ...process.env,
        VISUAL_SUMMARY_OUTPUT: outputPath,
        VISUAL_EVIDENCE_URLS: '',
        GITHUB_STEP_SUMMARY: '',
        RUN_URL: 'https://example.test/run',
        ...extraEnv,
    } as Record<string, string>;

    if (evidence) {
        const evidencePath = path.join(directory, 'evidence.json');
        writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
        env.VISUAL_EVIDENCE_URLS = evidencePath;
    }

    execFileSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });

    return existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
};

interface ComponentRunOptions {
    report: unknown;
    evidence?: Record<string, string>;
}

const runComponentReport = ({ report, evidence }: ComponentRunOptions): string => {
    const directory = tempDir();
    const reportPath = path.join(directory, 'results.json');
    writeFileSync(reportPath, JSON.stringify(report), 'utf8');

    return runScript(directory, ['--layer', 'components', '--report', reportPath], evidence);
};

interface E2eRunOptions {
    /** Snapshot names the service found different, without the extension. */
    diffs: string[];
    /** Snapshot names that have a committed baseline. Defaults to `diffs`. */
    baselines?: string[];
    /** Snapshot names with an actual image on disk. Defaults to `diffs`. */
    actuals?: string[];
    evidence?: Record<string, string>;
    /** The outcome the workflow reports for the test step. */
    outcome?: string;
}

/**
 * Builds the three directories the e2e layer reads — what the service wrote under
 * `.e2e-runtime/visual` and what is committed under `__snapshots__` — and runs the
 * report against them.
 */
const runE2eReport = ({
    diffs,
    baselines = diffs,
    actuals = diffs,
    evidence,
    outcome = 'success',
}: E2eRunOptions) => {
    const directory = tempDir();
    const diffDir = path.join(directory, 'diff');
    const baselineDir = path.join(directory, 'baseline');
    const actualDir = path.join(directory, 'actual');

    for (const dir of [diffDir, baselineDir, actualDir]) {
        mkdirSync(dir, { recursive: true });
    }

    for (const name of diffs) {
        writeFileSync(path.join(diffDir, `${name}.png`), '');
    }

    for (const name of baselines) {
        writeFileSync(path.join(baselineDir, `${name}.png`), '');
    }

    for (const name of actuals) {
        writeFileSync(path.join(actualDir, `${name}.png`), '');
    }

    return runScript(
        directory,
        [
            '--layer',
            'e2e',
            '--diff-dir',
            diffDir,
            '--baseline-dir',
            baselineDir,
            '--actual-dir',
            actualDir,
        ],
        evidence,
        { VISUAL_TESTS_OUTCOME: outcome }
    );
};

const failedSpec = (title: string, snapshot = 'primitives-button--variants') => ({
    title,
    file: 'tests/visual/primitives.visual.ts',
    tests: [
        {
            results: [
                {
                    status: 'failed',
                    attachments: [
                        {
                            name: `${snapshot}-expected.png`,
                            path: `/tmp/${snapshot}-expected.png`,
                        },
                        { name: `${snapshot}-actual.png`, path: `/tmp/${snapshot}-actual.png` },
                        { name: `${snapshot}-diff.png`, path: `/tmp/${snapshot}-diff.png` },
                    ],
                },
            ],
        },
    ],
});

describe('user reads a visual report that cannot be spoofed', () => {
    it('user never sees a heading or link injected through a test title', () => {
        const hostile = [
            'user sees x',
            '',
            '## All checks passed',
            '',
            '[Approve this baseline](https://evil.example/approve)',
        ].join('\n');

        // Two paths print a failure: with published images the snapshot stem is the
        // heading, without them the stem is a table cell. The hostile title reaches the
        // report on both, and neither may carry its structure through.
        const withImages = runComponentReport({
            report: { suites: [{ specs: [failedSpec(hostile)] }] },
            evidence: {
                'primitives-button--variants-expected.png':
                    'https://github.com/user-attachments/assets/aaa',
                'primitives-button--variants-actual.png':
                    'https://github.com/user-attachments/assets/bbb',
                'primitives-button--variants-diff.png':
                    'https://github.com/user-attachments/assets/ccc',
            },
        });

        const withoutImages = runComponentReport({
            report: { suites: [{ specs: [failedSpec(hostile)] }] },
        });

        for (const markdown of [withImages, withoutImages]) {
            // The injected heading and link must not survive as structure.
            expect(markdown).not.toContain('\n## All checks passed');
            expect(markdown).not.toContain('](https://evil.example/approve)');
            // No stray block markers that would let a title open one of its own.
            expect(markdown).not.toContain('<summary>All checks passed');
        }

        // When there is no attachment the snapshot stem names the row, and a hostile
        // title must not replace it: the reviewer needs the file name, not the author's
        // prose.
        expect(withoutImages).toContain('primitives-button--variants');
    });

    it('user never sees a table cell broken by a pipe in a test title', () => {
        const markdown = runComponentReport({
            report: { suites: [{ specs: [failedSpec('user sees a | b | c')] }] },
        });

        // Every table row must keep the declared column count.
        const tableRows = markdown
            .split('\n')
            .filter((line) => line.startsWith('|') && !line.startsWith('| ---'));

        for (const row of tableRows) {
            expect(row.split('|').length - 2).toBeLessThanOrEqual(4);
        }
    });

    it('user sees a green run when a retry passed after a failure', () => {
        // CI runs with `retries: 1`. A test whose first attempt failed and whose retry
        // passed is green, and reporting it as a differing baseline would send the
        // reviewer to look at an image that was never a problem.
        const report = {
            suites: [
                {
                    specs: [
                        {
                            title: 'user sees a flaky baseline',
                            file: 'tests/visual/primitives.visual.ts',
                            tests: [
                                {
                                    results: [
                                        {
                                            status: 'failed',
                                            attachments: [
                                                {
                                                    name: 'primitives-button--variants-expected.png',
                                                    path: '/tmp/expected.png',
                                                },
                                            ],
                                        },
                                        { status: 'passed', attachments: [] },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        };

        const markdown = runComponentReport({ report });

        expect(markdown).toContain('Every component baseline matched');
        // The closing hint mentions the word "different" in prose, so the assertion is
        // on the count line rather than on the substring.
        expect(markdown).not.toContain('baseline differs');
        expect(markdown).not.toContain('baselines differ');
    });

    it('user sees a skipped test reported as a match, not a difference', () => {
        const report = {
            suites: [
                {
                    specs: [
                        {
                            title: 'user sees a skipped baseline',
                            file: 'tests/visual/primitives.visual.ts',
                            tests: [{ results: [{ status: 'skipped', attachments: [] }] }],
                        },
                    ],
                },
            ],
        };

        const markdown = runComponentReport({ report });

        expect(markdown).toContain('Every component baseline matched');
    });

    it('user sees failures from every test file, not only the first', () => {
        // Playwright keeps one root suite per test file. Reading `suites[0]` would report
        // the first file's failure and silently drop the second, then claim a clean run.
        const markdown = runComponentReport({
            report: {
                suites: [
                    { specs: [failedSpec('user sees the first file fail', 'first')] },
                    { specs: [failedSpec('user sees the second file fail', 'second')] },
                ],
            },
        });

        expect(markdown).toContain('first');
        expect(markdown).toContain('second');
        expect(markdown).toContain('2 baselines differ');
    });

    it('user sees the published image when an upload succeeded', () => {
        const markdown = runComponentReport({
            report: { suites: [{ specs: [failedSpec('user sees a diff')] }] },
            evidence: {
                'primitives-button--variants-expected.png':
                    'https://github.com/user-attachments/assets/aaa',
                'primitives-button--variants-actual.png':
                    'https://github.com/user-attachments/assets/bbb',
                'primitives-button--variants-diff.png':
                    'https://github.com/user-attachments/assets/ccc',
            },
        });

        expect(markdown).toContain('![Expected](https://github.com/user-attachments/assets/aaa)');
        expect(markdown).toContain('![Actual](https://github.com/user-attachments/assets/bbb)');
        expect(markdown).toContain('![Diff](https://github.com/user-attachments/assets/ccc)');
    });

    it('user sees a link to the artifact when nothing was published', () => {
        const markdown = runComponentReport({
            report: { suites: [{ specs: [failedSpec('user sees a diff')] }] },
        });

        expect(markdown).not.toContain('![');
        expect(markdown).toContain('component-visual-diffs');
        expect(markdown).toContain('/approve-visuals');
    });
});

describe('user reads the app layer in the same comment as the components', () => {
    it('user sees every differing window named and pictured', () => {
        const markdown = runE2eReport({
            diffs: ['main-window-conversation', 'settings-general'],
            evidence: {
                'main-window-conversation-expected.png':
                    'https://github.com/user-attachments/assets/aaa',
                'main-window-conversation-actual.png':
                    'https://github.com/user-attachments/assets/bbb',
                'main-window-conversation-diff.png':
                    'https://github.com/user-attachments/assets/ccc',
                'settings-general-expected.png': 'https://github.com/user-attachments/assets/ddd',
                'settings-general-actual.png': 'https://github.com/user-attachments/assets/eee',
                'settings-general-diff.png': 'https://github.com/user-attachments/assets/fff',
            },
        });

        // A section, not a document: the comment holds two of these under one title.
        expect(markdown.startsWith('### App window\n')).toBe(true);
        expect(markdown).not.toContain('\n## ');

        expect(markdown).toContain('main-window-conversation');
        expect(markdown).toContain('settings-general');
        expect(markdown).toContain('2 baselines differ');

        expect(markdown).toContain('![Expected](https://github.com/user-attachments/assets/aaa)');
        expect(markdown).toContain('![Actual](https://github.com/user-attachments/assets/eee)');
        expect(markdown).toContain('![Diff](https://github.com/user-attachments/assets/fff)');

        // The approval hint belongs to the component section only; printing it twice is
        // what makes a comment unreadable.
        expect(markdown).not.toContain('/approve-visuals');
    });

    it('user sees the app artifact named when the images were not published', () => {
        const markdown = runE2eReport({ diffs: ['main-window-conversation'] });

        expect(markdown).not.toContain('![');
        expect(markdown).toContain('app-visual-diffs');
        expect(markdown).not.toContain('component-visual-diffs');
    });

    it('user sees the window named but not a broken image when the baseline is missing', () => {
        // A snapshot with no committed baseline, or one the comparison never got far
        // enough to render, is a different problem from a design change: the row names
        // the file and says nothing was compared instead of linking an image that does
        // not exist.
        const markdown = runE2eReport({
            diffs: ['settings-general'],
            baselines: [],
            actuals: [],
        });

        expect(markdown).toContain('settings-general');
        expect(markdown).not.toContain('settings-general-expected.png');
        expect(markdown).not.toContain('settings-general-actual.png');
        expect(markdown).toContain('never produced a pixel comparison');
    });

    it('user sees a match when no diff image was written', () => {
        const markdown = runE2eReport({ diffs: [] });

        expect(markdown.startsWith('### App window\n')).toBe(true);
        expect(markdown).toContain('Every app baseline matched');
    });

    it('user is sent to the log when the suite died before comparing anything', () => {
        // An empty diff directory normally means a clean run. When the test step itself
        // failed, the suite may never have reached the comparison, and claiming every
        // baseline matched would hide a real failure behind a green-looking section.
        const markdown = runE2eReport({ diffs: [], outcome: 'failure' });

        expect(markdown).not.toContain('Every app baseline matched');
        expect(markdown).toContain('Check the job log');
    });
});
