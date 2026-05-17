import type { SearchWindowDefaultSize, SearchWindowHeightMode } from '@/config/searchWindow';
export type { SearchWindowDefaultSize, SearchWindowHeightMode };

export interface PopupConfig {
    id: string;
    width: number;
    height: number;
}

export interface BuiltInBashExecutionRequest {
    executionId: string;
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
    cancelled: boolean;
    durationMs: number;
    stdout: string;
    stderr: string;
    combinedOutput: string;
}

export interface BuiltInRipgrepExecutionRequest {
    executionId: string;
    argv: string[];
    workingDirectory?: string | null;
    timeoutMs?: number | null;
}

export interface BuiltInRipgrepExecutionResponse {
    command: string;
    binaryPath: string;
    binarySource: 'bundled' | 'system';
    workingDirectory: string | null;
    exitCode: number | null;
    success: boolean;
    timedOut: boolean;
    cancelled: boolean;
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
    popupId: string;
    windowLabel: string;
    popupSessionVersion: number;
}

export interface HidePopupWindowParams {
    popupId: string;
    windowLabel: string;
    popupSessionVersion: number;
}

export interface ResizeWindowHeightParams {
    targetHeight: number;
    center?: boolean;
    animate?: boolean;
    respectManualOverride?: boolean;
}

export interface SearchWindowMinimumSize {
    minWidth: number;
    minHeight: number;
    maxHeight: number | null;
}

export interface SearchWindowState {
    defaults: SearchWindowDefaultSize;
    currentWidth: number;
    currentHeight: number;
    heightMode: SearchWindowHeightMode;
}

export interface RuntimeInfo {
    isE2eTestMode: boolean;
}

export interface TauriLogPayload {
    level: number;
    message: string;
    location?: string;
    file?: string;
    line?: number;
}

export type ClipboardPayloadFragment =
    | {
          type: 'text';
          text: string;
      }
    | {
          type: 'image';
          path: string;
      }
    | {
          type: 'file';
          path: string;
      };

export interface ClipboardPayload {
    snapshotId: string;
    observedAt: number;
    text: string | null;
    imagePaths: string[];
    filePaths: string[];
    fragments?: ClipboardPayloadFragment[];
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
