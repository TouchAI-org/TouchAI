import { invoke } from '@tauri-apps/api/core';

export interface SearchSurfaceShortcutEntry {
    actionId: string;
    shortcut: string;
}

export const shortcut = {
    registerGlobalShortcut(shortcut: string): Promise<void> {
        return invoke('register_global_shortcut', { shortcut });
    },
    getShortcutStatus(): Promise<[boolean, string | null]> {
        return invoke('get_shortcut_status');
    },
    setSearchSurfaceShortcuts(entries: SearchSurfaceShortcutEntry[]): Promise<void> {
        return invoke('set_search_surface_shortcuts', { entries });
    },
} as const;
