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

export function readDiff(base: string, path: string): string;

export function runPatchCoverage(
    options: PatchCoverageCliOptions,
    deps?: {
        readDiff?: (base: string, path: string) => string;
        resolveBase?: (ref: string) => string;
    }
): PatchCoverageRun;
