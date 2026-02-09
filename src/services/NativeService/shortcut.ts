import { invoke } from '@tauri-apps/api/core';

export const shortcut = {
    registerGlobalShortcut(shortcut: string): Promise<void> {
        return invoke('register_global_shortcut', { shortcut });
    },
} as const;
