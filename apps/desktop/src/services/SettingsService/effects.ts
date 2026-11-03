// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import type { SearchWindowDefaultSize } from '@/config/searchWindow';
import { type AppLocale, setLocale } from '@/i18n';

/**
 * Host side effects the settings owner performs around a persisted commit. Kept behind
 * an interface so native/OS boundaries are mocked in tests and the mutation pipeline stays
 * deterministic.
 */
export interface SettingsEffects {
    isAutostartEnabled(): Promise<boolean>;
    setAutostart(enabled: boolean): Promise<void>;
    registerGlobalShortcut(shortcut: string): Promise<void>;
    setSearchWindowDefaults(size: SearchWindowDefaultSize): Promise<void>;
    applyLanguage(locale: AppLocale): void;
}

export function createDefaultSettingsEffects(): SettingsEffects {
    return {
        isAutostartEnabled: () => native.autostart.isAutostartEnabled(),
        setAutostart: (enabled) =>
            enabled ? native.autostart.enableAutostart() : native.autostart.disableAutostart(),
        registerGlobalShortcut: (shortcut) => native.shortcut.registerGlobalShortcut(shortcut),
        setSearchWindowDefaults: async (size) => {
            await native.window.setSearchWindowDefaults(size);
        },
        applyLanguage: (locale) => {
            setLocale(locale);
        },
    };
}
