export type PatchCoverageCliOptions = {
    coveragePath: string;
    base: string;
    root: string;
    floor: number;
    summaryPath?: string;
    dryRun?: boolean;
};

export type PatchCoverageRun = {
    result: import('./patch-coverage.mjs').PatchCoverageResult;
    markdown: string;
    failures: string[];
};

export function parseArgs(
    argv: string[],
    env?: Record<string, string | undefined>
): PatchCoverageCliOptions;

export function resolveBase(ref: string): string;

export function readChangedLines(base: string, paths: readonly string[]): Map<string, Set<number>>;

export function runPatchCoverage(
    options: PatchCoverageCliOptions,
    deps?: {
        readChangedLines?: typeof readChangedLines;
        resolveBase?: (ref: string) => string;
    }
): PatchCoverageRun;
