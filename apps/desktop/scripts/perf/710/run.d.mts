export interface MeasurementInvalidReasonInput {
    exitCode: number | null;
    signal: string | null;
    notificationFailures: number;
    samplerFailure: string | null;
}

export function measurementInvalidReasons(input: MeasurementInvalidReasonInput): string[];

export interface SamplerExit {
    code: number | null;
    signal: string | null;
}

export interface SamplerWatch {
    noteExit(code: number | null, signal: string | null): void;
    earlyExit(): SamplerExit | null;
}

export function createSamplerWatch(): SamplerWatch;

export function samplerFailureReason(input: {
    earlyExit: SamplerExit | null;
    error: Error | null;
}): string | null;

export function resolveComparison(
    repository: string,
    baselineRef?: string,
    candidateRef?: string
): {
    baselineCommit: string;
    candidateCommit: string;
    databaseTree: string;
};
export function linkSnapshotDependencies(snapshot: string, checkout?: string): void;
export function configureBaseFixture(database: string, arm: string): void;
