import { describe, expect, it } from 'vitest';

import router from '@/router';

describe('router', () => {
    it('builds auxiliary window routes with hash-based hrefs', () => {
        expect(router.resolve({ name: 'Settings' }).href).toBe('#/settings');
        expect(router.resolve({ name: 'TrayMenu' }).href).toBe('#/tray-menu');
        expect(
            router.resolve({
                name: 'Popup',
                query: { type: 'model-dropdown-popup' },
            }).href
        ).toBe('#/popup?type=model-dropdown-popup');
    });
});
