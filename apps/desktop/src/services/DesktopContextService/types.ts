// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export type DesktopContextInclude =
    | 'summary'
    | 'active_window'
    | 'selected_text.summary'
    | 'selected_text.full_text'
    | 'clipboard.summary'
    | 'clipboard.full_text'
    | 'screenshot.metadata'
    | 'screenshot.image'
    | 'capabilities'
    | 'redactions';

export type DesktopContextScope = 'current' | 'previous' | 'recent' | 'diff';

export interface DesktopContextCapability {
    id: string;
    supported: boolean;
    method: string;
    reason?: string | null;
}

export interface DesktopContextActiveWindow {
    title: string | null;
    appName: string | null;
    processName: string | null;
    processId: number | null;
    windowHandle: string | null;
    bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
}

export interface DesktopContextSelectedText {
    available: boolean;
    source: string | null;
    text: string | null;
    textLength: number;
    truncated: boolean;
    reason?: string | null;
}

export interface DesktopContextClipboard {
    available: boolean;
    snapshotId: string | null;
    observedAt: number | null;
    text: string | null;
    textSummary: string | null;
    textLength: number;
    imageCount: number;
    fileCount: number;
    reason?: string | null;
}

export interface DesktopContextScreenshot {
    available: boolean;
    path: string | null;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    target: 'active_display' | 'active_window' | 'all_displays' | 'unknown';
    persisted: boolean;
    capturedAt: string | null;
    reason?: string | null;
}

export interface DesktopContextRedaction {
    field: string;
    reason: string;
}

export interface DesktopContextCapsule {
    id: string;
    sequence: number;
    capturedAt: string;
    invocationSource: 'shortcut' | 'notification' | 'manual' | 'unknown';
    platform: string;
    summary: string;
    activeWindow: DesktopContextActiveWindow | null;
    selectedText: DesktopContextSelectedText;
    clipboard: DesktopContextClipboard;
    screenshot: DesktopContextScreenshot;
    capabilities: DesktopContextCapability[];
    redactions: DesktopContextRedaction[];
}

export interface BoundDesktopContext extends DesktopContextCapsule {
    boundAt: string;
}

export interface DesktopContextToolRequest {
    include?: DesktopContextInclude[];
    scope?: DesktopContextScope;
    limit?: number;
    screenshotTarget?: 'capsule_default' | 'active_window' | 'active_display' | 'all_displays';
}

export interface DesktopContextPromptMetadata {
    capsuleId: string;
    capturedAt: string;
    boundAt: string;
    summary: string;
    activeWindowTitle: string | null;
    selectedTextLength: number;
    clipboardTextLength: number;
    screenshotPersisted: boolean;
    capabilities: DesktopContextCapability[];
}

export interface DesktopContextTurnArtifact {
    id: number;
    turn_id: number;
    capsule_id: string;
    artifact_kind: 'screenshot' | 'metadata';
    artifact_path: string | null;
    mime_type: string | null;
    width: number | null;
    height: number | null;
    captured_at: string;
    metadata_json: string | null;
    created_at: string;
}

export interface UserMessageDesktopContext {
    capsuleId: string;
    capturedAt: string;
    summary: string;
    activeWindowTitle: string | null;
    screenshotPath: string | null;
    screenshotMimeType: string | null;
    screenshotWidth: number | null;
    screenshotHeight: number | null;
}
