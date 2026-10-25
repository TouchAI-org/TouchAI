import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
    checkRustCoverageFloors,
    parseLlvmCovCoverage,
    raisedRustCoverageFloors,
    summarizeCoverageFile,
} from '../../scripts/ci/coverage/summarize-coverage.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const summarizerPath = resolve(testDirectory, '../../scripts/ci/coverage/summarize-coverage.mjs');
const floorsPath = resolve(testDirectory, '../../src-tauri/coverage-floors.json');

function llvmCovReport(linesPercent: number, regionsPercent: number) {
    const metric = (percent: number) => ({ count: 100, covered: percent, percent });

    return JSON.stringify({
        data: [{ totals: { lines: metric(linesPercent), regions: metric(regionsPercent) } }],
    });
}

const originalFloors = await readFile(floorsPath, 'utf8');
const temporaryDirectories: string[] = [];

async function createWorkspace() {
    const root = await mkdtemp(join(tmpdir(), 'touchai-coverage-floors-'));
    temporaryDirectories.push(root);

    return {
        reportPath: join(root, 'coverage.json'),
        summaryPath: join(root, 'step-summary.md'),
    };
}

function runSummarizer(args: string[]) {
    try {
        execFileSync(process.execPath, [summarizerPath, ...args], { encoding: 'utf8' });
        return { status: 0, stderr: '' };
    } catch (error) {
        const failure = error as { status?: number; stderr?: string };
        return { status: failure.status ?? -1, stderr: failure.stderr ?? '' };
    }
}

afterEach(async () => {
    await writeFile(floorsPath, originalFloors, 'utf8');
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
    );
});

describe('user is blocked when Rust coverage drops below the committed floor', () => {
    it('user is told which metric regressed and by how much', () => {
        const coverage = parseLlvmCovCoverage(llvmCovReport(40, 30));

        const failures = checkRustCoverageFloors(coverage, { lines: 44, regions: 43 });

        expect(failures).toHaveLength(2);
        expect(failures[0]).toContain('lines: 40.00% is below the committed floor of 44%');
        expect(failures[1]).toContain('regions: 30.00% is below the committed floor of 43%');
    });

    it('user passes when both metrics meet the floor', () => {
        const coverage = parseLlvmCovCoverage(llvmCovReport(45.5, 44.17));

        expect(checkRustCoverageFloors(coverage, { lines: 44, regions: 43 })).toEqual([]);
    });

    it('user passes a metric exactly at the floor rather than failing on the boundary', () => {
        const coverage = parseLlvmCovCoverage(llvmCovReport(44, 43));

        expect(checkRustCoverageFloors(coverage, { lines: 44, regions: 43 })).toEqual([]);
    });

    it('user gets a loud failure when the floor file lost a metric', () => {
        const coverage = parseLlvmCovCoverage(llvmCovReport(45, 44));

        expect(() => checkRustCoverageFloors(coverage, { lines: 44 })).toThrow(
            'Rust coverage floor is missing a numeric "regions" entry.'
        );
    });

    it('user sees the CI run fail with a readable message when coverage regresses', async () => {
        await writeFile(
            floorsPath,
            `${JSON.stringify({ lines: 99, regions: 99 }, null, 4)}\n`,
            'utf8'
        );

        const workspace = await createWorkspace();
        await writeFile(workspace.reportPath, llvmCovReport(45.5, 44.17), 'utf8');

        const result = runSummarizer([
            '--kind',
            'rust',
            '--input',
            workspace.reportPath,
            '--summary',
            workspace.summaryPath,
        ]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Rust coverage dropped below the committed floor');
        expect(result.stderr).toContain('lines: 45.50% is below the committed floor of 99%');
    });
});

describe('user sees the Rust coverage floor ratchet upward only', () => {
    it('user keeps the floor when the measured coverage is lower', () => {
        const coverage = parseLlvmCovCoverage(llvmCovReport(30, 20));

        expect(raisedRustCoverageFloors(coverage, { lines: 44, regions: 43 })).toEqual({
            lines: 44,
            regions: 43,
        });
    });

    it('user sees the floor raised to just under the measured coverage', () => {
        const coverage = parseLlvmCovCoverage(llvmCovReport(60.9, 58.2));

        expect(raisedRustCoverageFloors(coverage, { lines: 44, regions: 43 })).toEqual({
            lines: 59,
            regions: 57,
        });
    });

    it('user sees the raised floor written back only through the raise flag', async () => {
        // Start from a known floor so the expected result does not depend on the committed one.
        await writeFile(
            floorsPath,
            `${JSON.stringify({ lines: 40, regions: 40 }, null, 4)}\n`,
            'utf8'
        );
        const workspace = await createWorkspace();
        await writeFile(workspace.reportPath, llvmCovReport(60.9, 58.2), 'utf8');

        runSummarizer([
            '--kind',
            'rust',
            '--input',
            workspace.reportPath,
            '--summary',
            workspace.summaryPath,
            '--raise',
        ]);

        expect(JSON.parse(await readFile(floorsPath, 'utf8'))).toEqual({
            lines: 59,
            regions: 57,
        });
    });

    it('user keeps the committed floor when the run does not ask to raise it', async () => {
        const committed = JSON.parse(await readFile(floorsPath, 'utf8'));

        const workspace = await createWorkspace();
        await writeFile(workspace.reportPath, llvmCovReport(60.9, 58.2), 'utf8');

        summarizeCoverageFile({
            kind: 'rust',
            inputPath: workspace.reportPath,
            summaryPath: workspace.summaryPath,
        });

        // Compared against the committed value rather than a literal, so raising the floor
        // in a later PR does not fail this test for the wrong reason.
        expect(JSON.parse(await readFile(floorsPath, 'utf8'))).toEqual(committed);
    });
});
