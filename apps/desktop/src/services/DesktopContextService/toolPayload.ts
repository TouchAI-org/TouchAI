// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    BoundDesktopContext,
    DesktopContextActiveWindow,
    DesktopContextCapability,
    DesktopContextInclude,
    DesktopContextPromptMetadata,
    DesktopContextRedaction,
    DesktopContextToolRequest,
} from './types';

interface DesktopContextToolUnavailablePayload {
    available: false;
    reason: string;
}

interface DesktopContextToolSelectedTextPayload {
    available: boolean;
    source: string | null;
    textLength: number;
    truncated: boolean;
    reason: string | null;
    fullText?: string | null;
}

interface DesktopContextToolClipboardPayload {
    available: boolean;
    snapshotId: string | null;
    observedAt: number | null;
    textSummary: string | null;
    textLength: number;
    imageCount: number;
    fileCount: number;
    reason: string | null;
    fullText?: string | null;
}

interface DesktopContextToolScreenshotPayload {
    available: boolean;
    mimeType: string | null;
    width: number | null;
    height: number | null;
    target: string;
    persisted: boolean;
    capturedAt: string | null;
    reason: string | null;
    path?: string | null;
}

interface DesktopContextToolAvailablePayload {
    available: true;
    capsuleId: string;
    scope: string;
    capturedAt: string;
    boundAt: string;
    summary?: string;
    activeWindow?: DesktopContextActiveWindow | null;
    selectedText?: DesktopContextToolSelectedTextPayload;
    clipboard?: DesktopContextToolClipboardPayload;
    screenshot?: DesktopContextToolScreenshotPayload;
    capabilities?: DesktopContextCapability[];
    redactions?: DesktopContextRedaction[];
}

export type DesktopContextToolPayload =
    | DesktopContextToolUnavailablePayload
    | DesktopContextToolAvailablePayload;

const DEFAULT_INCLUDE: DesktopContextInclude[] = [
    'summary',
    'active_window',
    'selected_text.full_text',
    'clipboard.summary',
    'capabilities',
    'redactions',
];

function normalizeInclude(include: unknown): Set<DesktopContextInclude> {
    if (!Array.isArray(include) || include.length === 0) {
        return new Set(DEFAULT_INCLUDE);
    }

    return new Set(
        include.filter((item): item is DesktopContextInclude => typeof item === 'string')
    );
}

function has(include: Set<DesktopContextInclude>, key: DesktopContextInclude): boolean {
    return include.has(key);
}

function selectedTextPayload(
    context: BoundDesktopContext,
    include: Set<DesktopContextInclude>
): DesktopContextToolSelectedTextPayload | undefined {
    if (!has(include, 'selected_text.summary') && !has(include, 'selected_text.full_text')) {
        return undefined;
    }

    const selectedText = context.selectedText;
    return {
        available: selectedText.available,
        source: selectedText.source,
        textLength: selectedText.textLength,
        truncated: selectedText.truncated,
        reason: selectedText.reason ?? null,
        ...(has(include, 'selected_text.full_text') ? { fullText: selectedText.text } : {}),
    };
}

function clipboardPayload(
    context: BoundDesktopContext,
    include: Set<DesktopContextInclude>
): DesktopContextToolClipboardPayload | undefined {
    if (!has(include, 'clipboard.summary') && !has(include, 'clipboard.full_text')) {
        return undefined;
    }

    const clipboard = context.clipboard;
    return {
        available: clipboard.available,
        snapshotId: clipboard.snapshotId,
        observedAt: clipboard.observedAt,
        textSummary: clipboard.textSummary,
        textLength: clipboard.textLength,
        imageCount: clipboard.imageCount,
        fileCount: clipboard.fileCount,
        reason: clipboard.reason ?? null,
        ...(has(include, 'clipboard.full_text') ? { fullText: clipboard.text } : {}),
    };
}

function screenshotPayload(
    context: BoundDesktopContext,
    include: Set<DesktopContextInclude>
): DesktopContextToolScreenshotPayload | undefined {
    if (!has(include, 'screenshot.metadata') && !has(include, 'screenshot.image')) {
        return undefined;
    }

    const screenshot = context.screenshot;
    return {
        available: screenshot.available,
        mimeType: screenshot.mimeType,
        width: screenshot.width,
        height: screenshot.height,
        target: screenshot.target,
        persisted: screenshot.persisted,
        capturedAt: screenshot.capturedAt,
        reason: screenshot.reason ?? null,
        ...(has(include, 'screenshot.image') ? { path: screenshot.path } : {}),
    };
}

export function buildDesktopContextToolPayload(
    context: BoundDesktopContext,
    request?: DesktopContextToolRequest
): DesktopContextToolAvailablePayload;
export function buildDesktopContextToolPayload(
    context: null | undefined,
    request?: DesktopContextToolRequest
): DesktopContextToolUnavailablePayload;
export function buildDesktopContextToolPayload(
    context: BoundDesktopContext | null | undefined,
    request?: DesktopContextToolRequest
): DesktopContextToolPayload;
export function buildDesktopContextToolPayload(
    context: BoundDesktopContext | null | undefined,
    request: DesktopContextToolRequest = {}
): DesktopContextToolPayload {
    if (!context) {
        return {
            available: false,
            reason: 'No desktop context capsule is bound to this turn.',
        };
    }

    const include = normalizeInclude(request.include);
    const selectedText = selectedTextPayload(context, include);
    const clipboard = clipboardPayload(context, include);
    const screenshot = screenshotPayload(context, include);

    return {
        available: true,
        capsuleId: context.id,
        scope: request.scope ?? 'current',
        capturedAt: context.capturedAt,
        boundAt: context.boundAt,
        ...(has(include, 'summary') ? { summary: context.summary } : {}),
        ...(has(include, 'active_window') ? { activeWindow: context.activeWindow } : {}),
        ...(selectedText ? { selectedText } : {}),
        ...(clipboard ? { clipboard } : {}),
        ...(screenshot ? { screenshot } : {}),
        ...(has(include, 'capabilities') ? { capabilities: context.capabilities } : {}),
        ...(has(include, 'redactions') ? { redactions: context.redactions } : {}),
    };
}

export function buildDesktopContextPromptMetadata(
    context: BoundDesktopContext | null | undefined
): DesktopContextPromptMetadata | undefined {
    if (!context) {
        return undefined;
    }

    return {
        capsuleId: context.id,
        capturedAt: context.capturedAt,
        boundAt: context.boundAt,
        summary: context.summary,
        activeWindowTitle: context.activeWindow?.title ?? null,
        selectedTextLength: context.selectedText.textLength,
        clipboardTextLength: context.clipboard.textLength,
        screenshotPersisted: context.screenshot.persisted,
        capabilities: context.capabilities,
    };
}
