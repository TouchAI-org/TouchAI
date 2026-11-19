import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { mountComposable } from '@tests/utils/composables';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ref } from 'vue';

import { useModelSelection } from '@/views/SearchView/components/SearchBar/composables/useModelSelection';
import type { SearchModelOverride } from '@/views/SearchView/types';

let database: ReturnType<typeof openMigratedDatabase>;
const unmounts: (() => void)[] = [];
beforeEach(() => {
    database = openMigratedDatabase();
    routeQueriesTo(database);
    database.exec(`INSERT INTO providers (id,name,driver,api_endpoint,api_key,logo) VALUES
        (1,'First','openai-compatible','https://first.test','first-secret','openai'),
        (2,'Second','openai-compatible','https://second.test','second-secret','openai');
        INSERT INTO models (id,provider_id,name,model_id,is_default,attachment,modalities,tool_call) VALUES
        (1,1,'Default','default',1,0,'{"input":["text"]}',1),
        (2,1,'Vision','vision',0,1,'{"input":["text","image"]}',1),
        (3,2,'Other Vision','vision',0,0,'{"input":["text"]}',1);`);
});
afterEach(() => {
    for (const unmount of unmounts.splice(0)) unmount();
    closeTestDatabases();
});
async function mountSelection(override: SearchModelOverride = { modelId: null, providerId: null }) {
    const modelOverride = ref(override);
    const bar = document.createElement('div');
    const logo = ref<HTMLElement | null>(null);
    const view = await mountComposable(() =>
        useModelSelection({
            searchBarContainerRef: ref(bar),
            logoContainerRef: logo,
            modelOverride,
        })
    );
    unmounts.push(view.unmount);
    await expect
        .poll(() => view.result.activeModel.value?.model_id ?? null)
        .toBe(
            database.prepare('SELECT model_id FROM models WHERE is_default=1').get()?.model_id ??
                null
        );
    return { ...view, modelOverride, bar, logo };
}

describe('given Search resolves public model options from the current Models owner', () => {
    it('user starts without an override and sees the default capabilities with no explicit model tag', async () => {
        const { result, bar, logo } = await mountSelection();
        expect(result.modelCapabilities.value).toEqual({
            supportsImages: false,
            supportsFiles: false,
        });
        expect(result.selectedModelName.value).toBeNull();
        expect(result.getModelDropdownContext()).toMatchObject({
            activeModelId: 'default',
            activeProviderId: 1,
            selectedModelId: null,
        });
        expect(result.getModelDropdownAnchor()).toBe(bar);
        const image = document.createElement('div');
        logo.value = image;
        expect(result.getModelDropdownAnchor()).toBe(image);
        expect(JSON.stringify(result.activeModel.value)).not.toContain('first-secret');
    });

    it('user selects an image-capable model before opening the dropdown and sees the exact provider match', async () => {
        const { result } = await mountSelection({ modelId: 'vision', providerId: 1 });
        await expect.poll(() => result.selectedModelName.value).toBe('Vision');
        expect(result.modelCapabilities.value).toEqual({
            supportsImages: true,
            supportsFiles: true,
        });
        expect(result.selectedProviderId.value).toBe(1);
        expect(result.selectedModelId.value).toBe('vision');
    });

    it('user chooses the same model id on another provider and receives that provider capabilities', async () => {
        const { result } = await mountSelection({ modelId: 'vision', providerId: 2 });
        await expect.poll(() => result.selectedModelName.value).toBe('Other Vision');
        expect(result.modelCapabilities.value).toEqual({
            supportsImages: false,
            supportsFiles: false,
        });
    });

    it('user sets the default explicitly and receives no redundant override tag', async () => {
        const { result } = await mountSelection({ modelId: 'default', providerId: 1 });
        expect(result.selectedModelId.value).toBeNull();
        expect(result.selectedProviderId.value).toBeNull();
        expect(result.selectedModelName.value).toBe('Default');
    });

    it('user reopens a saved model on a disabled provider and retains its identity for display', async () => {
        database.exec('UPDATE providers SET enabled=0 WHERE id=2');
        const { result } = await mountSelection({ modelId: 'vision', providerId: 2 });
        await expect.poll(() => result.selectedModelName.value).toBe('Other Vision');
        expect(result.selectedModel.value?.provider_enabled).toBe(0);
        expect(result.modelCapabilities.value).toEqual({
            supportsImages: false,
            supportsFiles: false,
        });
    });

    it('user reopens a missing saved model and receives no stale selection', async () => {
        const { result } = await mountSelection({ modelId: 'missing', providerId: 2 });
        expect(result.selectedModel.value).toBeNull();
        expect(result.modelCapabilities.value).toEqual({
            supportsImages: false,
            supportsFiles: false,
        });
    });

    it('user opens an empty catalog and receives null identities and text capabilities', async () => {
        database.exec('DELETE FROM models');
        const { result } = await mountSelection();
        expect(await result.loadDropdownModels()).toEqual([]);
        expect(result.getModelDropdownContext()).toMatchObject({
            activeModelId: null,
            activeProviderId: null,
        });
    });

    it('user opens the dropdown twice and shares its saved public list until invalidation', async () => {
        const { result } = await mountSelection();
        const [first, second] = await Promise.all([
            result.loadDropdownModels(),
            result.loadDropdownModels(),
        ]);
        expect(first).toEqual(second);
        expect(first).toHaveLength(3);
        database.exec("UPDATE models SET name='Changed vision' WHERE id=2");
        expect((await result.loadDropdownModels()).find((model) => model.id === 2)?.name).toBe(
            'Vision'
        );
        result.invalidateDropdownModels();
        expect((await result.loadDropdownModels()).find((model) => model.id === 2)?.name).toBe(
            'Changed vision'
        );
    });

    it('user picks an offered model and can return to the saved default', async () => {
        const { result } = await mountSelection();
        await result.loadDropdownModels();
        expect(await result.handleModelSelect(2)).toEqual({ modelId: 'vision', providerId: 1 });
        expect(await result.handleModelSelect(1)).toEqual({ modelId: null, providerId: null });
        expect(await result.handleModelSelect(999)).toEqual({ modelId: null, providerId: null });
    });

    it('user receives a failed catalog read and can explicitly retry after storage recovers', async () => {
        const { result } = await mountSelection();
        let fail = true;
        routeQueriesTo(database, {
            beforeQuery: () => {
                if (fail) throw new Error('fixture catalog unavailable');
            },
        });
        expect(await result.loadDropdownModels()).toEqual([]);
        fail = false;
        expect(await result.loadDropdownModels()).toHaveLength(3);
    });

    it('user changes an override while its old lookup waits and keeps the newest provider', async () => {
        const { result, modelOverride } = await mountSelection();
        const pause = Promise.withResolvers<void>();
        let held = false;
        routeQueriesTo(database, {
            beforeQuery: ({ params }) => {
                if (!held && params.includes('vision') && params.includes(1)) {
                    held = true;
                    return pause.promise;
                }
            },
        });
        modelOverride.value = { modelId: 'vision', providerId: 1 };
        await expect.poll(() => held).toBe(true);
        modelOverride.value = { modelId: 'vision', providerId: 2 };
        await expect.poll(() => result.selectedModelName.value).toBe('Other Vision');
        pause.resolve();
        await Promise.resolve();
        expect(result.selectedModelName.value).toBe('Other Vision');
    });
});
