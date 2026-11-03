// Store-facing barrel. Pure settings policy/DTO/default/serialization is owned by
// services/SettingsService/domain and re-exported here for existing call sites; only the
// Vue-flavoured computed binding helper lives on the store side.
import {
    GENERAL_SETTING_COMPUTED_BINDINGS,
    type GeneralSettingsData,
    type OutputScrollBehavior,
} from '@services/SettingsService/domain/definitions';
import type { BrowserSettingsConfig } from '@services/SettingsService/domain/sections/browser';
import type { SearchSettingsConfig } from '@services/SettingsService/domain/sections/search';
import { computed, type ComputedRef, type Ref } from 'vue';

import type { AppUpdateChannel } from '@/config/appUpdate';
import type { AnimationSpeed } from '@/config/motion';
import type { SearchKeybindings } from '@/config/searchKeybindings';
import type { SearchWindowDefaultSize, SearchWindowSizePreset } from '@/config/searchWindow';
import type { AppLocale } from '@/i18n/locales';

export * from '@services/SettingsService/domain';

export interface GeneralSettingsComputedRefs {
    animationSpeed: ComputedRef<AnimationSpeed>;
    automaticallyReduceMotion: ComputedRef<boolean>;
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
