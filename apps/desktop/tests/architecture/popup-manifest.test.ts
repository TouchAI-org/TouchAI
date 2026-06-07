import { describe, expect, it } from 'vitest';

import { POPUP_MANIFEST_ENTRIES } from '@/contracts/popupManifest';
import { getPopupComponent } from '@/views/PopupView/popupComponents';

describe('popup manifest architecture contract', () => {
    it('keeps every manifest popup renderable by the popup view component registry', () => {
        for (const popup of POPUP_MANIFEST_ENTRIES) {
            expect(getPopupComponent(popup.id), popup.id).toBeDefined();
        }
    });

    it('keeps popup ids unique and serializable for cross-window transport', () => {
        const ids = POPUP_MANIFEST_ENTRIES.map((popup) => popup.id);

        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(
            expect.arrayContaining(['model-dropdown-popup', 'session-history-popup'])
        );
        expect(
            POPUP_MANIFEST_ENTRIES.map((popup) => ({
                id: popup.id,
                width: popup.width,
                height: popup.height,
                minHeight: 'minHeight' in popup ? popup.minHeight : undefined,
                positionStrategy: popup.positionStrategy,
            }))
        ).toEqual([
            {
                id: 'model-dropdown-popup',
                width: 320,
                height: 384,
                minHeight: undefined,
                positionStrategy: 'window-edge-left',
            },
            {
                id: 'session-history-popup',
                width: 320,
                height: 384,
                minHeight: undefined,
                positionStrategy: 'session-history-adaptive',
            },
        ]);
    });
});
