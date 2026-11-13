import { describe, expect, it } from 'vitest';

import {
    hasSettingsDraftChanges,
    mergeSettingsDraft,
} from '@/views/SettingsView/settingsDraftSync';

describe('user edits browser settings while another window refreshes', () => {
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
