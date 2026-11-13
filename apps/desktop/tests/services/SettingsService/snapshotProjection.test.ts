import { describe, expect, it } from 'vitest';

import { createDefaultGeneralSettings } from '@/services/SettingsService/domain';
import { projectSettingsSnapshotFor as projectSnapshot } from '@/services/SettingsService/snapshotProjection';

describe('user receives only the settings a read-only window needs', () => {
    it('user sees the tray snapshot keep language and motion preferences only', () => {
        const source = createDefaultGeneralSettings();
        source.language = 'en-US';
        source.animationSpeed = 'faster';
        source.automaticallyReduceMotion = false;
        source.globalShortcut = 'Ctrl+Shift+Space';
        source.startMinimized = false;
        source.searchKeybindings['search.input.focus'] = 'Mod+9';
        source.searchSettings.providers.brave = {
            ...source.searchSettings.providers.brave,
            enabled: true,
            apiKey: 'tray-must-not-see-this-key',
        };
        source.browserSettings.enabled = false;
        source.browserSettings.browserDataPath = '/home/user/.private-browser-profile';

        const projected = projectSnapshot('tray-menu', source);
        const defaults = createDefaultGeneralSettings();

        expect(projected.language).toBe('en-US');
        expect(projected.animationSpeed).toBe('faster');
        expect(projected.automaticallyReduceMotion).toBe(false);
        expect(projected.globalShortcut).toBe(defaults.globalShortcut);
        expect(projected.startMinimized).toBe(defaults.startMinimized);
        expect(projected.searchKeybindings).toEqual(defaults.searchKeybindings);
        expect(projected.searchSettings).toEqual(defaults.searchSettings);
        expect(projected.browserSettings).toEqual(defaults.browserSettings);
        expect(JSON.stringify(projected)).not.toContain('tray-must-not-see-this-key');
        expect(JSON.stringify(projected)).not.toContain('.private-browser-profile');
    });

    it('user sees the settings window receive the complete snapshot', () => {
        const source = createDefaultGeneralSettings();
        source.globalShortcut = 'Ctrl+Shift+Space';
        source.searchSettings.providers.brave = {
            ...source.searchSettings.providers.brave,
            enabled: true,
            apiKey: 'settings-owner-config',
        };
        source.browserSettings.browserDataPath = '/home/user/.browser-profile';

        const projected = projectSnapshot('settings', source);

        expect(projected).toEqual(source);
        expect(projected.searchSettings.providers.brave.apiKey).toBe('settings-owner-config');
        expect(projected.browserSettings.browserDataPath).toBe('/home/user/.browser-profile');
    });
});
