import { normalizeOptionalString } from '@/utils/text';

export function parseBrowserOperation(args: Record<string, unknown>): string | null {
    return normalizeOptionalString(args.operation, { collapseWhitespace: true }) ?? null;
}

export function requireBrowserOperation(
    toolId: 'browser_session' | 'browser_observe' | 'browser_act',
    args: Record<string, unknown>
): string {
    const operation = parseBrowserOperation(args);
    if (!operation) {
        throw new Error(`Missing required ${toolId} operation`);
    }

    return operation;
}

export function browserOperationForSemantic(
    args: Record<string, unknown>,
    fallback: string
): string {
    return parseBrowserOperation(args) ?? fallback;
}
