export interface PerformanceBuildResult {
    arm: 'baseline' | 'current';
    binarySha256: string;
    binarySize: number;
    elapsedMs: number;
    sourceManifestSha256: string;
    reusedFrom?: 'baseline';
}

export function verifyBuiltArms(): void;

export function buildBoth(signal?: AbortSignal): Promise<PerformanceBuildResult[]>;
