import type { ModelWithProvider } from '@database/queries/models';
import {
    findDefaultModelWithProvider,
    findModelByProviderAndModelId,
    setDefaultModel,
    updateModelLastUsed,
} from '@database/queries/models';
import {
    parseModelModalities,
    parseProviderConfigJson,
    parseProviderDriver,
} from '@touchai/models/catalog';
import { parseReasoningOptions } from '@touchai/models/contracts';

import { readConnectionState } from './connections.io';
import type { ConfiguredModel } from './contracts';
import { ModelConfigurationError } from './errors';

function modelSnapshot(model: ModelWithProvider, updatedAt?: string | null): ConfiguredModel {
    const driver = parseProviderDriver(model.provider_driver);
    return {
        summary: {
            modelDbId: model.id,
            providerId: model.provider_id,
            providerName: model.provider_name,
            modelId: model.model_id,
            modelName: model.name,
        },
        connection: {
            providerId: model.provider_id,
            driver,
            apiEndpoint: model.api_endpoint,
            apiKey: model.api_key || undefined,
            config: parseProviderConfigJson(model.provider_config_json),
            updatedAt,
        },
        capabilities: {
            contextLimit: model.context_limit,
            outputLimit: model.output_limit,
            supportsImages: parseModelModalities(model.modalities).input.includes('image'),
            supportsFiles: model.attachment === 1,
            supportsTools: model.tool_call === 1,
            supportsReasoning: model.reasoning === 1,
            reasoningOptions: parseReasoningOptions(model.reasoning_options),
            preserveReasoningCache: driver === 'anthropic' || driver === 'anthropic-compatible',
        },
    };
}

export function createModelSelection() {
    async function get(reference?: {
        providerId?: number;
        modelId?: string;
    }): Promise<ConfiguredModel> {
        const explicit = reference?.providerId !== undefined && Boolean(reference.modelId);
        const model = explicit
            ? await findModelByProviderAndModelId({
                  providerId: reference!.providerId!,
                  modelId: reference!.modelId!,
              })
            : await findDefaultModelWithProvider();
        if (!model)
            throw new ModelConfigurationError(explicit ? 'MODEL_NOT_FOUND' : 'NO_ACTIVE_MODEL');
        if (model.provider_enabled === 0) throw new ModelConfigurationError('PROVIDER_DISABLED');
        const state = await readConnectionState(model.provider_id);
        if (!state?.enabled) throw new ModelConfigurationError('PROVIDER_DISABLED');
        const snapshot = modelSnapshot(model, state.updatedAt);
        if (!sameProfile(snapshot, state))
            throw new ModelConfigurationError('PROVIDER_BINDING_REVOKED');
        return snapshot;
    }
    const sameProfile = (model: ConfiguredModel, connection: ConfiguredModel['connection']) =>
        model.connection.driver === connection.driver &&
        model.connection.apiEndpoint === connection.apiEndpoint &&
        model.connection.apiKey === connection.apiKey &&
        JSON.stringify(model.connection.config) === JSON.stringify(connection.config);

    return Object.freeze({
        get,
        async isCurrent(snapshot: ConfiguredModel): Promise<boolean> {
            let current: ConfiguredModel;
            try {
                current = await get({
                    providerId: snapshot.summary.providerId,
                    modelId: snapshot.summary.modelId,
                });
            } catch (error) {
                if (error instanceof ModelConfigurationError) return false;
                throw error;
            }
            return (
                current.summary.modelDbId === snapshot.summary.modelDbId &&
                sameProfile(snapshot, current.connection) &&
                JSON.stringify(snapshot.capabilities) === JSON.stringify(current.capabilities)
            );
        },
        setDefault(modelDbId: number): Promise<void> {
            return setDefaultModel({ modelId: modelDbId });
        },
        touch(modelDbId: number): Promise<void> {
            return updateModelLastUsed({ id: modelDbId });
        },
    });
}

export type ModelSelection = ReturnType<typeof createModelSelection>;
