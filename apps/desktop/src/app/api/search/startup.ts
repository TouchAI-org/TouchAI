import { inject, type InjectionKey } from 'vue';

export interface StartupNoticesApi {
    consume(): Promise<void>;
}
export const startupNoticesApiKey: InjectionKey<StartupNoticesApi> = Symbol(
    'touchai.search.startup-notices'
);
export function useStartupNoticesApi(): StartupNoticesApi {
    const api = inject(startupNoticesApiKey);
    if (!api) throw new Error('STARTUP_NOTICES_UNAVAILABLE');
    return api;
}
