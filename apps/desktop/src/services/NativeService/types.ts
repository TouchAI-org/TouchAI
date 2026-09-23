import type { AppUpdateChannel } from '@/config/appUpdate';
import type { SearchWindowDefaultSize, SearchWindowHeightMode } from '@/config/searchWindow';
import type { SessionStatusReminderKind } from '@/utils/session';

export type { AppUpdateChannel } from '@/config/appUpdate';
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
    compactOutput?: boolean;
    rawOutput?: boolean;
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
    compressed?: boolean;
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

export type SessionStatusReminderNotificationKind = SessionStatusReminderKind;

export interface SessionStatusReminderNotificationApprovalPayload {
    callId: string;
    approveLabel: string;
    rejectLabel: string;
}

export interface SessionStatusReminderNotificationPayload {
    title: string;
    body: string;
    sessionId: number;
    taskId: string;
    kind: SessionStatusReminderNotificationKind;
    approval?: SessionStatusReminderNotificationApprovalPayload | null;
    openLabel?: string | null;
    replyPlaceholder?: string | null;
    replyLabel?: string | null;
}

export type TrayStatusIndicator = SessionStatusReminderKind;

export interface RuntimeInfo {
    isE2eTestMode: boolean;
}

export interface AppUpdateInfo {
    version: string;
    fileName: string;
    notes: string | null;
    sizeBytes: number | null;
}

export interface AppUpdateRequirement {
    required: boolean;
    minimumSupportedVersion: string | null;
    requiredSeverity: 'critical' | 'security' | 'recommended' | string | null;
    requiredReason: string | null;
    targetSatisfiesRequirement: boolean;
}

export interface AppUpdateDownload {
    kind: 'installer' | 'fullPackage' | 'deltaPackage' | 'updatePackage' | 'asset' | string;
    name: string;
    url: string;
    sizeBytes: number | null;
}

export interface AppUpdateChannelLatest {
    version: string;
    tag: string;
    releaseUrl: string;
    publishedAt: string | null;
    prerelease: boolean;
    releaseNotes: string | null;
    downloads: AppUpdateDownload[];
}

export type AppUpdateCheckResult =
    | {
          status: 'available';
          channel: AppUpdateChannel;
          currentVersion: string;
          latest: AppUpdateChannelLatest | null;
          update: AppUpdateInfo;
          requirement: AppUpdateRequirement;
      }
    | {
          status: 'not_available';
          channel: AppUpdateChannel;
          currentVersion: string;
          latest: AppUpdateChannelLatest | null;
          requirement: AppUpdateRequirement;
      }
    | {
          status: 'unsupported';
          channel: AppUpdateChannel;
          currentVersion: string | null;
          latest: AppUpdateChannelLatest | null;
          reason: 'not_installed' | 'platform_unsupported' | 'updater_unavailable';
          message: string;
          requirement: AppUpdateRequirement;
      };

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

export interface ClipboardHtmlImage {
    source: string;
    path: string | null;
}

export interface ClipboardPayload {
    snapshotId: string;
    observedAt: number;
    text: string | null;
    html?: string | null;
    htmlSourceUrl?: string | null;
    htmlImages?: ClipboardHtmlImage[];
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

export interface QuickSearchResult {
    shortcuts: QuickShortcutItem[];
    files: QuickShortcutItem[];
    total_files: number;
    total_results: number;
    next_offset: number;
}

export interface BrowserStartRequest {
    headless?: boolean | null;
    startupUrl?: string | null;
    browserExecutablePath?: string | null;
    browserDataPath?: string | null;
    fingerprintMode?: 'off' | 'balanced' | null;
    fingerprintLocale?: string | null;
    fingerprintTimezone?: string | null;
    fingerprintUserAgent?: string | null;
    fingerprintWindowSize?: string | null;
    fingerprintStealthScript?: boolean | null;
}

export interface BrowserInstalledBrowser {
    id: string;
    name: string;
    path: string;
}

export interface BrowserExistingSession {
    id: string;
    label: string;
    endpoint: string;
    browserName: string;
    currentUrl?: string | null;
    title?: string | null;
    tabs: Array<Record<string, unknown>>;
}

export interface BrowserConnectExistingRequest {
    endpoint: string;
}

export interface BrowserNavigationRequest {
    url: string;
    tabId?: string | null;
}

export interface BrowserTabRequest {
    tabId?: string | null;
}

export type BrowserObserveOperation = 'state' | 'snapshot' | 'screenshot';

export interface BrowserObserveRequest {
    operation: BrowserObserveOperation;
    tabId?: string | null;
    includeConsole?: boolean | null;
    includeNetwork?: boolean | null;
}

export type BrowserActOperation =
    | 'click'
    | 'type'
    | 'fill'
    | 'fill_form'
    | 'press_key'
    | 'scroll'
    | 'wait';

export interface BrowserActRequest {
    action: BrowserActOperation;
    tabId?: string | null;
    ref?: string | null;
    refId?: string | null;
    targetRef?: string | null;
    navigationToken?: string | null;
    text?: string | null;
    value?: string | null;
    fields?: Array<Record<string, unknown>> | null;
    key?: string | null;
    deltaX?: number | null;
    deltaY?: number | null;
    timeoutMs?: number | null;
}

export type BrowserStatusResponse = Record<string, unknown>;
export type BrowserSessionResponse = Record<string, unknown>;
export type BrowserConnectExistingResponse = Record<string, unknown>;
export type BrowserObserveResponse = Record<string, unknown>;
export type BrowserActResponse = Record<string, unknown>;
