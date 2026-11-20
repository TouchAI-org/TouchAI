export function resolveComparison(
    repository: string,
    baselineRef?: string,
    candidateRef?: string
): {
    baselineCommit: string;
    candidateCommit: string;
    databaseTree: string;
};
