import { inject, type InjectionKey } from 'vue';

export interface MainToolsStartupApi {
    autoConnectMcp(): Promise<void>;
}

export const mainToolsStartupApiKey: InjectionKey<MainToolsStartupApi> =
    Symbol('touchai.tools.startup');

export function useMainToolsStartupApi(): MainToolsStartupApi {
    const api = inject(mainToolsStartupApiKey);
    if (!api) throw new Error('MAIN_EXECUTION_HOST_REQUIRED');
    return api;
}
