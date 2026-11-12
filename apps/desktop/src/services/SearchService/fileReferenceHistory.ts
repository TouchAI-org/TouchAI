import {
    findRecentQuickSearchClicksByQuery,
    upsertQuickSearchClick,
} from '@database/queries/quickSearchClicks';
import type { QuickShortcutItem } from '@services/NativeService';
import type { quickSearch } from '@services/NativeService/quickSearch';
import { log } from '@services/ObservabilityService';

const MAX_REFERENCE_HISTORY_ROWS = 40;
const MAX_REFERENCE_CLICK_COUNT = 1_000_000;

export const FILE_REFERENCE_HISTORY_QUERY = '@reference';

type NativeReferenceSuggestions = Pick<typeof quickSearch, 'getFileReferenceSuggestions'>;

function normalizeReferenceKey(path: string): string {
    return path.trim().replace(/\//g, '\\').toLowerCase();
}

function canonicalReferencePath(path: string): string {
    return path.trim().replace(/\//g, '\\');
}

/**
 * Loads accepted-reference recents and lets the native boundary verify that
 * they still exist. The native method combines them with recently modified
 * documents, keeping references first and deduplicating across both sources.
 */
export async function loadFileReferenceSuggestions(
    native: NativeReferenceSuggestions,
    limit: number,
    signal: AbortSignal
): Promise<QuickShortcutItem[]> {
    if (signal.aborted) return [];

    let rows: Awaited<ReturnType<typeof findRecentQuickSearchClicksByQuery>> = [];
    try {
        rows = await findRecentQuickSearchClicksByQuery({
            queryNorm: FILE_REFERENCE_HISTORY_QUERY,
            limit: MAX_REFERENCE_HISTORY_ROWS,
        });
    } catch (error) {
        log.warn('[SearchService] Failed to load accepted file references:', error);
    }

    if (signal.aborted) return [];

    const seen = new Set<string>();
    const recentPaths: string[] = [];
    for (const row of rows) {
        const path = row.path_norm.trim();
        const key = normalizeReferenceKey(path);
        if (!path || !key || seen.has(key)) continue;
        seen.add(key);
        recentPaths.push(path);
    }

    try {
        const suggestions = await native.getFileReferenceSuggestions(recentPaths, limit, signal);
        return signal.aborted ? [] : suggestions;
    } catch (error) {
        if (signal.aborted) return [];
        log.warn('[SearchService] Failed to resolve file reference suggestions:', error);
        throw error;
    }
}

/**
 * Record only a completed insertion, never a highlighted, hovered or merely
 * displayed result. Persistence is best-effort so reference completion never
 * waits on SQLite.
 */
export function recordAcceptedFileReference(path: string): void {
    const pathNorm = canonicalReferencePath(path);
    if (!pathNorm) return;

    void upsertQuickSearchClick({
        queryNorm: FILE_REFERENCE_HISTORY_QUERY,
        pathNorm,
        maxClickCount: MAX_REFERENCE_CLICK_COUNT,
    }).catch((error) => {
        log.warn('[SearchService] Failed to record accepted file reference:', error);
    });
}
