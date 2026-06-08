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

export type AppUseNativeAdapterId =
    | 'office_word'
    | 'office_excel'
    | 'office_powerpoint'
    | 'wps_writer'
    | 'wps_spreadsheet'
    | 'wps_presentation'
    | 'photoshop'
    | 'illustrator';

export type AppUseNativeActAdapterId =
    | 'office_word'
    | 'office_excel'
    | 'office_powerpoint'
    | 'wps_writer'
    | 'wps_spreadsheet'
    | 'wps_presentation';

export type AppUseNativeMode = 'read_only' | 'interactive';

export interface AppUseNativeConfig {
    mode: AppUseNativeMode;
    adapters: Record<AppUseNativeAdapterId, boolean>;
    mutatingApprovalMode: 'always';
    readScope: 'active';
    allowRawAutomation: false;
    timeoutMs: number;
    maxOutputChars: number;
}

export interface AppUseNativeAdapterDescriptor {
    id: AppUseNativeAdapterId;
    label: string;
    installed: boolean;
    running: boolean;
    enabled: boolean;
    capabilities: string[];
    contract: {
        vendor: string;
        version: string;
        observeScopes: string[];
        actions: AppUseNativeActAction[];
        riskLevel: 'high' | string;
        rawAutomationAllowed: false;
    };
    activeTargetName: string | null;
}

export interface AppUseNativeSessionRequest {
    executionId: string;
    operation: 'status' | 'discover' | 'capabilities' | 'create_owned_target';
    description: string;
    adapterId?: AppUseNativeActAdapterId;
    targetKind?: 'document' | 'spreadsheet' | 'presentation';
    config: AppUseNativeConfig;
}

export interface AppUseNativeSessionResponse {
    ok: boolean;
    operation: AppUseNativeSessionRequest['operation'];
    adapters: AppUseNativeAdapterDescriptor[];
    message: string | null;
    adapterId?: AppUseNativeActAdapterId;
    targetKind?: 'document' | 'spreadsheet' | 'presentation';
    target?: string;
}

export interface AppUseNativeObserveRequest {
    executionId: string;
    adapterId: AppUseNativeAdapterId;
    scope:
        | 'active_document'
        | 'selection'
        | 'workbook'
        | 'worksheet'
        | 'presentation'
        | 'slide'
        | 'layers'
        | 'artboards';
    description: string;
    targetId?: string;
    maxOutputChars: number;
    config: AppUseNativeConfig;
}

export interface AppUseNativeObserveResponse {
    ok: boolean;
    adapterId: AppUseNativeAdapterId;
    scope: AppUseNativeObserveRequest['scope'];
    target: string | null;
    content: string | null;
    metadata: Record<string, unknown>;
    truncated: boolean;
}

export type AppUseNativeActAction =
    | 'replace_document_text'
    | 'write_cells'
    | 'add_slide_text'
    | 'format_document_text';

export interface AppUseNativeActPermit {
    callId: string;
    adapterId: AppUseNativeActAdapterId;
    action: AppUseNativeActAction;
    targetId: string;
    parametersHash: string;
    token: string;
}

export interface AppUseNativeAuthorizeActRequest {
    executionId: string;
    adapterId: AppUseNativeActAdapterId;
    action: AppUseNativeActAction;
    targetId: string;
    parameters?: Record<string, unknown>;
    config: AppUseNativeConfig;
}

export interface AppUseNativeAuthorizeActResponse {
    permit: AppUseNativeActPermit | null;
    expiresInMs: number;
}

export interface AppUseNativeActRequest {
    executionId: string;
    adapterId: AppUseNativeActAdapterId;
    action: AppUseNativeActAction;
    description: string;
    targetId: string;
    parameters?: Record<string, unknown>;
    permit?: AppUseNativeActPermit;
    config: AppUseNativeConfig;
}

export interface AppUseNativeActResponse {
    ok: boolean;
    adapterId: AppUseNativeActAdapterId;
    action: AppUseNativeActAction;
    receipt: string;
    changed: boolean;
    metadata: Record<string, unknown>;
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
