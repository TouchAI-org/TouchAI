import { inject, type InjectionKey } from 'vue';

import type { SearchApi } from '@/modules/search/public';

export type * from '@/modules/search/public';
export type { FileSearchItem as QuickShortcutItem } from '@/modules/search/public';
export { fileSearchItem, filterSkillCandidates, skillSearchItem } from '@/modules/search/public';
export const searchApiKey: InjectionKey<SearchApi> = Symbol('touchai.search.queries');

export function useSearchApi(): SearchApi {
    const api = inject(searchApiKey);
    if (!api) throw new Error('SEARCH_HOST_UNAVAILABLE');
    return api;
}
