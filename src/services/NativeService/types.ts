export interface PopupConfig {
    id: string;
    width: number;
    height: number;
}

export interface ShowPopupWindowParams {
    x: number;
    y: number;
    width: number;
    height: number;
    popupType: string;
}

export interface ResizeWindowHeightParams {
    targetHeight: number;
    minHeight?: number;
    maxHeight?: number;
    center?: boolean;
    animate?: boolean;
    durationMs?: number;
    windowLabel?: string;
}

export interface TauriLogPayload {
    level: number;
    message: string;
    location?: string;
    file?: string;
    line?: number;
}

export interface QuickShortcutItem {
    name: string;
    path: string;
    source:
        | 'start_menu_user'
        | 'start_menu_common'
        | 'desktop_user'
        | 'desktop_public'
        | 'shortcut_file'
        | 'file';
}

export interface QuickSearchStatus {
    provider: 'everything' | 'unavailable';
    db_loaded: boolean;
    index_warmed: boolean;
    last_refresh_ms: number | null;
    last_error: string | null;
}
