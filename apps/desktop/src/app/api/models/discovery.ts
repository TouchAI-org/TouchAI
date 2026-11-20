import type { ModelInfo } from '@touchai/models/contracts';
import { inject, type InjectionKey } from 'vue';

export interface ModelDiscoveryApi {
    listModels(providerId: number, options?: { signal?: AbortSignal }): Promise<ModelInfo[]>;
}

export const modelDiscoveryApiKey: InjectionKey<ModelDiscoveryApi> = Symbol(
    'touchai.models.discovery'
);

export function useModelDiscoveryApi(): ModelDiscoveryApi {
    const api = inject(modelDiscoveryApiKey);
    if (!api) throw new Error('MODEL_DISCOVERY_HOST_UNAVAILABLE');
    return api;
}
