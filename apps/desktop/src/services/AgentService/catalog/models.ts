// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { findDefaultModelWithProvider, findModelByProviderAndModelId } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';

import { AiError, AiErrorCode } from '../contracts/errors';

export interface GetModelOptions {
    providerId?: number;
    modelId?: string;
}

/**
 * 解析本次请求应使用的模型。
 */
export async function getModel(options?: GetModelOptions): Promise<ModelWithProvider> {
    if (options?.providerId != null && options.modelId) {
        const model = await findModelByProviderAndModelId({
            providerId: options.providerId,
            modelId: options.modelId,
        });

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

    if (!defaultModel) {
        console.warn('[Catalog] No default model found or provider disabled');
        throw new AiError(AiErrorCode.NO_ACTIVE_MODEL);
    }

    return defaultModel;
}
