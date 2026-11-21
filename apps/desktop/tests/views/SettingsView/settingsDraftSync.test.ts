import { createTestWindowPresentation } from '@tests/utils/windowPresentation';
import { beforeEach as beforePresentation } from 'vitest';
import { describe, expect, it } from 'vitest';

import {
    hasSettingsDraftChanges,
    mergeSettingsDraft,
} from '@/views/SettingsView/settingsDraftSync';

describe('user edits browser settings while another window refreshes', () => {
    it('user restores an optional default while retaining another window changes', () => {
        const baseline: { enabled?: boolean; timeout: number } = { enabled: false, timeout: 100 };
        const draft = { timeout: 100 };
        const incoming = { enabled: false, timeout: 200 };

        const merged = mergeSettingsDraft(baseline, draft, incoming);

        expect(merged).toEqual({ timeout: 200 });
        expect(Object.hasOwn(merged, 'enabled')).toBe(false);
        expect(hasSettingsDraftChanges(merged, { timeout: 200 })).toBe(false);
    });

    it('user treats equal domain lists as unchanged when another window refreshes settings', () => {
        const baseline = {
            allowedDomains: ['example.test', 'docs.test'],
            blockedDomains: ['ads.test'],
            defaultMode: 'visible',
        };
        const draft = {
            allowedDomains: ['example.test', 'docs.test'],
            blockedDomains: ['ads.test'],
            defaultMode: 'visible',
        };
        const incoming = {
            allowedDomains: ['incoming.test'],
            blockedDomains: [],
            defaultMode: 'headless',
        };

        expect(hasSettingsDraftChanges(baseline, draft)).toBe(false);
        expect(mergeSettingsDraft(baseline, draft, incoming)).toEqual(incoming);
    });

    it('user keeps an edited domain list when another window refreshes settings', () => {
        const baseline = {
            allowedDomains: ['example.test'],
            blockedDomains: ['ads.test'],
            defaultMode: 'visible',
        };
        const draft = {
            allowedDomains: ['example.test', 'docs.test'],
            blockedDomains: ['ads.test'],
            defaultMode: 'visible',
        };
        const incoming = {
            allowedDomains: ['incoming.test'],
            blockedDomains: [],
            defaultMode: 'headless',
        };

        expect(hasSettingsDraftChanges(baseline, draft)).toBe(true);
        expect(mergeSettingsDraft(baseline, draft, incoming)).toEqual({
            allowedDomains: ['example.test', 'docs.test'],
            blockedDomains: [],
            defaultMode: 'headless',
        });
    });
});

beforePresentation(async () => {
    (await createTestWindowPresentation('settings')).install();
});
