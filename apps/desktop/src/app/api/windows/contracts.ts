import type { SearchWindowDefaultSize, SearchWindowHeightMode } from '@/config/searchWindow';
export type { SearchWindowDefaultSize } from '@/config/searchWindow';

export interface DiagnosticModeStatus {
    enabled: boolean;
    expiresAtMs: number;
}

export interface DiagnosticBundleFile {
    name: string;
    bytes: number;
}

export interface DiagnosticBundlePreview {
    files: DiagnosticBundleFile[];
    totalBytes: number;
    logDirectoryFallback: boolean;
}

export interface ResizeWindowHeightParams {
    targetHeight: number;
    center?: boolean;
    animate?: boolean;
    respectManualOverride?: boolean;
}

export interface SearchWindowRegion {
    x: number;
    y: number;
    width: number;
    height: number;
    cornerRadius?: number;
}

export interface SearchSurfacePhysicalViewport {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SearchSurfacePreparation {
    rendererEpoch: number;
    showEpoch: number;
    hostEpoch: number;
    source: 'shortcut' | 'notification' | 'tray' | 'main';
    physicalViewport: SearchSurfacePhysicalViewport;
    scaleFactor: number;
}

export interface SearchSurfaceShowStatus {
    /**
     * `obsolete`: the host had already replaced the preparation this commit
     * acknowledged. The epochs describe the preparation that is current now.
     */
    status: 'shown' | 'obsolete';
    rendererEpoch: number;
    showEpoch: number;
    hostEpoch: number;
    generation: number;
}

export type SearchWindowRegionUpdate =
    | {
          status: 'applied';
          generation: number;
          showStatus?: SearchSurfaceShowStatus;
      }
    | {
          status: 'stale';
          requestedGeneration: number;
          activeGeneration: number;
      };

export interface SearchWindowMinimumSize {
    minWidth: number;
    minHeight: number;
    maxHeight: number | null;
}

export interface SearchPanelSize {
    width: number;
    height: number;
}

export type SearchHostPlacement =
    | 'preserve-origin'
    | 'preserve-center'
    | 'idle'
    | 'work-area'
    | 'restore';

export interface SearchPanelResizeCommit {
    from: SearchPanelSize;
    to: SearchPanelSize;
    /** Renderer-owned content/viewport resize; keep native height mode Auto. */
    auto?: boolean;
    /** One-shot session-open measurement may clear a stale native manual override. */
    respectManualOverride?: boolean;
    /** Explicit host placement; omitted placement preserves the current center. */
    placement?: SearchHostPlacement;
    physicalOrigin?: { x: number; y: number };
}

export interface SearchWindowState {
    defaults: SearchWindowDefaultSize;
    currentWidth: number;
    currentHeight: number;
    heightMode: SearchWindowHeightMode;
    monitorHost: boolean;
}

export type SessionStatusReminderNotificationKind = 'completed' | 'failed' | 'waiting_approval';

export interface SessionStatusReminderNotificationApprovalPayload {
    callId: string;
    approveLabel: string;
    rejectLabel: string;
    /** Opaque interaction identity returned with the notification action. Not persisted. */
    decisionId?: string | null;
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

export type TrayStatusIndicator = SessionStatusReminderNotificationKind;

export interface DisplayArea {
    position: { x: number; y: number };
    size: { width: number; height: number };
}
export interface WindowMonitor extends DisplayArea {
    workArea: DisplayArea;
    scaleFactor: number;
}
export interface ComputerUseFeedback {
    generation: number;
    activities: { id: string; ordinal: number; pointer: { x: number; y: number } | null }[];
    banner: { x: number; y: number } | null;
    locale: string;
}
