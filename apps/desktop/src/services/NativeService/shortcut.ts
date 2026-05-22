import { invoke } from '@tauri-apps/api/core';

export const shortcut = {
    registerGlobalShortcut(shortcut: string): Promise<void> {
        return invoke('register_global_shortcut', { shortcut });
    },
    getShortcutStatus(): Promise<[boolean, string | null]> {
        return invoke('get_shortcut_status');
    },
} as const;
