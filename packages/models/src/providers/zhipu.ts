// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { type LanguageModel } from 'ai';
import { createZhipu } from 'zhipu-ai-provider';

import { toModelInfo } from '../catalog/modelList';
import type { ReasoningProtocol } from '../contracts/reasoning';
import { z } from '../encoding/json';
import { AiSdkProviderBase } from './base';

const zhipuModelsSchema = z.object({
    data: z.array(
        z
            .object({
                id: z.string(),
            })
            .loose()
    ),
});

/**
 * 智谱适配器。
 */
export class ZhipuProviderAdapter extends AiSdkProviderBase {
    readonly name = 'Zhipu';
    readonly driver = 'zhipu' as const;

    private sdkProvider = createZhipu({
        apiKey: this.apiKey,
        baseURL: this.getApiTargets().sdkBaseUrl || undefined,
        headers: this.getCustomHeaders(),
        fetch: this.fetch,
    });

    protected createLanguageModel(modelId: string) {
        // zhipu SDK 返回的模型实例在运行时与 AI SDK 的 LanguageModel 兼容，
        // 但其 TypeScript 声明并非完全同构，因此这里保留受限的双重断言。
        return this.sdkProvider.chat(modelId) as unknown as LanguageModel;
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
        const parsed = zhipuModelsSchema.parse(payload);
        return parsed.data.map((model) => toModelInfo(model, { id: model.id }));
    }

    /**
     * 智谱的 wire format 与 deepseek-chat 一致：`thinking: { type: enabled | disabled }`，
     * providerOptions namespace 为 `zhipu`（SDK 会把该 namespace 原样并入请求体）。
     */
    protected override getReasoningProtocol(): ReasoningProtocol {
        return 'deepseek';
    }

    protected override getReasoningProviderOptionsKey(): string {
        return 'zhipu';
    }
}
