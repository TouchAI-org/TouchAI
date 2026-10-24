export type CoverageMetrics = {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
};

export type MeasuredTotals = Record<keyof CoverageMetrics, { pct: number }>;

export type RaisedFloor = {
    metric: keyof CoverageMetrics;
    from: number;
    to: number;
    measured: number;
};

export function decideNextFloor(
    configured: CoverageMetrics,
    measured: MeasuredTotals
): { next: CoverageMetrics; raised: RaisedFloor[] };

export function readConfiguredFloor(config: string): CoverageMetrics;

export function applyFloor(config: string, floor: CoverageMetrics): string;
