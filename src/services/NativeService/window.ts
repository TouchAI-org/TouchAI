import { invoke } from '@tauri-apps/api/core';

import type { PopupConfig, ShowPopupWindowParams } from './types';

export const window = {
    hideSearchWindow(): Promise<void> {
        return invoke('hide_search_window');
    },

    openSettingsWindow(): Promise<void> {
        return invoke('open_settings_window');
    },

    closeTrayMenu(): Promise<void> {
        return invoke('close_tray_menu');
    },

    isAppFocused(): Promise<boolean> {
        return invoke<boolean>('is_app_focused');
    },

    registerPopupConfigs(configs: PopupConfig[]): Promise<void> {
        return invoke('register_popup_configs', { configs });
    },

    preloadPopupWindows(): Promise<void> {
        return invoke('preload_popup_windows');
    },

    showPopupWindow(params: ShowPopupWindowParams): Promise<void> {
        return invoke('show_popup_window', { ...params });
    },

    hidePopupWindow(): Promise<void> {
        return invoke('hide_popup_window');
    },
} as const;
