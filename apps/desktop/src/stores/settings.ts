// Copyright (c) 2026. 鍗冭瘹. Licensed under GPL v3

import { getSettingValue, setSetting } from '@database/queries';
import type { GeneralSettingKey, SettingsGeneralUpdatedEvent } from '@services/EventService';
import { AppEvent, eventService } from '@services/EventService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { type AppUpdateChannel, normalizeAppUpdateChannel } from '@/config/appUpdate';
import {
    type BrowserSettingsConfig,
    serializeBrowserSettingsConfig,
} from '@/config/browserSettings';
import { type SearchSettingsConfig, serializeSearchSettingsConfig } from '@/config/searchSettings';
import { type SearchWindowSizePreset } from '@/config/searchWindow';
import { type AppLocale, normalizeLocale } from '@/i18n';

import {
    applyGeneralSettingValue,
    applyParsedGeneralSettingValue,
    applyPersistedGeneralSettingValue,
    cloneGeneralSettingsSnapshot,
    createDefaultGeneralSettings,
    GENERAL_SETTING_DEFINITIONS,
    type GeneralSettingsData,
    getGeneralSettingDefinition,
    getGeneralSettingEventValue,
    type OutputScrollBehavior,
    parseGeneralSettingUpdateValue,
    serializeGeneralSetting,
    serializeParsedGeneralSettingValue,
} from './settingsDefinitions';
export type { GeneralSettingsData, OutputScrollBehavior } from './settingsDefinitions';

type GeneralSettingValue = SettingsGeneralUpdatedEvent['value'];

export const useSettingsStore = defineStore('settings', () => {
    const settings = ref<GeneralSettingsData>(createDefaultGeneralSettings());
    const initialized = ref(false);
    const loading = ref(false);
    const windowLabel = ref('unknown');

    const instanceId = crypto.randomUUID();
    let initializePromise: Promise<void> | null = null;
    let unlistenSettingsUpdated: (() => void) | null = null;

    function cloneSettingsSnapshot(): GeneralSettingsData {
        return cloneGeneralSettingsSnapshot(settings.value);
    }

    function applySetting(key: GeneralSettingKey, value: GeneralSettingValue): void {
        applyGeneralSettingValue(settings.value, key, value);
    }

    function serializeSetting(key: GeneralSettingKey): string {
        return serializeGeneralSetting(settings.value, key);
    }

    function payloadValueForEvent(key: GeneralSettingKey): GeneralSettingValue {
        return getGeneralSettingEventValue(settings.value, key);
    }

    async function persistDefaultIfMissing(key: GeneralSettingKey, currentValue: string | null) {
        if (currentValue !== null) {
            return;
        }
        await setSetting({ key, value: serializeSetting(key) });
    }

    async function loadFromDatabase() {
        loading.value = true;
        try {
            const settingRows = await Promise.all(
                GENERAL_SETTING_DEFINITIONS.map((definition) =>
                    getSettingValue({ key: definition.key })
                )
            );
            GENERAL_SETTING_DEFINITIONS.forEach((definition, index) => {
                applyPersistedGeneralSettingValue(
                    settings.value,
                    definition.key,
                    settingRows[index] ?? null
                );
            });

            await Promise.allSettled(
                GENERAL_SETTING_DEFINITIONS.map((definition, index) =>
                    persistDefaultIfMissing(definition.key, settingRows[index] ?? null)
                )
            );
        } finally {
            loading.value = false;
        }
    }

    async function broadcastUpdate(key: GeneralSettingKey): Promise<void> {
        await eventService.emit(AppEvent.SETTINGS_GENERAL_UPDATED, {
            sourceId: instanceId,
            windowLabel: windowLabel.value,
            key,
            value: payloadValueForEvent(key),
        });
    }

    async function updateSetting(
        key: GeneralSettingKey,
        value: GeneralSettingValue,
        options: { broadcast?: boolean } = {}
    ): Promise<void> {
        const { broadcast = true } = options;
        const definition = getGeneralSettingDefinition(key);
        if (!definition) {
            return;
        }

        const parsedValue = parseGeneralSettingUpdateValue(key, value);
        if (definition.persistBeforeApply) {
            await setSetting({
                key,
                value: serializeParsedGeneralSettingValue(key, parsedValue),
            });
            applyParsedGeneralSettingValue(settings.value, key, parsedValue);
            if (broadcast) {
                await broadcastUpdate(key);
            }
            return;
        }

        const previousSettings = cloneSettingsSnapshot();
        applyParsedGeneralSettingValue(settings.value, key, parsedValue);
        try {
            await setSetting({ key, value: serializeSetting(key) });
        } catch (error) {
            settings.value = previousSettings;
            throw error;
        }
        if (broadcast) {
            await broadcastUpdate(key);
        }
    }

    async function initialize() {
        if (initialized.value) {
            return;
        }

        if (initializePromise) {
            await initializePromise;
            return;
        }

        initializePromise = (async () => {
            try {
                windowLabel.value = getCurrentWindow().label;
            } catch {
                windowLabel.value = 'unknown';
            }

            await loadFromDatabase();

            if (!unlistenSettingsUpdated) {
                unlistenSettingsUpdated = await eventService.on(
                    AppEvent.SETTINGS_GENERAL_UPDATED,
                    (payload) => {
                        if (payload.sourceId === instanceId) {
                            return;
                        }
                        applySetting(payload.key, payload.value);
                    }
                );
            }

            initialized.value = true;
        })();

        try {
            await initializePromise;
        } finally {
            initializePromise = null;
        }
    }

    async function dispose() {
        if (unlistenSettingsUpdated) {
            unlistenSettingsUpdated();
            unlistenSettingsUpdated = null;
        }
        initialized.value = false;
    }

    async function refresh() {
        await loadFromDatabase();
    }

    async function updateGlobalShortcut(shortcut: string) {
        await updateSetting('global_shortcut', shortcut);
    }

    async function updateStartOnBoot(enabled: boolean) {
        await updateSetting('start_on_boot', enabled);
    }

    async function updateStartMinimized(enabled: boolean) {
        await updateSetting('start_minimized', enabled);
    }

    async function updateOutputScrollBehavior(mode: OutputScrollBehavior) {
        await updateSetting('output_scroll_behavior', mode);
    }

    async function updateSearchWindowSizePreset(preset: SearchWindowSizePreset) {
        await updateSetting('search_window_size_preset', preset);
    }

    async function updateLanguage(language: AppLocale) {
        await updateSetting('language', normalizeLocale(language));
    }

    async function updateAppUpdateChannel(channel: AppUpdateChannel) {
        await updateSetting('app_update_channel', normalizeAppUpdateChannel(channel));
    }

    async function updateAppUpdateAutoCheck(enabled: boolean) {
        await updateSetting('app_update_auto_check', enabled);
    }

    async function updateAppUpdateLastCheckedAt(checkedAt: string | null) {
        await updateSetting('app_update_last_checked_at', checkedAt);
    }

    async function updateBrowserSettings(config: BrowserSettingsConfig) {
        await updateSetting('browser_settings', serializeBrowserSettingsConfig(config));
    }

    async function updateSearchSettings(config: SearchSettingsConfig) {
        await updateSetting('search_settings', serializeSearchSettingsConfig(config));
    }

    const outputScrollBehavior = computed(() => settings.value.outputScrollBehavior);
    const globalShortcut = computed(() => settings.value.globalShortcut);
    const searchWindowSizePreset = computed(() => settings.value.searchWindowSizePreset);
    const searchWindowDefaultSize = computed(() => settings.value.searchWindowDefaultSize);
    const language = computed(() => settings.value.language);
    const appUpdateChannel = computed(() => settings.value.appUpdateChannel);
    const appUpdateAutoCheck = computed(() => settings.value.appUpdateAutoCheck);
    const appUpdateLastCheckedAt = computed(() => settings.value.appUpdateLastCheckedAt);
    const browserSettings = computed(() => settings.value.browserSettings);
    const searchSettings = computed(() => settings.value.searchSettings);

    return {
        settings,
        initialized,
        loading,
        outputScrollBehavior,
        globalShortcut,
        searchWindowSizePreset,
        searchWindowDefaultSize,
        language,
        appUpdateChannel,
        appUpdateAutoCheck,
        appUpdateLastCheckedAt,
        browserSettings,
        searchSettings,
        initialize,
        dispose,
        refresh,
        updateGlobalShortcut,
        updateStartOnBoot,
        updateStartMinimized,
        updateOutputScrollBehavior,
        updateSearchWindowSizePreset,
        updateLanguage,
        updateAppUpdateChannel,
        updateAppUpdateAutoCheck,
        updateAppUpdateLastCheckedAt,
        updateBrowserSettings,
        updateSearchSettings,
    };
});
