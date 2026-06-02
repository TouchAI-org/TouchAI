import { describe, expect, it, vi } from 'vitest';

import type { ModelWithProvider } from '@/database/queries/models';
import { createProviderForModel } from '@/services/AgentService/catalog/providers';

const providerRegistryMock = vi.hoisted(() => ({
    createProviderFromRegistry: vi.fn((driver, config) => ({
        driver,
        config,
    })),
    parseProviderConfigJson: vi.fn(() => ({ headers: {} })),
    parseProviderDriver: vi.fn((driver) => driver),
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => providerRegistryMock);

function createModel(overrides: Partial<ModelWithProvider> = {}): ModelWithProvider {
    return {
        id: 1,
        provider_id: 320,
        model_id: 'mimo-coding',
        name: 'MiMo Coding',
        is_default: 0,
        last_used_at: null,
        attachment: 0,
        modalities: null,
        open_weights: 0,
        reasoning: 0,
        release_date: null,
        temperature: 1,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        created_at: '',
        updated_at: '',
        provider_name: 'Xiaomi MiMo',
        provider_driver: 'mimo',
        api_endpoint: 'https://hub.touch-ai.org/api/v1',
        api_key: 'tai-long-lived-key',
        provider_config_json: null,
        provider_enabled: 1,
        provider_is_builtin: 1,
        provider_logo: 'mimo.png',
        ...overrides,
    };
}

describe('AgentService catalog provider creation', () => {
    it('uses the provider record api key for managed MiMo model records', () => {
        const provider = createProviderForModel(createModel());

        expect(provider.driver).toBe('mimo');
        expect(providerRegistryMock.createProviderFromRegistry).toHaveBeenCalledWith(
            'mimo',
            {
                apiEndpoint: 'https://hub.touch-ai.org/api/v1',
                apiKey: 'tai-long-lived-key',
                config: { headers: {} },
            },
        );
    });
});
