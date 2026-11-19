import { getSettingValue } from '@/database/queries/settings';

import { SEARCH_SETTINGS_KEY } from '../builtin/web-search/configuration';

export function readWebSearchConfiguration(): Promise<string | null> {
    return getSettingValue({ key: SEARCH_SETTINGS_KEY });
}
