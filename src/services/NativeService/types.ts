export interface PopupConfig {
    id: string;
    width: number;
    height: number;
}

export interface BuiltInBashExecutionRequest {
    command: string;
    workingDirectory?: string | null;
    timeoutMs?: number | null;
}

export interface BuiltInBashExecutionResponse {
    command: string;
    shell: string;
    workingDirectory: string | null;
    exitCode: number | null;
    success: boolean;
    timedOut: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    combinedOutput: string;
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
    center?: boolean;
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

export interface QuickSearchFileItem {
    name: string;
    path: string;
}

export interface QuickSearchStatus {
    provider: 'everything' | 'unavailable';
    db_loaded: boolean;
    index_warmed: boolean;
    last_refresh_ms: number | null;
    last_error: string | null;
}
