export function validateVersionPolicy(
    projectRoot: string,
    options?: {
        tagName?: string | null;
        expectedIdentifier?: string;
        skipTag?: boolean;
    }
): Promise<string[]>;
