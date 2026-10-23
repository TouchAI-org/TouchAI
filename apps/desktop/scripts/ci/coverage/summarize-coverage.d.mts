export type CoverageKind = 'frontend' | 'rust';

export type CoverageMetric = {
    percent: number;
    covered: number | null;
    total: number | null;
};

export type CoberturaCoverage = {
    lines: CoverageMetric;
    branches: CoverageMetric;
};

export type SummarizeCoverageOptions = {
    kind: CoverageKind;
    inputPath: string;
    summaryPath: string;
};

export function parseCoberturaCoverage(xml: string): CoberturaCoverage;

export function formatFrontendCoverage(summary: unknown): string;

export function formatRustCoverage(xml: string): string;

export function appendStepSummary(summaryPath: string, markdown: string): void;

export function resolveRustCoverageCandidates(root?: string): string[];

export function resolveRustCoverageReport(candidates: string[]): string;

export function summarizeCoverageFile(options: SummarizeCoverageOptions): string;

export function parseArgs(
    argv: string[],
    env?: NodeJS.ProcessEnv
): SummarizeCoverageOptions & { resolveRust: boolean };
