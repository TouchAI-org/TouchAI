// Copyright (c) 2026. 鍗冭瘹. Licensed under GPL v3

import { getSettingValue, setSetting } from '@database/queries';
import type { GeneralSettingKey, SettingsGeneralUpdatedEvent } from '@services/EventService';
import { AppEvent, eventService } from '@services/EventService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import {
    type AppUpdateChannel,
    DEFAULT_APP_UPDATE_CHANNEL,
    normalizeAppUpdateChannel,
} from '@/config/appUpdate';
import {
    BROWSER_SETTINGS_KEY,
    type BrowserSettingsConfig,
    DEFAULT_BROWSER_SETTINGS,
    parseBrowserSettingsConfig,
    serializeBrowserSettingsConfig,
} from '@/config/browserSettings';
import {
    DEFAULT_SEARCH_SETTINGS,
    SEARCH_SETTINGS_KEY,
    type SearchSettingsConfig,
    parseSearchSettingsConfig,
    serializeSearchSettingsConfig,
} from '@/config/searchSettings';
import {
    DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
    resolveSearchWindowDefaultSize,
    type SearchWindowDefaultSize,
    type SearchWindowSizePreset,
    SearchWindowSizePreset as SearchWindowSizePresets,
} from '@/config/searchWindow';
import { type AppLocale, normalizeLocale, resolveFirstLaunchLocale, setLocale } from '@/i18n';
import { z } from '@/utils/zod';

export type OutputScrollBehavior = 'follow_output' | 'stay_position' | 'jump_to_top';

export interface GeneralSettingsData {
    globalShortcut: string;
    startOnBoot: boolean;
    startMinimized: boolean;
    outputScrollBehavior: OutputScrollBehavior;
    searchWindowSizePreset: SearchWindowSizePreset;
    searchWindowDefaultSize: SearchWindowDefaultSize;
    language: AppLocale;
    appUpdateChannel: AppUpdateChannel;
    appUpdateAutoCheck: boolean;
    appUpdateLastCheckedAt: string | null;
    browserSettings: BrowserSettingsConfig;
    searchSettings: SearchSettingsConfig;
}

const DEFAULT_GENERAL_SETTINGS: GeneralSettingsData = {
    globalShortcut: 'Alt+Space',
    startOnBoot: false,
    startMinimized: true,
    outputScrollBehavior: 'follow_output',
    searchWindowSizePreset: DEFAULT_SEARCH_WINDOW_SIZE_PRESET,
    searchWindowDefaultSize: resolveSearchWindowDefaultSize(DEFAULT_SEARCH_WINDOW_SIZE_PRESET),
    language: 'zh-CN',
    appUpdateChannel: DEFAULT_APP_UPDATE_CHANNEL,
    appUpdateAutoCheck: true,
    appUpdateLastCheckedAt: null,
    browserSettings: DEFAULT_BROWSER_SETTINGS,
    searchSettings: DEFAULT_SEARCH_SETTINGS,
};

function createDefaultGeneralSettings(): GeneralSettingsData {
    return {
        ...DEFAULT_GENERAL_SETTINGS,
        searchWindowDefaultSize: {
            ...DEFAULT_GENERAL_SETTINGS.searchWindowDefaultSize,
        },
        browserSettings: parseBrowserSettingsConfig(
            serializeBrowserSettingsConfig(DEFAULT_GENERAL_SETTINGS.browserSettings)
        ),
        searchSettings: parseSearchSettingsConfig(
            serializeSearchSettingsConfig(DEFAULT_GENERAL_SETTINGS.searchSettings)
        ),
    };
}

type GeneralSettingValue = SettingsGeneralUpdatedEvent['value'];

const outputScrollBehaviorSchema = z.enum(['follow_output', 'stay_position', 'jump_to_top']);
const searchWindowSizePresetSchema = z.enum(
    Object.keys(SearchWindowSizePresets) as [SearchWindowSizePreset, ...SearchWindowSizePreset[]]
);

export const useSettingsStore = defineStore('settings', () => {
    const settings = ref<GeneralSettingsData>(createDefaultGeneralSettings());
    const initialized = ref(false);
    const loading = ref(false);
    const windowLabel = ref('unknown');

    const instanceId = crypto.randomUUID();
    let initializePromise: Promise<void> | null = null;
    let unlistenSettingsUpdated: (() => void) | null = null;

    function normalizeOutputScrollBehavior(value: string | null): OutputScrollBehavior {
        const result = outputScrollBehaviorSchema.safeParse(value);
        if (result.success) {
            return result.data;
        }
        return DEFAULT_GENERAL_SETTINGS.outputScrollBehavior;
    }

    function normalizeSearchWindowSizePreset(value: string | null): SearchWindowSizePreset {
        const result = searchWindowSizePresetSchema.safeParse(value);
        if (result.success) {
            return result.data;
        }
        return DEFAULT_GENERAL_SETTINGS.searchWindowSizePreset;
    }

    function applyLanguage(value: unknown): void {
        settings.value.language = normalizeLocale(value);
        setLocale(settings.value.language);
    }

    function resolvePersistedLanguage(language: string | null): AppLocale {
        if (language === null) {
            return resolveFirstLaunchLocale();
        }

        return normalizeLocale(language);
    }

    function applySearchWindowSizePreset(preset: SearchWindowSizePreset): void {
        settings.value.searchWindowSizePreset = preset;
        settings.value.searchWindowDefaultSize = {
            ...resolveSearchWindowDefaultSize(preset),
        };
    }

    function cloneSettingsSnapshot(): GeneralSettingsData {
        return {
            ...settings.value,
            searchWindowDefaultSize: {
                ...settings.value.searchWindowDefaultSize,
            },
            browserSettings: parseBrowserSettingsConfig(
                serializeBrowserSettingsConfig(settings.value.browserSettings)
            ),
            searchSettings: parseSearchSettingsConfig(
                serializeSearchSettingsConfig(settings.value.searchSettings)
            ),
        };
    }

    function applySetting(key: GeneralSettingKey, value: GeneralSettingValue): void {
        switch (key) {
            case 'global_shortcut':
                settings.value.globalShortcut = String(
                    value || DEFAULT_GENERAL_SETTINGS.globalShortcut
                );
                break;
            case 'start_on_boot':
                settings.value.startOnBoot =
                    typeof value === 'boolean' ? value : String(value) === 'true';
                break;
            case 'start_minimized':
                settings.value.startMinimized =
                    typeof value === 'boolean' ? value : String(value) === 'true';
                break;
            case 'output_scroll_behavior':
                settings.value.outputScrollBehavior = normalizeOutputScrollBehavior(String(value));
                break;
            case 'search_window_size_preset':
                applySearchWindowSizePreset(normalizeSearchWindowSizePreset(String(value)));
                break;
            case 'language':
                applyLanguage(value);
                break;
            case 'app_update_channel':
                settings.value.appUpdateChannel = normalizeAppUpdateChannel(value);
                break;
            case 'app_update_auto_check':
                settings.value.appUpdateAutoCheck =
                    typeof value === 'boolean' ? value : String(value) !== 'false';
                break;
            case 'app_update_last_checked_at':
                settings.value.appUpdateLastCheckedAt = value === null ? null : String(value);
                break;
            case 'browser_settings':
                settings.value.browserSettings = parseBrowserSettingsConfig(
                    typeof value === 'string' ? value : null
                );
                break;
            case 'search_settings':
                settings.value.searchSettings = parseSearchSettingsConfig(
                    typeof value === 'string' ? value : null
                );
                break;
            default:
                break;
        }
    }

    function serializeSetting(key: GeneralSettingKey): string {
        switch (key) {
            case 'global_shortcut':
                return settings.value.globalShortcut;
            case 'start_on_boot':
                return String(settings.value.startOnBoot);
            case 'start_minimized':
                return String(settings.value.startMinimized);
            case 'output_scroll_behavior':
                return settings.value.outputScrollBehavior;
            case 'search_window_size_preset':
                return settings.value.searchWindowSizePreset;
            case 'language':
                return settings.value.language;
            case 'app_update_channel':
                return settings.value.appUpdateChannel;
            case 'app_update_auto_check':
                return String(settings.value.appUpdateAutoCheck);
            case 'app_update_last_checked_at':
                return settings.value.appUpdateLastCheckedAt ?? '';
            case 'browser_settings':
                return serializeBrowserSettingsConfig(settings.value.browserSettings);
            case 'search_settings':
                return serializeSearchSettingsConfig(settings.value.searchSettings);
            default:
                return '';
        }
    }

    function payloadValueForEvent(key: GeneralSettingKey): GeneralSettingValue {
        switch (key) {
            case 'global_shortcut':
                return settings.value.globalShortcut;
            case 'start_on_boot':
                return settings.value.startOnBoot;
            case 'start_minimized':
                return settings.value.startMinimized;
            case 'output_scroll_behavior':
                return settings.value.outputScrollBehavior;
            case 'search_window_size_preset':
                return settings.value.searchWindowSizePreset;
            case 'language':
                return settings.value.language;
            case 'app_update_channel':
                return settings.value.appUpdateChannel;
            case 'app_update_auto_check':
                return settings.value.appUpdateAutoCheck;
            case 'app_update_last_checked_at':
                return settings.value.appUpdateLastCheckedAt;
            case 'browser_settings':
                return serializeBrowserSettingsConfig(settings.value.browserSettings);
            case 'search_settings':
                return serializeSearchSettingsConfig(settings.value.searchSettings);
            default:
                return '';
        }
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
            const [
                globalShortcut,
                startOnBoot,
                startMinimized,
                outputScroll,
                searchWindowSizePreset,
                language,
                appUpdateChannel,
                appUpdateAutoCheck,
                appUpdateLastCheckedAt,
                browserSettings,
                searchSettings,
            ] = await Promise.all([
                getSettingValue({ key: 'global_shortcut' }),
                getSettingValue({ key: 'start_on_boot' }),
                getSettingValue({ key: 'start_minimized' }),
                getSettingValue({ key: 'output_scroll_behavior' }),
                getSettingValue({ key: 'search_window_size_preset' }),
                getSettingValue({ key: 'language' }),
                getSettingValue({ key: 'app_update_channel' }),
                getSettingValue({ key: 'app_update_auto_check' }),
                getSettingValue({ key: 'app_update_last_checked_at' }),
                getSettingValue({ key: BROWSER_SETTINGS_KEY }),
                getSettingValue({ key: SEARCH_SETTINGS_KEY }),
            ]);

            settings.value.globalShortcut =
                globalShortcut || DEFAULT_GENERAL_SETTINGS.globalShortcut;
            settings.value.startOnBoot =
                startOnBoot === null
                    ? DEFAULT_GENERAL_SETTINGS.startOnBoot
                    : startOnBoot === 'true';
            settings.value.startMinimized =
                startMinimized === null
                    ? DEFAULT_GENERAL_SETTINGS.startMinimized
                    : startMinimized === 'true';
            settings.value.outputScrollBehavior = normalizeOutputScrollBehavior(outputScroll);
            applySearchWindowSizePreset(normalizeSearchWindowSizePreset(searchWindowSizePreset));
            applyLanguage(resolvePersistedLanguage(language));
            settings.value.appUpdateChannel = normalizeAppUpdateChannel(appUpdateChannel);
            settings.value.appUpdateAutoCheck =
                appUpdateAutoCheck === null
                    ? DEFAULT_GENERAL_SETTINGS.appUpdateAutoCheck
                    : appUpdateAutoCheck !== 'false';
            settings.value.appUpdateLastCheckedAt = appUpdateLastCheckedAt || null;
            settings.value.browserSettings = parseBrowserSettingsConfig(browserSettings);
            settings.value.searchSettings = parseSearchSettingsConfig(searchSettings);

            await Promise.allSettled([
                persistDefaultIfMissing('global_shortcut', globalShortcut),
                persistDefaultIfMissing('start_on_boot', startOnBoot),
                persistDefaultIfMissing('start_minimized', startMinimized),
                persistDefaultIfMissing('output_scroll_behavior', outputScroll),
                persistDefaultIfMissing('search_window_size_preset', searchWindowSizePreset),
                persistDefaultIfMissing('language', language),
                persistDefaultIfMissing('app_update_channel', appUpdateChannel),
                persistDefaultIfMissing('app_update_auto_check', appUpdateAutoCheck),
                persistDefaultIfMissing(BROWSER_SETTINGS_KEY, browserSettings),
                persistDefaultIfMissing(SEARCH_SETTINGS_KEY, searchSettings),
            ]);
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
        if (key === 'language') {
            const normalizedLanguage = normalizeLocale(value);
            await setSetting({ key, value: normalizedLanguage });
            applyLanguage(normalizedLanguage);
            if (broadcast) {
                await broadcastUpdate(key);
            }
            return;
        }

        const previousSettings = cloneSettingsSnapshot();
        applySetting(key, value);
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
        await updateSetting('search_window_size_preset', normalizeSearchWindowSizePreset(preset));
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
        await updateSetting(BROWSER_SETTINGS_KEY, serializeBrowserSettingsConfig(config));
    }

    async function updateSearchSettings(config: SearchSettingsConfig) {
        await updateSetting(SEARCH_SETTINGS_KEY, serializeSearchSettingsConfig(config));
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
