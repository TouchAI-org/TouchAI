import type { ModelWithProvider } from '@database/queries/models';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, type Ref, ref } from 'vue';

import { useModelSelection } from '@/views/SearchView/components/SearchBar/composables/useModelSelection';
import type { SearchModelOverride } from '@/views/SearchView/components/SearchBar/types';

/**
 * useModelSelection decides which model the next request uses: the page override,
 * the active default, or a model resolved on demand. The database and the AI
 * service are the process boundary; they are stubbed so the composable's own
 * default dependency wiring is exercised for real, and the assertions are about
 * the model and capabilities the page reads back.
 */
const { findModelsWithProviderMock, getActiveModelMock } = vi.hoisted(() => ({
    findModelsWithProviderMock: vi.fn(),
    getActiveModelMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    findModelsWithProvider: findModelsWithProviderMock,
}));

vi.mock('@/services/AgentService', () => ({
    aiService: { getModel: getActiveModelMock },
}));

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
        modalities: JSON.stringify({ input: ['text'], output: ['text'] }),
        open_weights: 0,
        reasoning: 0,
        reasoning_options: null,
        release_date: null,
        temperature: 0,
        tool_call: 1,
        knowledge: null,
        context_limit: null,
        output_limit: null,
        is_custom_metadata: 0,
        upstream_metadata: null,
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
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

/** Mounts with the real default dependencies (DB + AI service are module-mocked). */
async function mountWithDefaults(
    modelOverride: Ref<SearchModelOverride> = ref<SearchModelOverride>({
        modelId: null,
        providerId: null,
    })
) {
    return mountComposable(() =>
        useModelSelection({
            searchBarContainerRef: ref(null),
            logoContainerRef: ref(null),
            modelOverride,
        })
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    findModelsWithProviderMock.mockResolvedValue([]);
    getActiveModelMock.mockResolvedValue(null);
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('when no model can be resolved yet', () => {
    it('user gets plain-text capabilities while nothing is selected', async () => {
        const mounted = await mountWithDefaults();
        await flushAsyncWork();

        expect(mounted.result.modelCapabilities.value).toEqual({
            supportsImages: false,
            supportsFiles: false,
        });

        mounted.unmount();
    });

    it('user gets a null model name when nothing is selected', async () => {
        const mounted = await mountWithDefaults();
        await flushAsyncWork();

        expect(mounted.result.selectedModel.value).toBeNull();
        expect(mounted.result.selectedModelName.value).toBeNull();

        mounted.unmount();
    });

    it('user gets null dropdown identifiers when no active model exists', async () => {
        const mounted = await mountWithDefaults();
        await flushAsyncWork();

        expect(mounted.result.getModelDropdownContext()).toEqual({
            activeModelId: null,
            activeProviderId: null,
            selectedModelId: null,
            selectedProviderId: null,
            models: [],
        });

        mounted.unmount();
    });

    it('user gets the search bar container as the anchor when no logo is mounted', async () => {
        const searchBarContainer = document.createElement('div');
        const mounted = await mountComposable(() =>
            useModelSelection({
                searchBarContainerRef: ref(searchBarContainer),
                logoContainerRef: ref(null),
                modelOverride: ref({ modelId: null, providerId: null }),
            })
        );

        expect(mounted.result.getModelDropdownAnchor()).toBe(searchBarContainer);

        mounted.unmount();
    });

    it('user gets the logo container as the anchor once it is mounted', async () => {
        const logoContainer = document.createElement('div');
        const searchBarContainer = document.createElement('div');
        const mounted = await mountComposable(() =>
            useModelSelection({
                searchBarContainerRef: ref(searchBarContainer),
                logoContainerRef: ref(logoContainer),
                modelOverride: ref({ modelId: null, providerId: null }),
            })
        );

        expect(mounted.result.getModelDropdownAnchor()).toBe(logoContainer);

        mounted.unmount();
    });
});

describe('when the active default model fails to load', () => {
    it('user gets plain-text capabilities instead of a stale model', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        getActiveModelMock.mockRejectedValue(new Error('database locked'));

        const mounted = await mountWithDefaults();
        await flushAsyncWork();

        expect(mounted.result.activeModel.value).toBeNull();
        expect(mounted.result.modelCapabilities.value).toEqual({
            supportsImages: false,
            supportsFiles: false,
        });

        mounted.unmount();
    });
});

describe('when the chosen model is also the default', () => {
    it('user gets no explicit override because the default already applies', async () => {
        const activeModel = createModel(1, { model_id: 'gpt-5', provider_id: 3 });
        getActiveModelMock.mockResolvedValue(activeModel);

        const modelOverride = ref({ modelId: 'gpt-5', providerId: 3 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        // Picking the model you already have must not pin an override on the draft.
        expect(mounted.result.selectedModelId.value).toBeNull();
        expect(mounted.result.selectedProviderId.value).toBeNull();
        expect(mounted.result.selectedModel.value?.id).toBe(1);

        mounted.unmount();
    });

    it('user gets the same provider but a different model reported as an override', async () => {
        const activeModel = createModel(1, { model_id: 'gpt-5', provider_id: 3 });
        const otherModel = createModel(2, { model_id: 'gpt-5-mini', provider_id: 3 });
        getActiveModelMock.mockResolvedValue(activeModel);
        findModelsWithProviderMock.mockResolvedValue([activeModel, otherModel]);

        const modelOverride = ref({ modelId: 'gpt-5-mini', providerId: 3 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        // Same provider, different model: the model id alone decides.
        expect(mounted.result.selectedModelId.value).toBe('gpt-5-mini');
        expect(mounted.result.selectedProviderId.value).toBe(3);

        mounted.unmount();
    });
});

describe('when the override model comes from the loaded dropdown list', () => {
    it('user gets that model preferred over the on-demand lookup', async () => {
        const overrideModel = createModel(7, {
            model_id: 'sonnet',
            provider_id: 2,
            name: 'Sonnet',
            attachment: 1,
            modalities: JSON.stringify({ input: ['text', 'image'], output: ['text'] }),
        });
        findModelsWithProviderMock.mockResolvedValue([overrideModel]);

        const modelOverride = ref({ modelId: 'sonnet', providerId: 2 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();
        await mounted.result.loadPopupModels();

        expect(mounted.result.selectedModel.value?.id).toBe(7);
        expect(mounted.result.selectedModelName.value).toBe('Sonnet');
        expect(mounted.result.modelCapabilities.value).toEqual({
            supportsImages: true,
            supportsFiles: true,
        });

        mounted.unmount();
    });

    it('user gets the on-demand lookup used when the dropdown list is empty', async () => {
        const resolvedModel = createModel(9, { model_id: 'resolved', provider_id: 5 });
        getActiveModelMock.mockResolvedValue(createModel(1));
        findModelsWithProviderMock.mockImplementation(async (filter?: { providerId?: number }) => {
            if (filter?.providerId === 5) {
                return [resolvedModel];
            }
            return [];
        });

        const modelOverride = ref({ modelId: 'resolved', providerId: 5 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        // The default dependency looks the override up by provider and model id.
        expect(findModelsWithProviderMock).toHaveBeenCalledWith({ providerId: 5 });
        expect(mounted.result.selectedModel.value?.id).toBe(9);

        mounted.unmount();
    });

    it('user gets nothing selected when the lookup finds no matching model', async () => {
        getActiveModelMock.mockResolvedValue(createModel(1));
        findModelsWithProviderMock.mockResolvedValue([
            createModel(4, { model_id: 'a-different-model', provider_id: 5 }),
        ]);

        const modelOverride = ref({ modelId: 'missing-model', providerId: 5 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        expect(mounted.result.selectedModel.value).toBeNull();

        mounted.unmount();
    });
});

describe('when the dropdown list already holds the override model', () => {
    it('user gets the resolved override taken from that list', async () => {
        const activeModel = createModel(1, { model_id: 'default', provider_id: 1 });
        const overrideModel = createModel(8, { model_id: 'listed', provider_id: 6 });
        getActiveModelMock.mockResolvedValue(activeModel);

        // No override at mount, so the on-demand lookup is not used first.
        const modelOverride = ref<SearchModelOverride>({ modelId: null, providerId: null });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        findModelsWithProviderMock.mockResolvedValue([overrideModel]);
        await mounted.result.loadPopupModels();

        // Now the page pins an override that is already in the loaded list.
        modelOverride.value = { modelId: 'listed', providerId: 6 };
        await flushAsyncWork();

        expect(mounted.result.selectedModel.value?.id).toBe(8);
        expect(mounted.result.selectedModelId.value).toBe('listed');

        mounted.unmount();
    });

    it('user gets a list entry that shares the model id but not the provider ignored', async () => {
        const activeModel = createModel(1, { model_id: 'default', provider_id: 1 });
        const sameIdOtherProvider = createModel(11, { model_id: 'shared', provider_id: 6 });
        const resolvedModel = createModel(12, { model_id: 'shared', provider_id: 7 });
        getActiveModelMock.mockResolvedValue(activeModel);
        // The real query filters by provider, so the mock has to as well.
        findModelsWithProviderMock.mockImplementation(async (filter?: { providerId?: number }) =>
            filter?.providerId === 7 ? [resolvedModel] : [sameIdOtherProvider, activeModel]
        );

        const modelOverride = ref({ modelId: 'shared', providerId: 7 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        // Provider 7 is the one asked for, so the provider-6 entry cannot satisfy it.
        expect(mounted.result.selectedModel.value?.provider_id).toBe(7);
        expect(mounted.result.selectedModel.value?.id).toBe(12);

        mounted.unmount();
    });
});

describe('when a model lookup is overtaken by a newer one', () => {
    it('user gets the newer override shown rather than the stale lookup result', async () => {
        const staleLookup = deferred<ModelWithProvider[]>();
        const activeModel = createModel(1, { model_id: 'default', provider_id: 1 });
        getActiveModelMock.mockResolvedValue(activeModel);

        // The first provider lookup hangs; later ones answer immediately.
        let lookupCount = 0;
        findModelsWithProviderMock.mockImplementation(async () => {
            lookupCount += 1;
            if (lookupCount === 1) {
                return staleLookup.promise;
            }
            return [];
        });

        const modelOverride = ref({ modelId: 'first', providerId: 2 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        // Switch to a second override before the first lookup can answer.
        modelOverride.value = { modelId: 'second', providerId: 3 };
        await flushAsyncWork();

        // The stale lookup now answers with a model for the old override.
        staleLookup.resolve([createModel(99, { model_id: 'first', provider_id: 2 })]);
        await flushAsyncWork();

        // The stale answer must not win over the newer override.
        expect(mounted.result.selectedModel.value?.model_id).not.toBe('first');

        mounted.unmount();
    });

    it('user gets the newer model kept when the abandoned lookup fails later', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const staleLookup = deferred<ModelWithProvider[]>();
        const activeModel = createModel(1, { model_id: 'default', provider_id: 1 });
        const secondModel = createModel(2, { model_id: 'second', provider_id: 3 });
        getActiveModelMock.mockResolvedValue(activeModel);

        let lookupCount = 0;
        findModelsWithProviderMock.mockImplementation(async () => {
            lookupCount += 1;
            if (lookupCount === 1) {
                return staleLookup.promise;
            }
            return [secondModel];
        });

        const modelOverride = ref({ modelId: 'first', providerId: 2 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();

        // The page switches to an override that does resolve.
        modelOverride.value = { modelId: 'second', providerId: 3 };
        await flushAsyncWork();
        expect(mounted.result.selectedModel.value?.id).toBe(2);

        // The abandoned lookup now rejects; it must not clear the newer model.
        staleLookup.resolve(Promise.reject(new Error('aborted')) as never);
        await flushAsyncWork();

        expect(mounted.result.selectedModel.value?.id).toBe(2);
        expect(mounted.result.selectedModelId.value).toBe('second');

        mounted.unmount();
    });
});

describe('when the dropdown list fails to load', () => {
    it('user gets an empty list and no crash', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        findModelsWithProviderMock.mockRejectedValue(new Error('query failed'));

        const mounted = await mountWithDefaults();
        await flushAsyncWork();

        await expect(mounted.result.loadPopupModels()).resolves.toEqual([]);
        expect(mounted.result.getModelDropdownContext().models).toEqual([]);

        mounted.unmount();
    });

    it('user gets a retry allowed after a failed load', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        findModelsWithProviderMock.mockRejectedValueOnce(new Error('query failed'));

        const mounted = await mountWithDefaults();
        await flushAsyncWork();

        await mounted.result.loadPopupModels();
        findModelsWithProviderMock.mockResolvedValue([createModel(5)]);
        const models = await mounted.result.loadPopupModels();

        // A failure must not be cached as "already loaded".
        expect(models).toHaveLength(1);

        mounted.unmount();
    });
});

describe('when the user picks a model from the dropdown', () => {
    it('user gets the current override kept when the id is not in the list', async () => {
        const mounted = await mountWithDefaults(ref({ modelId: 'kept', providerId: 4 }));
        await flushAsyncWork();
        await mounted.result.loadPopupModels();

        // An unknown id cannot change the draft's model.
        await expect(mounted.result.handleModelSelect(12345)).resolves.toEqual({
            modelId: 'kept',
            providerId: 4,
        });

        mounted.unmount();
    });

    it('user gets the picked model reported with its provider', async () => {
        const picked = createModel(21, { model_id: 'picked', provider_id: 8 });
        getActiveModelMock.mockResolvedValue(createModel(1, { model_id: 'default' }));
        findModelsWithProviderMock.mockResolvedValue([picked]);

        const mounted = await mountWithDefaults();
        await flushAsyncWork();
        await mounted.result.loadPopupModels();

        await expect(mounted.result.handleModelSelect(21)).resolves.toEqual({
            modelId: 'picked',
            providerId: 8,
        });

        mounted.unmount();
    });
});

describe('when the page prepares the dropdown', () => {
    it('user gets the model list ready before the dropdown opens', async () => {
        findModelsWithProviderMock.mockResolvedValue([createModel(3)]);

        const mounted = await mountWithDefaults();
        await flushAsyncWork();

        await mounted.result.prepareModelDropdownOpen();

        expect(findModelsWithProviderMock).toHaveBeenCalled();
        expect(mounted.result.getModelDropdownContext().models).toHaveLength(1);

        mounted.unmount();
    });
});

describe('when the active model changes after the override was set', () => {
    it('user gets the override re-evaluated against the new default', async () => {
        const firstActive = createModel(1, { model_id: 'first-default', provider_id: 1 });
        const secondActive = createModel(2, { model_id: 'second-default', provider_id: 1 });
        getActiveModelMock.mockResolvedValue(firstActive);

        const modelOverride = ref({ modelId: 'first-default', providerId: 1 });
        const mounted = await mountWithDefaults(modelOverride);
        await flushAsyncWork();
        // Override equals the active default, so no explicit override is reported.
        expect(mounted.result.selectedModelId.value).toBeNull();

        // The default changes underneath: the same override is now explicit.
        getActiveModelMock.mockResolvedValue(secondActive);
        await mounted.result.loadActiveModel();
        await flushAsyncWork();

        expect(mounted.result.selectedModelId.value).toBe('first-default');

        mounted.unmount();
    });
});
