import { afterEach } from 'vitest';

import * as messages from '@/app/api/settings/messages';
import { setLocale } from '@/i18n';
import {
    createSettingsPersistence,
    SettingsService,
    type SettingsServiceOptions,
} from '@/modules/settings';
import { log } from '@/platform/diagnostics';
import { native } from '@/platform/native';

const hosts: SettingsService[] = [];
afterEach(() => {
    for (const host of hosts.splice(0)) host.dispose();
});

/** Module tests substitute OS/window ports, not the preferences engine or its storage queries. */
export function createSettingsTestHost(
    options: Pick<SettingsServiceOptions, 'transport'> & Partial<SettingsServiceOptions>
): SettingsService {
    const host = new SettingsService({
        persistence: createSettingsPersistence(),
        messages,
        diagnostics: log,
        effects: {
            isAutostartEnabled: native.autostart.isAutostartEnabled,
            setAutostart: (enabled) =>
                enabled ? native.autostart.enableAutostart() : native.autostart.disableAutostart(),
            registerGlobalShortcut: native.shortcut.registerGlobalShortcut,
            setSearchWindowDefaults: async (size) => {
                await native.window.setSearchWindowDefaults(size);
            },
            applyLanguage: setLocale,
        },
        ...options,
    });
    hosts.push(host);
    return host;
}
