// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    type GeneralSettingKey,
    type GeneralSettingValue,
    getSettingsService,
} from '@services/SettingsService';

export type SettingsToolReader = ReturnType<typeof getSettingsService>;

/**
 * Initialize the active SettingsService and return it for a settings command.
 * Consumers must not read the settings database directly: the owner's committed
 * cache is the authoritative value shared by every window.
 */
export async function initializeSettingsService(): Promise<SettingsToolReader> {
    const settingsService = getSettingsService();
    await settingsService.initialize();
    return settingsService;
}

/** Read one effective value through the active SettingsService. */
export async function readEffectiveSettingValue(
    key: GeneralSettingKey
): Promise<GeneralSettingValue> {
    return (await initializeSettingsService()).readEffectiveValue(key);
}
