export interface MeasurementInvalidReasonInput {
    exitCode: number | null;
    signal: string | null;
    notificationFailures: number;
    samplerFailure: string | null;
    launchError?: Error | null;
}

export interface DisplayStartupFailure {
    runStarted: boolean;
    exitCode: number | null;
    signal: string | null;
    logText: string;
}

export function shouldRetryDisplayStartupFailure(input: DisplayStartupFailure): boolean;

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

export interface MeasurementOptions {
    railPolicies?: { baseline: 'all' | 'sampled'; current: 'all' | 'sampled' };
    memoryIntervalMs: number;
    progressTasks?: number;
    progressWarmups?: number;
    warmSamples?: number;
}

export interface MeasurementRequest {
    signal?: AbortSignal;
    arm: 'baseline' | 'current';
    flow: string;
    block: number;
    sequenceIndex: number;
    fixture: string;
    historyLevel: number;
    options: MeasurementOptions;
    attempt?: number;
}

export function runOneMeasurement(input: MeasurementRequest): Promise<unknown>;
