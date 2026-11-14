// Copyright (c) 2026. 千诚. Licensed under GPL v3

export const SearchWindowSizePreset = {
    small: { width: 420, height: 60 },
    normal: { width: 750, height: 60 },
    large: { width: 938, height: 72 },
} as const;

export const SearchWindowHeightMode = {
    Auto: 'auto',
    ManualOverride: 'manual_override',
} as const;

// --- 派生类型 ---

export type SearchWindowSizePreset = keyof typeof SearchWindowSizePreset;
export type SearchWindowHeightMode =
    (typeof SearchWindowHeightMode)[keyof typeof SearchWindowHeightMode];
export interface SearchWindowDefaultSize {
    width: number;
    height: number;
}

// --- 默认值 ---

export const DEFAULT_SEARCH_WINDOW_SIZE_PRESET: SearchWindowSizePreset = 'normal';

/** Height of the expandable model / history / attachment toolbar. */
export const SEARCH_TOOLBAR_HEIGHT = 40;

/** Toolbar sequencing: the mat opens first, the toolbar follows. */
export const SEARCH_TOOLBAR_MOTION = {
    matDurationMs: 140,
    openDelayMs: 0,
    closeDelayMs: 320,
    matRetractDelayMs: 340,
} as const;

/** Intrinsic conversation cap used by the window geometry owner. */
export const SEARCH_CONVERSATION_AUTO_MAX_HEIGHT = 600;

/** Shared timing for the card, native position track, and QuickSearch handoff. */
export const SEARCH_SURFACE_MOTION = {
    durationMs: 320,
    easing: [0.4, 0, 0.2, 1] as const,
    revealDurationMs: 380,
    revealEasing: [0.22, 1, 0.36, 1] as const,
} as const;

export const SEARCH_SURFACE_EASING = `cubic-bezier(${SEARCH_SURFACE_MOTION.easing.join(', ')})`;
export const SEARCH_SURFACE_REVEAL_EASING = `cubic-bezier(${SEARCH_SURFACE_MOTION.revealEasing.join(', ')})`;

/** Shared timing for the in-window model/history overlays. */
export const SEARCH_OVERLAY_MOTION = {
    openDurationMs: 180,
    closeDurationMs: 150,
    enterOffsetPx: 4,
    enterScale: 0.97,
    closingScale: 0.99,
    easing: [0.22, 1, 0.36, 1] as const,
} as const;

export const SEARCH_OVERLAY_EASING = `cubic-bezier(${SEARCH_OVERLAY_MOTION.easing.join(', ')})`;

export function resolveSearchWindowDefaultSize(
    preset: SearchWindowSizePreset
): SearchWindowDefaultSize {
    return SearchWindowSizePreset[preset];
}
