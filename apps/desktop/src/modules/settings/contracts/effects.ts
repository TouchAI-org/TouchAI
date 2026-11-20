// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AppLocale } from '@/config/locales';
import type { SearchWindowDefaultSize } from '@/config/searchWindow';

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
