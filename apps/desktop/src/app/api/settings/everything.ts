import { inject, type InjectionKey } from 'vue';

import type { QuickSearchStatus } from '@/platform/native/quickSearch';
import { quickSearch } from '@/platform/native/quickSearch';

export type { QuickSearchStatus } from '@/platform/native/quickSearch';

export interface EverythingSetupApi {
    getStatus(): Promise<QuickSearchStatus>;
    prepareIndex(force?: boolean): Promise<void>;
    installEverything(): Promise<void>;
}

export const everythingSetupApiKey: InjectionKey<EverythingSetupApi> = Symbol(
    'touchai.settings.everything'
);

export const everythingSetupApi: EverythingSetupApi = Object.freeze({
    getStatus: () => quickSearch.getStatus(),
    prepareIndex: (force = false) => quickSearch.prepareIndex(force),
    installEverything: () => quickSearch.installEverything(),
});

export function useEverythingSetupApi(): EverythingSetupApi {
    return inject(everythingSetupApiKey, everythingSetupApi);
}
