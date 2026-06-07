// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export type PopupPositionStrategy = 'window-edge-left' | 'session-history-adaptive';

interface PopupManifestItem {
    id: string;
    width: number;
    height: number;
    minHeight?: number;
    positionStrategy: PopupPositionStrategy;
}

export const POPUP_MANIFEST = {
    modelDropdown: {
        id: 'model-dropdown-popup',
        width: 320,
        height: 384,
        positionStrategy: 'window-edge-left',
    },
    sessionHistory: {
        id: 'session-history-popup',
        width: 320,
        height: 384,
        positionStrategy: 'session-history-adaptive',
    },
} as const satisfies Record<string, PopupManifestItem>;

export const POPUP_MANIFEST_ENTRIES = Object.values(POPUP_MANIFEST);

export type PopupManifestEntry = (typeof POPUP_MANIFEST)[keyof typeof POPUP_MANIFEST];
export type PopupType = PopupManifestEntry['id'];
