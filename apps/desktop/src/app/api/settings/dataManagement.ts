import { inject, type InjectionKey } from 'vue';

import type { DataManagementApi } from '@/app/workflows/data-management/contracts';
import { DataManagementError } from '@/app/workflows/data-management/contracts';

export type {
    DataManagementApi,
    DataStats,
    ImportMode,
    ProgressCallback,
} from '@/app/workflows/data-management/contracts';
export {
    DataManagementError,
    isDatabaseBackupCancelledError,
} from '@/app/workflows/data-management/contracts';
export const dataManagementApiKey: InjectionKey<DataManagementApi> = Symbol(
    'touchai.settings.data-management'
);
export function useDataManagementApi(): DataManagementApi {
    const api = inject(dataManagementApiKey);
    if (!api) throw new DataManagementError('DATA_MANAGEMENT_UNAVAILABLE');
    return api;
}
