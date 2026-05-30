import { invoke } from '@tauri-apps/api/core';

import type {
    HidePopupWindowParams,
    PopupConfig,
    ResizeWindowHeightParams,
    SearchWindowDefaultSize,
    SearchWindowMinimumSize,
    SearchWindowState,
    ShowPopupWindowParams,
} from './types';

export const window = {
    hideSearchWindow(): Promise<void> {
        return invoke('hide_search_window');
    },

    showSearchWindow(): Promise<void> {
        return invoke('show_search_window');
    },

    openSettingsWindow(): Promise<void> {
        return invoke('open_settings_window');
    },

    closeTrayMenu(): Promise<void> {
        return invoke('close_tray_menu');
    },

    registerPopupConfigs(configs: PopupConfig[]): Promise<void> {
        return invoke('register_popup_configs', { configs });
    },

    preloadPopupWindows(): Promise<void> {
        return invoke('preload_popup_windows');
    },

    showPopupWindow(params: ShowPopupWindowParams): Promise<void> {
        return invoke('show_popup_window', { params });
    },

    hidePopupWindow(params: HidePopupWindowParams): Promise<void> {
        return invoke('hide_popup_window', { params });
    },

    setSearchSurfaceHideOnAppBlur(shouldHide: boolean): Promise<void> {
        return invoke('set_search_surface_hide_on_app_blur', { shouldHide });
    },

    setSearchWindowAllowHeightOverride(allow: boolean): Promise<void> {
        return invoke('set_search_window_allow_height_override', { allow });
    },

    resizeWindowHeight(params: ResizeWindowHeightParams): Promise<void> {
        return invoke('resize_window_height', { params });
    },

    setSearchWindowDefaults(defaults: SearchWindowDefaultSize): Promise<SearchWindowDefaultSize> {
        return invoke('set_search_window_defaults', { defaults });
    },

    setSearchWindowMinSize(size: SearchWindowMinimumSize): Promise<void> {
        return invoke('set_search_window_min_size', { size });
    },

    resetSearchWindowBounds(): Promise<void> {
        return invoke('reset_search_window_bounds');
    },

    getSearchWindowState(): Promise<SearchWindowState> {
        return invoke('get_search_window_state');
    },
} as const;
