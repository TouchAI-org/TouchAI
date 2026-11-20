import { db } from '@database';

import {
    createModel,
    deleteModel,
    findDefaultModel,
    findModelsWithProvider,
    setDefaultModel,
    updateModel,
} from '@/database/queries/models';
import {
    createProvider,
    deleteProvider,
    findAllProvidersSorted,
    findProviderById,
    updateProvider,
} from '@/database/queries/providers';

import type { ModelAdministration } from './administration';
import {
    ModelAdministrationError,
    modelDraftSchema,
    modelPatchSchema,
    providerDraftSchema,
    providerImportEntriesSchema,
    providerPatchSchema,
} from './administration';
import { persistRefreshedModels } from './metadata/refresh.io';

export function createModelAdministration() {
    // Default changes and provider guards share one owner admission order.
    let writes: Promise<unknown> = Promise.resolve();
    let pending = 0;
    let disposed = false;
    function requireOpen() {
        if (disposed) throw new ModelAdministrationError('MODEL_ADMINISTRATION_UNAVAILABLE');
    }
    async function read<T>(operation: () => Promise<T>): Promise<T> {
        requireOpen();
        return operation();
    }
    function write<T>(operation: () => Promise<T>): Promise<T> {
        if (disposed || pending >= 16)
            return Promise.reject(new ModelAdministrationError('MODEL_ADMINISTRATION_UNAVAILABLE'));
        pending++;
        const current = writes
            .then(() => {
                requireOpen();
                return operation();
            })
            .finally(() => {
                pending--;
            });
        writes = current.then(
            () => undefined,
            () => undefined
        );
        return current;
    }
    async function requireProvider(id: number) {
        const provider = await findProviderById({ id });
        requireOpen();
        if (!provider) throw new ModelAdministrationError('PROVIDER_NOT_FOUND');
        return provider;
    }
    async function guardDefaultProvider(id: number) {
        const model = await findDefaultModel();
        requireOpen();
        if (model?.provider_id === id)
            throw new ModelAdministrationError('PROVIDER_HAS_DEFAULT_MODEL');
    }
    async function importProviders(entries: Parameters<ModelAdministration['importProviders']>[0]) {
        const parsedEntries = providerImportEntriesSchema.parse(entries.entries);
        return db.transaction(async (tx) => {
            const imported: Awaited<ReturnType<ModelAdministration['importProviders']>> = [];
            for (const entry of parsedEntries) {
                const provider = await createProvider(
                    providerDraftSchema.parse(entry.provider),
                    tx
                );
                const model = entry.model
                    ? await createModel(
                          modelDraftSchema.parse({
                              ...entry.model,
                              provider_id: provider.id,
                          }),
                          tx
                      )
                    : null;
                imported.push({ provider, model });
            }
            return imported;
        });
    }
    const api: ModelAdministration = {
        findAllProvidersSorted: () => read(findAllProvidersSorted),
        findProviderById: (input) => read(() => findProviderById(input)),
        findDefaultModel: () => read(findDefaultModel),
        findModelsWithProvider: (input) => read(() => findModelsWithProvider(input)),
        importProviders: (input) => write(() => importProviders(input)),
        createProvider: (data) => write(() => createProvider(providerDraftSchema.parse(data))),
        updateProvider: (input) =>
            write(async () => {
                const providerPatch = providerPatchSchema.parse(input.providerPatch);
                await requireProvider(input.id);
                if (providerPatch.enabled === 0) await guardDefaultProvider(input.id);
                await updateProvider({ id: input.id, providerPatch });
            }),
        deleteProvider: ({ id }) =>
            write(async () => {
                const provider = await requireProvider(id);
                if (provider.is_builtin) throw new ModelAdministrationError('BUILTIN_PROVIDER');
                await guardDefaultProvider(id);
                return deleteProvider({ id });
            }),
        createModel: (data) => write(() => createModel(modelDraftSchema.parse(data))),
        updateModel: ({ id, modelPatch }) =>
            write(() => updateModel({ id, modelPatch: modelPatchSchema.parse(modelPatch) })),
        deleteModel: (input) => write(() => deleteModel(input)),
        setDefaultModel: ({ modelId }) =>
            write(async () => {
                const model = (await findModelsWithProvider()).find(
                    (candidate) => candidate.id === modelId
                );
                requireOpen();
                if (!model) throw new ModelAdministrationError('MODEL_NOT_FOUND');
                // Existing settings behavior activates first; the default flags remain one native transaction.
                if (model.provider_enabled === 0)
                    await updateProvider({ id: model.provider_id, providerPatch: { enabled: 1 } });
                requireOpen();
                await setDefaultModel({ modelId });
            }),
        persistRefreshedModels: (input) => write(() => persistRefreshedModels(input)),
    };
    return Object.freeze({
        ...api,
        dispose(): Promise<unknown> {
            disposed = true;
            return writes;
        },
    });
}
