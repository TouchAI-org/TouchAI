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

export type ComputerCapability =
    | 'native_tree'
    | 'screenshot'
    | 'background_actions'
    | 'vision_fallback'
    | 'browser_dom'
    | 'external_provider';

export type ComputerObservationMode = 'tree' | 'screenshot' | 'tree_and_screenshot';

export type ComputerObservationInclude = 'displays' | 'windows' | 'tree' | 'screenshot';

export type ComputerExecutionMode = 'foreground' | 'background';

export type ComputerRouteHint =
    | 'auto'
    | 'win32.send_input'
    | 'win32.message'
    | 'screen.capture'
    | 'unsupported';

export type ComputerActionOperation =
    | 'click'
    | 'double_click'
    | 'right_click'
    | 'move'
    | 'drag'
    | 'scroll'
    | 'type_text'
    | 'press_key'
    | 'hotkey'
    | 'wait';

export type ComputerRoute = ComputerRouteHint;

export type ComputerLane =
    | 'native_tree'
    | 'vision_fallback'
    | 'browser_dom'
    | 'external_provider'
    | 'unsupported';

export interface ComputerBounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface ComputerWindowTarget {
    id?: string;
    title?: string;
    processName?: string;
}

export interface ComputerElementTarget {
    id?: string;
    role?: string;
    name?: string;
}

export interface ComputerCoordinateTarget {
    x: number;
    y: number;
    width?: number;
    height?: number;
    displayId?: string;
}

export interface ComputerTarget {
    scope?: 'foreground' | 'screen' | 'window' | 'element' | 'region';
    window?: ComputerWindowTarget;
    element?: ComputerElementTarget;
    coordinates?: ComputerCoordinateTarget;
    label?: string;
    windowId?: string;
    elementId?: string;
    displayId?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
}

export interface ComputerSessionRequest {
    sessionId: string;
    target: ComputerTarget;
    capabilities: ComputerCapability[];
    providerHints: string[];
    reason: string;
    timeoutMs: number;
}

export interface ComputerCapabilitySnapshot {
    platform: string;
    lanes: ComputerLane[];
    routes: ComputerRoute[];
    background: {
        supported: boolean;
        routes: ComputerRoute[];
        limitations: string[];
    };
    grounding: {
        tree: boolean;
        screenshot: boolean;
        clickPrediction: boolean;
        externalProviders: string[];
    };
}

export interface ComputerSessionResponse {
    sessionId: string;
    status: 'ready' | 'unsupported' | 'error';
    capabilities: ComputerCapabilitySnapshot;
    target: ComputerTarget;
    warnings?: string[];
}

export interface ComputerObservationRequest {
    sessionId: string;
    mode: ComputerObservationMode;
    target: ComputerTarget;
    include: ComputerObservationInclude[];
    reason: string;
    timeoutMs: number;
}

export interface ComputerDisplaySnapshot {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    scaleFactor: number;
    primary: boolean;
}

export interface ComputerWindowSnapshot {
    elementId: string;
    title: string;
    processName?: string | null;
    bounds: ComputerBounds;
    focused: boolean;
    visible: boolean;
    native: boolean;
}

export interface ComputerElementSnapshot {
    elementId: string;
    role: string;
    name: string;
    bounds?: ComputerBounds | null;
    states?: string[];
    value?: string | null;
    children?: ComputerElementSnapshot[];
}

export interface ComputerObservationTree {
    lane: ComputerLane;
    elements: ComputerElementSnapshot[];
}

export interface ComputerScreenshotSnapshot {
    format: 'png' | 'jpeg';
    width: number;
    height: number;
    dataBase64?: string | null;
    path?: string | null;
}

export interface ComputerObservationResponse {
    observationId: string;
    sessionId: string;
    platform: string;
    target: ComputerTarget;
    displays: ComputerDisplaySnapshot[];
    windows: ComputerWindowSnapshot[];
    tree?: ComputerObservationTree | null;
    screenshot?: ComputerScreenshotSnapshot | null;
    warnings: string[];
}

export interface ComputerActionOptions {
    allowBackground: boolean;
    dryRun: boolean;
    postActionObserve: boolean;
}

export interface ComputerActionRequest {
    sessionId: string;
    operation: ComputerActionOperation;
    target: ComputerTarget;
    value: string | null;
    executionMode: ComputerExecutionMode;
    reason: string;
    routeHint: ComputerRouteHint;
    timeoutMs: number;
    options: ComputerActionOptions;
}

export interface ComputerResolvedTarget {
    x?: number | null;
    y?: number | null;
    elementId?: string | null;
    windowId?: string | null;
    confidence: number;
}

export interface ComputerActionReceipt {
    route: ComputerRoute;
    lane: ComputerLane;
    backgroundSafe: boolean;
    cursorMoved: boolean;
    foregroundChanged: boolean;
    targetResolved: ComputerResolvedTarget;
    status: 'success' | 'unsupported' | 'blocked' | 'error';
    warnings: string[];
}

export interface ComputerActionResponseBase {
    actionId: string;
    sessionId: string;
    operation: ComputerActionOperation;
    postActionObservation?: ComputerObservationResponse | null;
}

export interface ComputerActionResponseWithReceipt extends ComputerActionResponseBase {
    receipt: ComputerActionReceipt;
}

export type ComputerActionResponse =
    | ComputerActionResponseWithReceipt
    | (ComputerActionResponseBase & ComputerActionReceipt);

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
