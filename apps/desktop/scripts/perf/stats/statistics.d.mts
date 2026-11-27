export type MemorySample = {
    at: number;
    totalPssKb: number;
};

export function nearestMemoryBefore(
    samples: MemorySample[],
    at: number,
    maxDistanceMs?: number
): MemorySample | null;
