export type CoverageKind = 'frontend' | 'rust';

export type CoverageMetric = {
    percent: number;
    covered: number;
    total: number;
};

export type LlvmCovCoverage = {
    lines: CoverageMetric;
    regions: CoverageMetric;
    branches: CoverageMetric;
};

export type CoverageFloors = {
    lines: number;
    regions: number;
};

export type SummarizeCoverageOptions = {
    kind: CoverageKind;
    inputPath: string;
    summaryPath: string;
};

export function parseLlvmCovCoverage(json: string): LlvmCovCoverage;

export function formatFrontendCoverage(summary: unknown): string;

export function formatRustCoverage(json: string): string;

export function checkRustCoverageFloors(
    coverage: LlvmCovCoverage,
    floors: Partial<CoverageFloors>
): string[];

export function raisedRustCoverageFloors(
    coverage: LlvmCovCoverage,
    floors: CoverageFloors
): CoverageFloors;

export function appendStepSummary(summaryPath: string, markdown: string): void;

export function resolveRustCoverageCandidates(root?: string): string[];

export function resolveRustCoverageReport(candidates: string[]): string;

export function summarizeCoverageFile(options: SummarizeCoverageOptions): string;

export function parseArgs(
    argv: string[],
    env?: NodeJS.ProcessEnv
): SummarizeCoverageOptions & { resolveRust: boolean; raise: boolean; skipFloors: boolean };
