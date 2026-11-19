import { inject, type InjectionKey } from 'vue';

import type { UpdatePreferencesApi, UpdatesApi } from './contracts';

export type * from './contracts';
export const updatesApiKey: InjectionKey<UpdatesApi> = Symbol('touchai.updates');
export const updatePreferencesApiKey: InjectionKey<UpdatePreferencesApi> = Symbol(
    'touchai.updates.preferences'
);
export function useUpdatesApi(): UpdatesApi {
    const api = inject(updatesApiKey);
    if (!api) throw new Error('UPDATES_UNAVAILABLE');
    return api;
}
export function useUpdatePreferencesApi(): UpdatePreferencesApi {
    const api = inject(updatePreferencesApiKey);
    if (!api) throw new Error('UPDATES_UNAVAILABLE');
    return api;
}
