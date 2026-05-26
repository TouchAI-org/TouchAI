import { describe, expect, it } from 'vitest';

import { getPopupTypeFromLocation } from '@/views/PopupView/location';

describe('getPopupTypeFromLocation', () => {
    it('reads popup type from a hash-based popup route', () => {
        expect(
            getPopupTypeFromLocation({
                hash: '#/popup?type=model-dropdown-popup',
                search: '',
            })
        ).toBe('model-dropdown-popup');
    });

    it('falls back to the search string for non-hash popup routes', () => {
        expect(
            getPopupTypeFromLocation({
                hash: '',
                search: '?type=session-history-popup',
            })
        ).toBe('session-history-popup');
    });

    it('returns null when the popup type is missing', () => {
        expect(
            getPopupTypeFromLocation({
                hash: '#/popup',
                search: '',
            })
        ).toBeNull();
    });
});
