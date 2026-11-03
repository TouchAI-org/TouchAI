export type ArtifactHashes = Record<string, string>;

export type ArtifactDiff = {
    added: string[];
    removed: string[];
    changed: string[];
};

export const ARTIFACT_ROOTS: string[];

export function hashArtifacts(projectRoot?: string): ArtifactHashes;

export function diffAgainstBaseline(
    current: ArtifactHashes,
    baseline: ArtifactHashes
): ArtifactDiff;

export function checkArtifacts(options?: { projectRoot?: string; baselineFile?: string }): {
    current: ArtifactHashes;
    baseline: ArtifactHashes;
    diff: ArtifactDiff;
};

export function checkGeneration(options?: {
    projectRoot?: string;
    tmpRoot?: string;
    runGenerate?: (work: string, nodeModules: string) => string;
}): { output: string; failed: boolean; diff: ArtifactDiff };
