import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
    appendStepSummary,
    formatFrontendCoverage,
    formatRustCoverage,
    resolveRustCoverageCandidates,
    resolveRustCoverageReport,
    summarizeCoverageFile,
} from '../../scripts/ci/coverage/summarize-coverage.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(testDirectory, '../..');
const summarizerPath = resolve(testDirectory, '../../scripts/ci/coverage/summarize-coverage.mjs');
const workflowPath = resolve(testDirectory, '../../../../.github/workflows/ci.yml');

const temporaryDirectories: string[] = [];

async function createWorkspace() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-coverage-summary-'));
    temporaryDirectories.push(root);

    return {
        root,
        summaryPath: join(root, 'step-summary.md'),
        frontendPath: join(root, 'coverage-summary.json'),
        rustPath: join(root, 'coverage.json'),
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
    );
});

const frontendSummary = {
    total: {
        lines: { total: 1000, covered: 723, skipped: 0, pct: 72.3333 },
        statements: { total: 2000, covered: 1420, skipped: 0, pct: 71 },
        functions: { total: 400, covered: 277, skipped: 0, pct: 69.256 },
        branches: { total: 800, covered: 488, skipped: 0, pct: 61 },
    },
};

type Counts = [covered: number, total: number];

function llvmCovTotals({
    lines,
    regions,
    branches,
}: {
    lines: Counts;
    regions: Counts;
    branches?: Counts;
}) {
    const metric = ([covered, count]: Counts) => ({
        count,
        covered,
        percent: count > 0 ? (covered / count) * 100 : 0,
    });

    return {
        lines: metric(lines),
        regions: metric(regions),
        ...(branches ? { branches: metric(branches) } : {}),
        functions: metric([4, 8]),
    };
}

const llvmCovReport = JSON.stringify({
    data: [{ totals: llvmCovTotals({ lines: [13, 16], regions: [15, 20] }) }],
});

const llvmCovReportWithBranches = JSON.stringify({
    data: [{ totals: llvmCovTotals({ lines: [13, 16], regions: [15, 20], branches: [3, 4] }) }],
});

describe('user reads the frontend coverage table in the job summary', () => {
    it('user sees the frontend coverage percentages when the summary file is present', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.frontendPath, JSON.stringify(frontendSummary), 'utf8');

        const markdown = summarizeCoverageFile({
            kind: 'frontend',
            inputPath: workspace.frontendPath,
            summaryPath: workspace.summaryPath,
        });

        expect(markdown).toContain('## Frontend Coverage');
        expect(markdown).toContain('| Lines | 72.33% |');
        expect(markdown).toContain('| Statements | 71.00% |');
        expect(markdown).toContain('| Functions | 69.26% |');
        expect(markdown).toContain('| Branches | 61.00% |');
        expect(await readFile(workspace.summaryPath, 'utf8')).toContain('| Lines | 72.33% |');
    });

    it('user keeps the earlier summary content when the coverage table is appended', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.frontendPath, JSON.stringify(frontendSummary), 'utf8');
        await writeFile(workspace.summaryPath, '# Earlier report\n\nKept text.', 'utf8');

        summarizeCoverageFile({
            kind: 'frontend',
            inputPath: workspace.frontendPath,
            summaryPath: workspace.summaryPath,
        });
        summarizeCoverageFile({
            kind: 'frontend',
            inputPath: workspace.frontendPath,
            summaryPath: workspace.summaryPath,
        });

        const summary = await readFile(workspace.summaryPath, 'utf8');
        expect(summary.startsWith('# Earlier report\n\nKept text.\n')).toBe(true);
        expect(summary.match(/## Frontend Coverage/g)).toHaveLength(2);
    });

    it('user gets a clear failure when the frontend summary file is missing', async () => {
        const workspace = await createWorkspace();

        expect(() =>
            summarizeCoverageFile({
                kind: 'frontend',
                inputPath: workspace.frontendPath,
                summaryPath: workspace.summaryPath,
            })
        ).toThrow(`Missing frontend coverage summary: ${workspace.frontendPath}`);
    });

    it('user gets a clear failure when the frontend summary is not valid JSON', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.frontendPath, 'not json at all', 'utf8');

        expect(() =>
            summarizeCoverageFile({
                kind: 'frontend',
                inputPath: workspace.frontendPath,
                summaryPath: workspace.summaryPath,
            })
        ).toThrow(/Cannot parse frontend coverage summary/);
    });

    it('user gets a clear failure when the frontend summary has no metric totals', () => {
        expect(() => formatFrontendCoverage({ total: { lines: { pct: 12 } } })).toThrow(
            'Frontend coverage summary is missing a numeric total.statements.pct.'
        );
    });

    it('user gets a clear failure when the step summary path is not configured', () => {
        expect(() => appendStepSummary('', '## Frontend Coverage')).toThrow();
    });
});

describe('user reads the Rust coverage table in the job summary', () => {
    it('user sees line and region coverage when the run reports no branches', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.rustPath, llvmCovReport, 'utf8');

        const markdown = summarizeCoverageFile({
            kind: 'rust',
            inputPath: workspace.rustPath,
            summaryPath: workspace.summaryPath,
        });

        expect(markdown).toContain('## Rust Coverage');
        expect(markdown).toContain('| Lines | 81.25% | 13 | 16 |');
        expect(markdown).toContain('| Regions | 75.00% | 15 | 20 |');
        expect(markdown).not.toContain('| Branches |');
        expect(await readFile(workspace.summaryPath, 'utf8')).toContain('| Lines | 81.25% |');
    });

    it('user is told branch coverage needs a nightly toolchain rather than shown a zero', () => {
        const markdown = formatRustCoverage(llvmCovReport);

        expect(markdown).toContain('requires a nightly toolchain');
        expect(markdown).not.toContain('| Branches | 0.00% |');
    });

    it('user sees a branch percentage when the nightly run reports branch totals', () => {
        const markdown = formatRustCoverage(llvmCovReportWithBranches);

        expect(markdown).toContain('| Branches | 75.00% | 3 | 4 |');
        expect(markdown).not.toContain('requires a nightly toolchain');
    });

    it('user sees summed totals when the run covers more than one crate target', () => {
        const markdown = formatRustCoverage(
            JSON.stringify({
                data: [
                    { totals: llvmCovTotals({ lines: [5, 10], regions: [5, 10] }) },
                    { totals: llvmCovTotals({ lines: [5, 10], regions: [5, 10] }) },
                ],
            })
        );

        expect(markdown).toContain('| Lines | 50.00% | 10 | 20 |');
        expect(markdown).toContain('| Regions | 50.00% | 10 | 20 |');
    });

    it('user gets a clear failure when the coverage file is missing', async () => {
        const workspace = await createWorkspace();

        expect(() =>
            summarizeCoverageFile({
                kind: 'rust',
                inputPath: workspace.rustPath,
                summaryPath: workspace.summaryPath,
            })
        ).toThrow(`Missing rust coverage report: ${workspace.rustPath}`);
    });

    it('user gets a clear failure when the coverage file is not JSON', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.rustPath, '<html><body>not a report</body></html>', 'utf8');

        expect(() =>
            summarizeCoverageFile({
                kind: 'rust',
                inputPath: workspace.rustPath,
                summaryPath: workspace.summaryPath,
            })
        ).toThrow('Cannot parse Rust coverage report');
    });

    it('user gets a clear failure when the report has no data entries', () => {
        expect(() => formatRustCoverage(JSON.stringify({ data: [] }))).toThrow(
            'Rust coverage report has no "data" entries.'
        );
    });

    it('user gets a clear failure when the report has no line totals', () => {
        expect(() =>
            formatRustCoverage(JSON.stringify({ data: [{ totals: { regions: { percent: 1 } } }] }))
        ).toThrow('Rust coverage report is missing totals.lines.');
    });
});

describe('user finds the Rust coverage report', () => {
    it('user sees the Rust report found when it sits beside the manifest', async () => {
        const workspace = await createWorkspace();
        const besideManifest = join(workspace.root, 'src-tauri', 'coverage.json');
        await mkdir(dirname(besideManifest), { recursive: true });
        await writeFile(besideManifest, llvmCovReport, 'utf8');

        expect(resolveRustCoverageReport(resolveRustCoverageCandidates(workspace.root))).toBe(
            besideManifest
        );
    });

    it('user sees the Rust report found when it sits in the working directory', async () => {
        const workspace = await createWorkspace();
        const inWorkingDirectory = join(workspace.root, 'coverage.json');
        await writeFile(inWorkingDirectory, llvmCovReport, 'utf8');

        expect(resolveRustCoverageReport(resolveRustCoverageCandidates(workspace.root))).toBe(
            inWorkingDirectory
        );
    });

    it('user gets a clear failure naming every candidate path when no report was produced', async () => {
        const workspace = await createWorkspace();
        const candidates = resolveRustCoverageCandidates(workspace.root);

        let message = '';
        try {
            resolveRustCoverageReport(candidates);
        } catch (error) {
            message = (error as Error).message;
        }

        expect(message).toContain('No Rust coverage report found.');
        expect(message).toContain('Looked in:');
        for (const candidate of candidates) {
            expect(message).toContain(candidate);
        }
    });

    it('user sees the default candidates point at the desktop app the coverage script runs from', () => {
        const candidates = resolveRustCoverageCandidates();

        expect(candidates).toEqual([
            join(desktopRoot, 'src-tauri', 'coverage.json'),
            join(desktopRoot, 'coverage.json'),
        ]);
    });

    it('user sees the report path printed when resolving from the command line', async () => {
        const workspace = await createWorkspace();
        const reportPath = join(workspace.root, 'coverage.json');
        await writeFile(reportPath, llvmCovReport, 'utf8');

        const resolved = execFileSync(process.execPath, [summarizerPath, '--resolve-rust'], {
            encoding: 'utf8',
            env: { ...process.env, TOUCHAI_COVERAGE_ROOT: workspace.root },
        }).trim();

        expect(resolved).toBe(reportPath);
    });

    it('user gets a non-zero exit naming both candidates when resolving finds no report', async () => {
        const workspace = await createWorkspace();

        let failure: { status?: number; stderr?: string } | null = null;
        try {
            execFileSync(process.execPath, [summarizerPath, '--resolve-rust'], {
                encoding: 'utf8',
                env: { ...process.env, TOUCHAI_COVERAGE_ROOT: workspace.root },
            });
        } catch (error) {
            failure = error as { status?: number; stderr?: string };
        }

        expect(failure?.status).toBe(1);
        expect(failure?.stderr).toContain(join(workspace.root, 'src-tauri', 'coverage.json'));
        expect(failure?.stderr).toContain(join(workspace.root, 'coverage.json'));
    });
});

describe('user runs the coverage summarizer from the command line', () => {
    it('user sees the coverage table appended when the report exists', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.frontendPath, JSON.stringify(frontendSummary), 'utf8');

        execFileSync(
            process.execPath,
            [
                summarizerPath,
                '--kind',
                'frontend',
                '--input',
                workspace.frontendPath,
                '--summary',
                workspace.summaryPath,
            ],
            { encoding: 'utf8' }
        );

        expect(await readFile(workspace.summaryPath, 'utf8')).toContain('| Lines | 72.33% |');
    });

    it('user gets a non-zero exit and a clear message when the report is missing', async () => {
        const workspace = await createWorkspace();

        let failure: { status?: number; stderr?: string } | null = null;
        try {
            execFileSync(
                process.execPath,
                [
                    summarizerPath,
                    '--kind',
                    'rust',
                    '--input',
                    workspace.rustPath,
                    '--summary',
                    workspace.summaryPath,
                ],
                { encoding: 'utf8' }
            );
        } catch (error) {
            failure = error as { status?: number; stderr?: string };
        }

        expect(failure?.status).toBe(1);
        expect(failure?.stderr).toContain(`Missing rust coverage report: ${workspace.rustPath}`);
    });
});

describe('user opens the CI gate for a desktop change', () => {
    it('user sees the coverage summary script run instead of an inline node program', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).not.toContain('node -e "');
        expect(workflow).toContain(
            'node apps/desktop/scripts/ci/coverage/summarize-coverage.mjs --kind frontend --input apps/desktop/.coverage/unit/coverage-summary.json'
        );
        expect(workflow).toContain(
            'node apps/desktop/scripts/ci/coverage/summarize-coverage.mjs --kind rust --input "$RUST_COVERAGE_REPORT"'
        );
    });

    it('user sees a failed Rust coverage run block the merge when the desktop app changes', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain('    rust-coverage:');
        expect(workflow).toContain('name: rust-coverage-report');
        expect(workflow).toContain('path: ${{ env.RUST_COVERAGE_REPORT }}');
        expect(workflow).toContain('taiki-e/install-action');
        expect(workflow).toContain('llvm-tools-preview');
        expect(workflow).toContain("RUST_COVERAGE_RESULT: ${{ needs['rust-coverage'].result }}");
        expect(workflow).toContain('required+=("rust-coverage:$RUST_COVERAGE_RESULT")');
        expect(workflow).toContain('"rust-coverage:$RUST_COVERAGE_RESULT"');
    });

    it('user is told which paths were searched when the coverage run produced no report', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain(
            'node apps/desktop/scripts/ci/coverage/summarize-coverage.mjs --resolve-rust'
        );
        expect(workflow).toContain('RUST_COVERAGE_REPORT=$report_path');
        expect(workflow).toContain('cargo-llvm-cov produced no coverage.json');
    });
});
