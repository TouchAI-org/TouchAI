import type { ProviderDriver } from '@touchai/models/contracts';

/** Ordinary model metadata has no connection credentials or executable handles. */
export interface ModelOption {
    id: number;
    created_at: string;
    updated_at: string;
    provider_id: number;
    model_id: string;
    name: string;
    is_default: number;
    last_used_at: string | null;
    attachment: number;
    modalities: string | null;
    open_weights: number;
    reasoning: number;
    reasoning_options: string | null;
    release_date: string | null;
    temperature: number;
    tool_call: number;
    knowledge: string | null;
    context_limit: number | null;
    output_limit: number | null;
    is_custom_metadata: number;
    upstream_metadata: string | null;
    provider_name: string;
    provider_driver: ProviderDriver;
    provider_enabled: number;
    provider_logo: string;
}

export interface ModelReference {
    providerId: number;
    modelId: string;
}
