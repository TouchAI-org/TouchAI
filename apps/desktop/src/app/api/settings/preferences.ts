import { inject, type InjectionKey } from 'vue';

import type { SettingsApi } from '@/modules/settings/public';

export * from '@/modules/settings/public';
export const settingsApiKey: InjectionKey<SettingsApi> = Symbol('touchai.settings.preferences');

export function useSettingsApi(): SettingsApi {
    const api = inject(settingsApiKey);
    if (!api) throw new Error('SETTINGS_CLIENT_UNAVAILABLE');
    return api;
}
