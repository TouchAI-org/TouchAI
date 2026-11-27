export class PerformanceHarnessLockedError extends Error {
    readonly code: 'PERF_HARNESS_LOCKED';
    readonly lockPath: string;
}

export function performanceHarnessLockPath(root: string): string;

export function performanceHarnessLockPaths(evidenceRoot: string, artifactsRoot: string): string[];

export function acquirePerformanceHarnessLock(options: {
    command: string;
    evidenceRoot: string;
    artifactsRoot: string;
}): {
    paths: string[];
    release(): void;
};
