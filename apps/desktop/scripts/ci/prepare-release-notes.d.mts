export function prepareReleaseNotes(
    projectRoot: string,
    outputRoot: string,
    options: {
        channel: 'stable' | 'beta' | 'nightly';
        version: string;
        tag: string;
        repository: string;
        targetCommitish: string;
        eventName?: string;
        gh?: (args: string[]) => string;
    }
): Promise<void>;
