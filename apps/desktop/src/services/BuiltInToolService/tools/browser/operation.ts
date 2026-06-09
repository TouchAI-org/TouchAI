import {
    type BrowserToolOperation,
    fixedBrowserDescription,
    normalizeBrowserDescription,
    requiresBrowserDescription,
} from '@/stores/setting/sections/browserPolicy';
import { normalizeOptionalString } from '@/utils/text';

export function parseBrowserOperation(args: Record<string, unknown>): string | null {
    return normalizeOptionalString(args.operation, { collapseWhitespace: true }) ?? null;
}

export function requireBrowserOperation(
    toolId: 'browser' | 'browser_session' | 'browser_observe' | 'browser_act',
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

function isBrowserToolOperation(value: string): value is BrowserToolOperation {
    return [
        'status',
        'start',
        'stop',
        'current',
        'tabs',
        'screenshot',
        'dom',
        'navigate',
        'click',
        'type',
        'fill',
        'fill_form',
        'press_key',
        'scroll',
        'wait',
        'back',
        'forward',
        'reload',
        'connect_existing',
    ].includes(value);
}

export function resolveBrowserOperationDescription(
    args: Record<string, unknown>,
    fallbackOperation: BrowserToolOperation
): string {
    const rawOperation = parseBrowserOperation(args) ?? fallbackOperation;
    const operation = isBrowserToolOperation(rawOperation) ? rawOperation : fallbackOperation;
    const fixedDescription = fixedBrowserDescription(operation);
    if (fixedDescription) {
        return fixedDescription;
    }

    const description = normalizeBrowserDescription(args.description);
    if (description) {
        return description;
    }

    if (requiresBrowserDescription(operation)) {
        throw new Error(`browser ${operation} requires a non-empty description`);
    }

    return fixedBrowserDescription(fallbackOperation) ?? fallbackOperation;
}
