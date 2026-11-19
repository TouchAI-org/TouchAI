import { invoke } from './invoke';
import type {
    QuickSearchFileItem,
    QuickSearchResult,
    QuickSearchStatus,
    QuickShortcutItem,
} from './types';

const DEFAULT_PAGE_SIZE = 60;
const DEFAULT_ICON_SIZE = 48;
const DEFAULT_REFERENCE_SUGGESTION_LIMIT = 12;

export const quickSearch = {
    searchShortcuts(
        query: string,
        pageSize = DEFAULT_PAGE_SIZE,
        offset = 0
    ): Promise<QuickSearchResult> {
        return invoke('quick_search_search_shortcuts', { query, pageSize, offset });
    },

    listDirectory(
        query: string,
        limit = DEFAULT_PAGE_SIZE,
        offset = 0
    ): Promise<QuickSearchResult | null> {
        return invoke('quick_search_list_directory', { query, limit, offset });
    },

    searchFiles(
        query: string,
        limit = DEFAULT_PAGE_SIZE,
        options?: { includeShortcuts?: boolean }
    ): Promise<QuickSearchFileItem[]> {
        return invoke('quick_search_search_files', {
            query,
            limit,
            include_shortcuts: options?.includeShortcuts ?? false,
        });
    },

    getFileReferenceSuggestions(
        recentPaths: string[],
        limit = DEFAULT_REFERENCE_SUGGESTION_LIMIT,
        signal?: AbortSignal
    ): Promise<QuickShortcutItem[]> {
        if (signal?.aborted) return Promise.resolve([]);
        return invoke<QuickShortcutItem[]>('quick_search_file_reference_suggestions', {
            recentPaths,
            limit,
        }).then((suggestions) => (signal?.aborted ? [] : suggestions));
    },

    getShortcutIcon(path: string, size = DEFAULT_ICON_SIZE): Promise<string | null> {
        return invoke<string | null>('quick_search_get_shortcut_icon', { path, size });
    },

    getShortcutIcons(paths: string[], size = DEFAULT_ICON_SIZE): Promise<Record<string, string>> {
        return invoke<Record<string, string>>('quick_search_get_shortcut_icons', { paths, size });
    },

    getImageThumbnails(paths: string[], size = DEFAULT_ICON_SIZE): Promise<Record<string, string>> {
        return invoke<Record<string, string>>('quick_search_get_image_thumbnails', {
            paths,
            size,
        });
    },

    prepareIndex(force = false): Promise<void> {
        return invoke('quick_search_prepare_index', { force });
    },

    getStatus(): Promise<QuickSearchStatus> {
        return invoke('quick_search_get_status');
    },
} as const;
