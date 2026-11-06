// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    type BrowserSettingsConfig,
    GENERAL_SETTING_COMPUTED_BINDINGS,
    type GeneralSettingsData,
    type OutputScrollBehavior,
    type SearchSettingsConfig,
} from '@services/SettingsService/domain';
import { computed, type ComputedRef, type Ref } from 'vue';

import type { AppUpdateChannel } from '@/config/appUpdate';
import type { SearchKeybindings } from '@/config/searchKeybindings';
import type { SearchWindowDefaultSize, SearchWindowSizePreset } from '@/config/searchWindow';
import type { AppLocale } from '@/i18n/locales';

export interface GeneralSettingsComputedRefs {
    outputScrollBehavior: ComputedRef<OutputScrollBehavior>;
    globalShortcut: ComputedRef<string>;
    searchKeybindings: ComputedRef<SearchKeybindings>;
    searchWindowSizePreset: ComputedRef<SearchWindowSizePreset>;
    searchWindowDefaultSize: ComputedRef<SearchWindowDefaultSize>;
    language: ComputedRef<AppLocale>;
    appUpdateChannel: ComputedRef<AppUpdateChannel>;
    appUpdateAutoCheck: ComputedRef<boolean>;
    appUpdateLastCheckedAt: ComputedRef<string | null>;
    usageDetailRetentionDays: ComputedRef<number>;
    browserSettings: ComputedRef<BrowserSettingsConfig>;
    searchSettings: ComputedRef<SearchSettingsConfig>;
}

export function createGeneralSettingsComputedRefs(
    settings: Ref<GeneralSettingsData>
): GeneralSettingsComputedRefs {
    const refs: Record<string, ComputedRef<unknown>> = {};
    for (const binding of GENERAL_SETTING_COMPUTED_BINDINGS) {
        refs[binding.exposedName] = computed(() => settings.value[binding.stateKey]);
    }
    return refs as unknown as GeneralSettingsComputedRefs;
}
