import { describe, expect, it } from 'vitest';

import router from '@/router';

describe('user opens an auxiliary window', () => {
    it('user builds auxiliary window routes with hash-based hrefs', () => {
        expect(router.resolve({ name: 'Settings' }).href).toBe('#/settings');
        expect(router.resolve({ name: 'TrayMenu' }).href).toBe('#/tray-menu');
        expect(router.resolve({ name: 'ComputerUseGlow' }).href).toBe('#/computer-use-glow');
    });
});
