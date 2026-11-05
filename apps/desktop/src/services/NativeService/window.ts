import { invoke } from './invoke';
import type {
    ResizeWindowHeightParams,
    SearchPanelResizeCommit,
    SearchSurfacePreparation,
    SearchWindowDefaultSize,
    SearchWindowMinimumSize,
    SearchWindowRegion,
    SearchWindowRegionUpdate,
    SearchWindowState,
    SessionStatusReminderNotificationPayload,
    TrayStatusIndicator,
} from './types';

export const window = {
    hideSearchWindow(): Promise<void> {
        return invoke('hide_search_window');
    },

    showSearchWindow(): Promise<void> {
        return invoke('show_search_window');
    },

    getSearchWindowRendererEpoch(): Promise<number> {
        return invoke('get_search_window_renderer_epoch');
    },

    markSearchWindowReady(rendererEpoch: number): Promise<SearchSurfacePreparation | null> {
        return invoke('mark_search_window_ready', { rendererEpoch });
    },

    setTrayStatusIndicator(status: TrayStatusIndicator): Promise<void> {
        return invoke('set_tray_status_indicator', { status });
    },

    clearTrayStatusIndicator(): Promise<void> {
        return invoke('clear_tray_status_indicator');
    },

    showSessionStatusReminderNotification(
        payload: SessionStatusReminderNotificationPayload
    ): Promise<void> {
        return invoke('show_session_status_reminder_notification', { payload });
    },

    clearSessionStatusReminderNotifications(): Promise<void> {
        return invoke('clear_session_status_reminder_notifications');
    },

    openSettingsWindow(): Promise<void> {
        return invoke('open_settings_window');
    },

    closeTrayMenu(): Promise<void> {
        return invoke('close_tray_menu');
    },

    setSearchSurfaceHideOnAppBlur(shouldHide: boolean): Promise<void> {
        return invoke('set_search_surface_hide_on_app_blur', { shouldHide });
    },

    setSearchWindowRegions(
        regions: SearchWindowRegion[],
        generation: number,
        preparation?: SearchSurfacePreparation | null
    ): Promise<SearchWindowRegionUpdate> {
        return invoke('set_search_window_regions', {
            regions,
            generation,
            preparation,
        });
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

    commitSearchPanelResize(resize: SearchPanelResizeCommit): Promise<SearchWindowState> {
        return invoke('commit_search_panel_resize', { resize });
    },
} as const;
