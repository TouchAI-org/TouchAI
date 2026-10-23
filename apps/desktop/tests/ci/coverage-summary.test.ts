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
        rustPath: join(root, 'cobertura.xml'),
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

const coberturaXml = [
    '<?xml version="1.0"?>',
    '<coverage lines-covered="13" lines-valid="16" line-rate="0.8125" branches-covered="0" branches-valid="0" branch-rate="0" complexity="0" version="1.9" timestamp="0">',
    '  <sources><source>/repo/apps/desktop/src-tauri/src</source></sources>',
    '  <packages><package name="src" line-rate="0.5" branch-rate="0" complexity="0"><classes><class name="lib" filename="src/lib.rs" line-rate="0.25" branch-rate="0" complexity="0"><methods /><lines><line number="1" hits="3" /></lines></class></classes></package></packages>',
    '</coverage>',
].join('\n');

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
    it('user sees the line and branch rates converted to percentages', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.rustPath, coberturaXml, 'utf8');

        const markdown = summarizeCoverageFile({
            kind: 'rust',
            inputPath: workspace.rustPath,
            summaryPath: workspace.summaryPath,
        });

        expect(markdown).toContain('## Rust Coverage');
        expect(markdown).toContain('| Lines | 81.25% | 13 | 16 |');
        expect(markdown).toContain('| Branches | 0.00% | 0 | 0 |');
        expect(markdown).not.toContain('25.00%');
        expect(await readFile(workspace.summaryPath, 'utf8')).toContain('| Lines | 81.25% |');
    });

    it('user is told the branch rate is unavailable when tarpaulin reports no branches', () => {
        expect(formatRustCoverage(coberturaXml)).toContain('zero branch totals');
    });

    it('user sees the rate percentages when the report omits the covered and total counts', () => {
        const markdown = formatRustCoverage(
            '<coverage line-rate="0.5" branch-rate="0.125"></coverage>'
        );

        expect(markdown).toContain('| Lines | 50.00% |');
        expect(markdown).toContain('| Branches | 12.50% |');
        expect(markdown).not.toContain('Covered');
    });

    it('user gets a clear failure when the cobertura file is missing', async () => {
        const workspace = await createWorkspace();

        expect(() =>
            summarizeCoverageFile({
                kind: 'rust',
                inputPath: workspace.rustPath,
                summaryPath: workspace.summaryPath,
            })
        ).toThrow(`Missing rust coverage report: ${workspace.rustPath}`);
    });

    it('user gets a clear failure when the cobertura file has no coverage element', async () => {
        const workspace = await createWorkspace();
        await writeFile(workspace.rustPath, '<html><body>not a report</body></html>', 'utf8');

        expect(() =>
            summarizeCoverageFile({
                kind: 'rust',
                inputPath: workspace.rustPath,
                summaryPath: workspace.summaryPath,
            })
        ).toThrow('Rust coverage report is missing the <coverage> root element.');
    });

    it('user gets a clear failure when the coverage element has no line rate', () => {
        expect(() => formatRustCoverage('<coverage branch-rate="0"></coverage>')).toThrow(
            'Rust coverage report is missing the line-rate attribute on the <coverage> element.'
        );
    });
});

describe('user finds the Rust report wherever tarpaulin wrote it', () => {
    it('user sees the Rust report found when tarpaulin writes it beside the manifest', async () => {
        const workspace = await createWorkspace();
        const besideManifest = join(workspace.root, 'src-tauri', 'cobertura.xml');
        await mkdir(dirname(besideManifest), { recursive: true });
        await writeFile(besideManifest, coberturaXml, 'utf8');

        expect(resolveRustCoverageReport(resolveRustCoverageCandidates(workspace.root))).toBe(
            besideManifest
        );
    });

    it('user sees the Rust report found when tarpaulin writes it in the working directory', async () => {
        const workspace = await createWorkspace();
        const inWorkingDirectory = join(workspace.root, 'cobertura.xml');
        await writeFile(inWorkingDirectory, coberturaXml, 'utf8');

        expect(resolveRustCoverageReport(resolveRustCoverageCandidates(workspace.root))).toBe(
            inWorkingDirectory
        );
    });

    it('user gets a clear failure naming both candidate paths when tarpaulin produced no report', async () => {
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
            join(desktopRoot, 'src-tauri', 'cobertura.xml'),
            join(desktopRoot, 'cobertura.xml'),
        ]);
    });

    it('user sees the report path printed when resolving from the command line', async () => {
        const workspace = await createWorkspace();
        const reportPath = join(workspace.root, 'cobertura.xml');
        await writeFile(reportPath, coberturaXml, 'utf8');

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
        expect(failure?.stderr).toContain(join(workspace.root, 'src-tauri', 'cobertura.xml'));
        expect(failure?.stderr).toContain(join(workspace.root, 'cobertura.xml'));
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
            'node apps/desktop/scripts/ci/coverage/summarize-coverage.mjs --kind rust --input "$RUST_COVERAGE_XML"'
        );
    });

    it('user sees a failed Rust coverage run block the merge when the desktop app changes', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain('    rust-coverage:');
        expect(workflow).toContain('name: rust-coverage-report');
        expect(workflow).toContain('path: ${{ env.RUST_COVERAGE_XML }}');
        expect(workflow).toContain("RUST_COVERAGE_RESULT: ${{ needs['rust-coverage'].result }}");
        expect(workflow).toContain('required+=("rust-coverage:$RUST_COVERAGE_RESULT")');
        expect(workflow).toContain('"rust-coverage:$RUST_COVERAGE_RESULT"');
    });

    it('user is told which paths were searched when tarpaulin produced no report in CI', async () => {
        const workflow = await readFile(workflowPath, 'utf8');

        expect(workflow).toContain(
            'node apps/desktop/scripts/ci/coverage/summarize-coverage.mjs --resolve-rust'
        );
        expect(workflow).toContain('RUST_COVERAGE_XML=$report_path');
        expect(workflow).toContain('cargo-tarpaulin produced no cobertura.xml');
    });
});
