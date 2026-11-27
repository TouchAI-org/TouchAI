export interface RunMeasurementsOptions {
    railPolicies?: { baseline: 'all' | 'sampled'; current: 'all' | 'sampled' };
    flows: string[];
    latencyBlocks: number;
    progressBlocks: number;
    longBlocks: number;
    historyLevels: number[];
    warmSamples: number;
    progressWarmups: number;
    progressTasks: number;
    memoryIntervalMs: number;
    dryRun: boolean;
    resume: boolean;
}

export function runMeasurements(
    options: RunMeasurementsOptions,
    signal?: AbortSignal
): Promise<void>;
