import { invoke } from '@tauri-apps/api/core';

import type { QuickSearchFileItem, QuickSearchStatus, QuickShortcutItem } from './types';

const DEFAULT_LIMIT = 60;
const DEFAULT_ICON_SIZE = 48;

export const quickSearch = {
    searchShortcuts(query: string, limit = DEFAULT_LIMIT): Promise<QuickShortcutItem[]> {
        return invoke('quick_search_search_shortcuts', { query, limit });
    },

    searchFiles(
        query: string,
        limit = DEFAULT_LIMIT,
        options?: { includeShortcuts?: boolean }
    ): Promise<QuickSearchFileItem[]> {
        return invoke('quick_search_search_files', {
            query,
            limit,
            include_shortcuts: options?.includeShortcuts ?? false,
        });
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
