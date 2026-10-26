export type PatchFileCoverage = {
    path: string;
    total: number;
    covered: number;
    percent: number;
};

export type PatchCoverageResult = {
    total: number;
    covered: number;
    percent: number;
    files: PatchFileCoverage[];
};

export type MeasurePatchCoverageOptions = {
    repoRoot?: string;
    ignore?: (path: string) => boolean;
};

export function parseChangedLines(diffText: string): Map<string, Set<number>>;

export function measurePatchCoverage(
    changedLines: Map<string, Set<number>>,
    coverageReport: Record<string, object>,
    options?: MeasurePatchCoverageOptions
): PatchCoverageResult;

export function checkPatchCoverage(result: PatchCoverageResult, floor: number): string[];

export function formatPatchCoverage(result: PatchCoverageResult, floor: number): string;
