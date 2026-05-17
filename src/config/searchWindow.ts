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

export function resolveSearchWindowDefaultSize(
    preset: SearchWindowSizePreset
): SearchWindowDefaultSize {
    return SearchWindowSizePreset[preset];
}
