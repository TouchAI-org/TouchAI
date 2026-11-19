// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createAlibaba } from '@ai-sdk/alibaba';

import { toModelInfo } from '../catalog/modelList';
import { z } from '../encoding/json';
import { AiSdkProviderBase } from './base';

const alibabaModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
    ),
});

/**
 * Alibaba 适配器。
 */
export class AlibabaProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Alibaba';
    readonly driver = 'alibaba' as const;

    private sdkProvider = createAlibaba({
        apiKey: this.apiKey,
        baseURL: this.getApiTargets().sdkBaseUrl || undefined,
        headers: this.getCustomHeaders(),
        fetch: this.fetch,
    });

    protected createLanguageModel(modelId: string) {
        return this.sdkProvider.chatModel(modelId);
    }

    protected getDiscoveryHeaders(): Record<string, string> {
        return {
            ...(this.apiKey
                ? {
                      Authorization: `Bearer ${this.apiKey}`,
                  }
                : {}),
            ...this.getCustomHeaders(),
        };
    }

    protected parseModelList(payload: unknown) {
        const parsed = alibabaModelsSchema.parse(payload);
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
    }
}
