import { inject, type InjectionKey } from 'vue';

import { AiError, AiErrorCode } from '@/app/api/agent/errors';
import type { ModelMetadataRefreshResult } from '@/modules/models/public';

export type { ModelMetadataRefreshResult } from '@/modules/models/public';

export interface ModelMetadataApi {
    refresh(options?: {
        force?: boolean;
        signal?: AbortSignal;
    }): Promise<ModelMetadataRefreshResult>;
    isMissing(options?: { signal?: AbortSignal }): Promise<boolean>;
    readLastUpdatedAt(options?: { signal?: AbortSignal }): Promise<string | null>;
}

export const modelMetadataApiKey: InjectionKey<ModelMetadataApi> =
    Symbol('touchai.models.metadata');

export function useModelMetadataApi(): ModelMetadataApi {
    const api = inject(modelMetadataApiKey);
    if (!api) throw new AiError(AiErrorCode.SERVICE_UNAVAILABLE);
    return api;
}
