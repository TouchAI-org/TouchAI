import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
const SCRIPT = path.join(__dirname, '../../scripts/ci/visual-summary.mjs');

interface RunOptions {
    report: unknown;
    evidence?: Record<string, string>;
}

const runSummary = ({ report, evidence }: RunOptions): string => {
    const directory = mkdtempSync(path.join(tmpdir(), 'visual-summary-'));

    const reportPath = path.join(directory, 'results.json');
    writeFileSync(reportPath, JSON.stringify(report), 'utf8');

    const outputPath = path.join(directory, 'summary.md');

    const env: Record<string, string> = {
        ...process.env,
        VISUAL_SUMMARY_OUTPUT: outputPath,
        VISUAL_EVIDENCE_URLS: '',
        GITHUB_STEP_SUMMARY: '',
        RUN_URL: 'https://example.test/run',
    } as Record<string, string>;

    if (evidence) {
        const evidencePath = path.join(directory, 'evidence.json');
        writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
        env.VISUAL_EVIDENCE_URLS = evidencePath;
    }

    // The script is an ES module entry point, so it is run as a child process rather
    // than imported: importing would execute its top-level code in this file's scope.
    execFileSync(process.execPath, [SCRIPT, reportPath], { env, encoding: 'utf8' });

    return existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
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
        const withImages = runSummary({
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

        const withoutImages = runSummary({
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
        const markdown = runSummary({
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

        const markdown = runSummary({ report });

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

        const markdown = runSummary({ report });

        expect(markdown).toContain('Every component baseline matched');
    });

    it('user sees failures from every test file, not only the first', () => {
        // Playwright keeps one root suite per test file. Reading `suites[0]` would report
        // the first file's failure and silently drop the second, then claim a clean run.
        const markdown = runSummary({
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
        const markdown = runSummary({
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
        const markdown = runSummary({
            report: { suites: [{ specs: [failedSpec('user sees a diff')] }] },
        });

        expect(markdown).not.toContain('![');
        expect(markdown).toContain('component-visual-diffs');
        expect(markdown).toContain('/approve-visuals');
    });
});
