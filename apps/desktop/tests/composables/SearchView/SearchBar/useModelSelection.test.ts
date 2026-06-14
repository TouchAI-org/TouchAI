import type { ModelWithProvider } from '@database/queries/models';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';

import { useModelSelection } from '@/views/SearchView/components/SearchBar/composables/useModelSelection';

function createModel(id: number, overrides: Partial<ModelWithProvider> = {}): ModelWithProvider {
    return {
        id,
        created_at: '2026-05-16T00:00:00.000Z',
        updated_at: '2026-05-16T00:00:00.000Z',
        provider_id: 1,
        model_id: `model-${id}`,
        name: `Model ${id}`,
        is_default: 0,
        last_used_at: null,
        attachment: 0,
        modalities: JSON.stringify({
            input: ['text'],
            output: ['text'],
        }),
        open_weights: 0,
        reasoning: 0,
        release_date: null,
        temperature: 0,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        is_selected: 1,
        provider_name: 'Provider',
        provider_driver: 'openai',
        api_endpoint: 'https://api.example.com',
        api_key: null,
        provider_config_json: null,
        provider_enabled: 1,
        provider_logo: 'provider.svg',
        ...overrides,
    };
}

async function flushAsyncWork() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('useModelSelection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('loads the active model on mount and derives its capabilities and popup context', async () => {
        const activeModel = createModel(1, {
            model_id: 'gpt-5-vision',
            provider_id: 10,
            attachment: 1,
            modalities: JSON.stringify({
                input: ['text', 'image'],
                output: ['text'],
            }),
        });
        const searchBarContainer = document.createElement('div');
        const modelOverride = ref({
            modelId: null,
            providerId: null,
        });
        const deps = {
            findModels: vi.fn().mockResolvedValue([]),
            getActiveModel: vi.fn().mockResolvedValue(activeModel),
            findModelByOverride: vi.fn().mockResolvedValue(null),
        };

        const mounted = await mountComposable(() =>
            useModelSelection(
                {
                    searchBarContainerRef: ref(searchBarContainer),
                    logoContainerRef: ref(null),
                    modelOverride,
                },
                deps
            )
        );

        await flushAsyncWork();

        expect(deps.getActiveModel).toHaveBeenCalledTimes(1);
        expect(mounted.result.activeModel.value).toEqual(activeModel);
        expect(mounted.result.selectedModelId.value).toBeNull();
        expect(mounted.result.selectedProviderId.value).toBeNull();
        expect(mounted.result.modelCapabilities.value).toEqual({
            supportsImages: true,
            supportsFiles: true,
        });
        expect(mounted.result.getModelDropdownAnchor()).toBe(searchBarContainer);
        expect(mounted.result.getModelDropdownContext()).toEqual({
            activeModelId: 'gpt-5-vision',
            activeProviderId: 10,
            selectedModelId: null,
            selectedProviderId: null,
            models: [],
        });

        mounted.unmount();
    });

    it('deduplicates concurrent popup-model loads and re-fetches only after cache invalidation', async () => {
        const models = [createModel(2), createModel(3)];
        const deps = {
            findModels: vi.fn().mockResolvedValue(models),
            getActiveModel: vi.fn().mockResolvedValue(null),
            findModelByOverride: vi.fn().mockResolvedValue(null),
        };

        const mounted = await mountComposable(() =>
            useModelSelection(
                {
                    searchBarContainerRef: ref(null),
                    logoContainerRef: ref(null),
                    modelOverride: ref({
                        modelId: null,
                        providerId: null,
                    }),
                },
                deps
            )
        );

        const [firstResult, secondResult] = await Promise.all([
            mounted.result.loadPopupModels(),
            mounted.result.loadPopupModels(),
        ]);

        expect(firstResult).toEqual(models);
        expect(secondResult).toEqual(models);
        expect(deps.findModels).toHaveBeenCalledTimes(1);

        await mounted.result.loadPopupModels();
        expect(deps.findModels).toHaveBeenCalledTimes(1);

        mounted.result.invalidatePopupModels();
        await mounted.result.loadPopupModels();
        expect(deps.findModels).toHaveBeenCalledTimes(2);

        mounted.unmount();
    });

    it('resolves explicit overrides and maps model selection back to page-level override state', async () => {
        const activeModel = createModel(10, {
            model_id: 'default-model',
            provider_id: 1,
            name: 'Default Model',
        });
        const resolvedOverrideModel = createModel(20, {
            model_id: 'custom-model',
            provider_id: 2,
            name: 'Custom Model',
            attachment: 1,
            modalities: JSON.stringify({
                input: ['text'],
                output: ['text'],
            }),
        });
        const availableModels = [
            activeModel,
            createModel(30, {
                model_id: 'popup-model',
                provider_id: 4,
                name: 'Popup Model',
            }),
        ];
        const modelOverride = ref({
            modelId: 'custom-model',
            providerId: 2,
        });
        const deps = {
            findModels: vi.fn().mockResolvedValue(availableModels),
            getActiveModel: vi.fn().mockResolvedValue(activeModel),
            findModelByOverride: vi.fn().mockResolvedValue(resolvedOverrideModel),
        };

        const mounted = await mountComposable(() =>
            useModelSelection(
                {
                    searchBarContainerRef: ref(null),
                    logoContainerRef: ref(null),
                    modelOverride,
                },
                deps
            )
        );

        await flushAsyncWork();

        expect(deps.findModelByOverride).toHaveBeenCalledWith({
            modelId: 'custom-model',
            providerId: 2,
        });
        expect(mounted.result.selectedModelId.value).toBe('custom-model');
        expect(mounted.result.selectedProviderId.value).toBe(2);
        expect(mounted.result.selectedModelName.value).toBe('Custom Model');
        expect(mounted.result.modelCapabilities.value).toEqual({
            supportsImages: false,
            supportsFiles: true,
        });

        await mounted.result.loadPopupModels();

        await expect(mounted.result.handleModelSelect(activeModel.id)).resolves.toEqual({
            modelId: null,
            providerId: null,
        });
        await expect(mounted.result.handleModelSelect(30)).resolves.toEqual({
            modelId: 'popup-model',
            providerId: 4,
        });

        mounted.unmount();
    });
});
