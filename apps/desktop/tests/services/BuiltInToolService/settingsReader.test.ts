import { afterEach, describe, expect, it, vi } from 'vitest';

import { readEffectiveSettingValue } from '@/services/BuiltInToolService/settingsReader';
import { setActiveSettingsService, type SettingsService } from '@/services/SettingsService';

afterEach(() => {
    setActiveSettingsService(null);
});

describe('user reads a setting through the active settings owner', () => {
    it('user sees initialization complete before the effective value is read', async () => {
        const calls: string[] = [];
        const service = {
            initialize: vi.fn(async () => {
                calls.push('initialize');
            }),
            readEffectiveValue: vi.fn(async () => {
                calls.push('read');
                return '{"enabled":true}';
            }),
        };
        setActiveSettingsService(service as unknown as SettingsService);

        await expect(readEffectiveSettingValue('browser_settings')).resolves.toBe(
            '{"enabled":true}'
        );
        expect(calls).toEqual(['initialize', 'read']);
    });
});
