import { getSettingValue, getSettingValues, setSetting } from '@database/queries/settings';

import type { SettingsPersistence } from './contracts/host';

/** Keep the shipped settings reader/writer and native transaction semantics. */
export function createSettingsPersistence(): SettingsPersistence {
    return {
        read: (key) => getSettingValue({ key }),
        readMany: (keys) => getSettingValues({ keys: [...keys] }),
        async write(key, value) {
            await setSetting({ key, value });
        },
    };
}
