import { invoke } from '@tauri-apps/api/core';

export const autostart = {
    isAutostartEnabled(): Promise<boolean> {
        return invoke<boolean>('is_autostart_enabled');
    },

    enableAutostart(): Promise<void> {
        return invoke('enable_autostart');
    },

    disableAutostart(): Promise<void> {
        return invoke('disable_autostart');
    },
} as const;
