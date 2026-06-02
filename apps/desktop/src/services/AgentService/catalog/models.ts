// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    findDefaultModelWithProvider,
    findModelByProviderAndModelId,
    findModelsWithProvider,
    findProviderById,
} from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';

import { AiError, AiErrorCode } from '../contracts/errors';
import {
    isTouchAiManagedMode,
    isTouchAiManagedModel,
    parseProviderConfigJson,
    TOUCHAI_HUB_MANAGED_MODELS,
} from '../infrastructure/providers/config';

export interface GetModelOptions {
    providerId?: number;
    modelId?: string;
}

async function resolveManagedTouchAiModel(
    providerId: number,
    requestedModelId?: string
): Promise<ModelWithProvider | null> {
    const provider = await findProviderById({ id: providerId });
    if (
        !provider ||
        provider.driver !== 'mimo' ||
        provider.is_builtin !== 1 ||
        !isTouchAiManagedMode(parseProviderConfigJson(provider.config_json), provider.api_endpoint)
    ) {
        return null;
    }

    const models = await findModelsWithProvider({ providerId });
    const managedModels = models.filter((model) => isTouchAiManagedModel(model.model_id));
    if (managedModels.length === 0) {
        return null;
    }

    if (requestedModelId) {
        const exactMatch = managedModels.find((model) => model.model_id === requestedModelId);
        if (exactMatch) {
            return exactMatch;
        }
    }

    for (const supportedModelId of TOUCHAI_HUB_MANAGED_MODELS) {
        const matchedModel = managedModels.find((model) => model.model_id === supportedModelId);
        if (matchedModel) {
            return matchedModel;
        }
    }

    return managedModels[0] ?? null;
}

/**
 * 解析本次请求应使用的模型。
 */
export async function getModel(options?: GetModelOptions): Promise<ModelWithProvider> {
    if (options?.providerId != null && options.modelId) {
        const model =
            (await resolveManagedTouchAiModel(options.providerId, options.modelId)) ??
            (await findModelByProviderAndModelId({
                providerId: options.providerId,
                modelId: options.modelId,
            }));

        if (!model) {
            throw new AiError(AiErrorCode.MODEL_NOT_FOUND, {
                providerId: options.providerId,
                modelId: options.modelId,
            });
        }

        if (model.provider_enabled === 0) {
            throw new AiError(AiErrorCode.PROVIDER_DISABLED, {
                providerId: options.providerId,
                modelId: options.modelId,
            });
        }

        return model;
    }

    const defaultModel = await findDefaultModelWithProvider();
    const resolvedDefaultModel =
        defaultModel == null
            ? null
            : ((await resolveManagedTouchAiModel(
                  defaultModel.provider_id,
                  defaultModel.model_id
              )) ?? defaultModel);

    if (!resolvedDefaultModel) {
        console.warn('[Catalog] No default model found or provider disabled');
        throw new AiError(AiErrorCode.NO_ACTIVE_MODEL);
    }

    return resolvedDefaultModel;
}
