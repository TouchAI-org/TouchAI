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
    kind:
        | 'installer'
        | 'portable'
        | 'fullPackage'
        | 'deltaPackage'
        | 'updatePackage'
        | 'asset'
        | string;
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

export interface QuickSearchResult {
    shortcuts: QuickShortcutItem[];
    files: QuickShortcutItem[];
    total_files: number;
    total_results: number;
    next_offset: number;
}
