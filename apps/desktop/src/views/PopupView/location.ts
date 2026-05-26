// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { PopupType } from '@services/PopupService';

interface LocationLike {
    hash: string;
    search: string;
}

export function getPopupTypeFromLocation(location: LocationLike): PopupType | null {
    const hashQuery = location.hash.includes('?')
        ? location.hash.slice(location.hash.indexOf('?'))
        : '';
    const typeFromHash = new URLSearchParams(hashQuery).get('type');
    if (typeFromHash) {
        return typeFromHash as PopupType;
    }

    const typeFromSearch = new URLSearchParams(location.search).get('type');
    return typeFromSearch ? (typeFromSearch as PopupType) : null;
}
