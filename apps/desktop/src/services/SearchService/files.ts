import type { QuickShortcutItem } from '@/services/NativeService';
import type { quickSearch } from '@/services/NativeService/quickSearch';

import type { SearchAction, SearchIntent, SearchProvider, SearchResult } from './contracts';

const REFERENCE_SUGGESTION_LIMIT = 12;

export interface FileOpenAction extends SearchAction {
    readonly kind: 'file.open';
    readonly path: string;
}

export interface FileReferenceAction extends SearchAction {
    readonly kind: 'file.reference';
    readonly item: QuickShortcutItem;
}

export interface FileSearchResult extends SearchResult<FileOpenAction | FileReferenceAction> {
    readonly kind: 'file';
    readonly file: QuickShortcutItem;
}

export function createFileSearchProvider(
    native: Pick<typeof quickSearch, 'searchShortcuts'>,
    options: {
        rank?: (query: string, items: QuickShortcutItem[]) => Promise<QuickShortcutItem[]>;
        fallback?: (query: string) => QuickShortcutItem[];
        loadReferenceSuggestions?: (
            limit: number,
            signal: AbortSignal
        ) => Promise<QuickShortcutItem[]>;
    } = {}
): SearchProvider<FileSearchResult> {
    return {
        id: 'files',
        intents: ['launcher', 'file-reference'],
        async search({ query, limit, cursor, signal, intent }) {
            const offset = cursor === undefined ? 0 : Number(cursor);
            if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid file cursor');
            const trimmedQuery = query.trim();
            if (intent === 'file-reference' && !trimmedQuery) {
                const suggestions =
                    offset === 0
                        ? ((await options.loadReferenceSuggestions?.(
                              Math.min(limit, REFERENCE_SUGGESTION_LIMIT),
                              signal
                          )) ?? [])
                        : [];
                if (signal.aborted) return { items: [] };
                return {
                    items: suggestions.map((file) => toFileResult(file, intent)),
                    total: suggestions.length,
                    totals: { file: suggestions.length },
                };
            }
            const page = await native.searchShortcuts(query, limit, offset);
            if (signal.aborted) return { items: [] };
            const shortcuts =
                offset === 0
                    ? options.rank
                        ? await options.rank(query, page.shortcuts)
                        : page.shortcuts
                    : [];
            let items = [...shortcuts, ...page.files];
            if (!cursor && !items.length) items = options.fallback?.(query) ?? [];
            const total = Math.max(page.total_results, items.length);
            const more =
                page.files.length > 0 &&
                page.next_offset > offset &&
                page.next_offset <
                    Math.max(page.total_files, page.total_results - page.shortcuts.length);
            return {
                items: items.map((file) => toFileResult(file, intent)),
                total,
                totals: {
                    shortcut: page.shortcuts.length,
                    file: Math.max(
                        page.total_files,
                        items.filter((item) => item.source === 'file').length
                    ),
                },
                nextCursor: more ? String(page.next_offset) : undefined,
            };
        },
    };
}

function toFileResult(file: QuickShortcutItem, intent: SearchIntent): FileSearchResult {
    const completionAction: FileReferenceAction = {
        kind: 'file.reference',
        item: file,
    };
    return {
        id: file.path,
        kind: 'file',
        group: file.source === 'file' ? 'file' : 'shortcut',
        label: file.name,
        description:
            file.source === 'file' || file.source === 'shortcut_file' ? file.path : undefined,
        file,
        completionAction,
        primaryAction:
            intent === 'file-reference' ? completionAction : { kind: 'file.open', path: file.path },
    };
}

export function fileSearchItem(result: SearchResult): QuickShortcutItem | null {
    return result.kind === 'file' && 'file' in result ? (result as FileSearchResult).file : null;
}
