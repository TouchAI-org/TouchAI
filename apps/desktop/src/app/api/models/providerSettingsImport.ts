import { inject, type InjectionKey } from 'vue';

import type { ProviderDriver } from '@/app/api/models/administration';

export interface ProviderImportCandidate {
    providerName: string;
    driver: Extract<
        ProviderDriver,
        'openai' | 'openai-compatible' | 'anthropic' | 'anthropic-compatible'
    >;
    apiEndpoint: string;
    modelId: string | null;
    apiKey: string | null;
}

export interface ProviderImportSource {
    status: 'available' | 'partial' | 'missing' | 'malformed' | 'unsupported' | 'unavailable';
    candidate: ProviderImportCandidate | null;
}

export interface ProviderSettingsImportScan {
    claudeCode: ProviderImportSource;
    codex: ProviderImportSource;
}

export type ProviderImportSourceId = keyof ProviderSettingsImportScan;

export interface ProviderSettingsImportApi {
    scan(): Promise<ProviderSettingsImportScan>;
}

export const providerSettingsImportApiKey: InjectionKey<ProviderSettingsImportApi> = Symbol(
    'touchai.models.provider-settings-import'
);

export function useProviderSettingsImportApi(): ProviderSettingsImportApi {
    const api = inject(providerSettingsImportApiKey);
    if (!api) throw new Error('PROVIDER_SETTINGS_IMPORT_UNAVAILABLE');
    return api;
}
