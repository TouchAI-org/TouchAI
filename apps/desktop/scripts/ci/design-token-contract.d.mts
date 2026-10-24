export interface UnresolvedColorUtility {
    token: string;
    file: string;
    line: number;
}

export function collectThemeTokens(styleDirectory?: string): Set<string>;

export function findUnresolvedColorUtilities(
    themeTokens: Set<string>,
    rootDirectory?: string
): UnresolvedColorUtility[];

export function evaluateTokenContract(themeTokens: Set<string>, rootDirectory?: string): string[];
