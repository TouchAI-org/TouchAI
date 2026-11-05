/**
 * `getPopupRenderer` maps a popup id to the Vue component that renders it. The
 * window view previously looked this up on the PopupService registry, which no
 * longer owns components; a wrong or missing mapping now has no other guard.
 */
import { describe, expect, it, vi } from 'vitest';

import { getPopupRenderer } from '@/views/PopupView/renderers';

vi.mock('@/views/PopupView/components/ModelDropdownPopup/index.vue', () => ({
    default: { name: 'ModelDropdownPopupStub' },
}));

vi.mock('@/views/PopupView/components/SessionHistoryPopover/index.vue', () => ({
    default: { name: 'SessionHistoryPopoverStub' },
}));

function rendererName(type: 'model-dropdown-popup' | 'session-history-popup'): string | undefined {
    return (getPopupRenderer(type) as { name?: string } | null)?.name;
}

describe('user opens a built-in popup window', () => {
    it('user sees the model dropdown rendered by the model dropdown component', () => {
        expect(rendererName('model-dropdown-popup')).toBe('ModelDropdownPopupStub');
    });

    it('user sees the session history rendered by the session history component', () => {
        expect(rendererName('session-history-popup')).toBe('SessionHistoryPopoverStub');
    });

    it('user sees each popup type map to a distinct renderer', () => {
        expect(getPopupRenderer('model-dropdown-popup')).not.toBe(
            getPopupRenderer('session-history-popup')
        );
    });
});
