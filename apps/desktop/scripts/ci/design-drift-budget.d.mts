export interface DriftRule {
    id: string;
    description: string;
    pattern: RegExp;
}

export interface DriftSnapshot {
    counts: Record<string, number>;
    files: Record<string, Record<string, number>>;
}

export interface DiffLines {
    added: string[];
    removed: string[];
}

export const DRIFT_RULES: DriftRule[];

export function collectDrift(rootDirectory?: string): DriftSnapshot;

export function evaluateBudget(
    current: { counts: Record<string, number> },
    baseline: { budget: Record<string, number> }
): string[];

export function evaluateAddedLines(addedLines: string[], removedLines?: string[]): string[];

export function resolveBaseRevisions(): string[];

export function collectDiffLines(revisionRange: string | null, staged?: boolean): DiffLines;

export function collectAddedLines(revisionRange: string | null, staged?: boolean): string[];
