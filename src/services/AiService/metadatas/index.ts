/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { clearLlmMetadata, insertLlmMetadata } from '@database/queries/llmMetadata.ts';
import type { NewLlmMetadata } from '@database/schema.ts';

/**
 * API 返回的原始数据格式
 */
interface RawModelData {
    [providerId: string]: {
        models: {
            [modelId: string]: {
                id: string;
                name: string;
                attachment: boolean;
                modalities: {
                    input: string[];
                    output: string[];
                };
                open_weights: boolean;
                reasoning: boolean;
                release_date?: string;
                temperature: boolean;
                tool_call: boolean;
                knowledge?: string;
                limit?: {
                    context: number;
                    output: number;
                };
            };
        };
    };
}

/**
 * 从 API 更新模型元数据
 */
export async function updateModelMetadata(): Promise<void> {
    try {
        const response = await fetch('https://llm-metadata.pages.dev/api/all.json');
        if (!response.ok) {
            throw new Error(`Failed to fetch metadata: ${response.statusText}`);
        }

        const rawData: RawModelData = await response.json();

        const mergeCapabilities = (target: NewLlmMetadata, source: NewLlmMetadata) => {
            target.attachment = target.attachment || source.attachment ? 1 : 0;
            target.open_weights = target.open_weights || source.open_weights ? 1 : 0;
            target.reasoning = target.reasoning || source.reasoning ? 1 : 0;
            target.temperature = target.temperature || source.temperature ? 1 : 0;
            target.tool_call = target.tool_call || source.tool_call ? 1 : 0;

            const targetModalities = target.modalities ? JSON.parse(target.modalities) : null;
            const sourceModalities = source.modalities ? JSON.parse(source.modalities) : null;

            if (targetModalities || sourceModalities) {
                const mergedInput = new Set<string>([
                    ...(targetModalities?.input || []),
                    ...(sourceModalities?.input || []),
                ]);
                const mergedOutput = new Set<string>([
                    ...(targetModalities?.output || []),
                    ...(sourceModalities?.output || []),
                ]);
                target.modalities = JSON.stringify({
                    input: Array.from(mergedInput),
                    output: Array.from(mergedOutput),
                });
            }

            if (!target.knowledge && source.knowledge) {
                target.knowledge = source.knowledge;
            } else if (target.knowledge && source.knowledge) {
                target.knowledge =
                    source.knowledge.length > target.knowledge.length
                        ? source.knowledge
                        : target.knowledge;
            }

            if (!target.release_date && source.release_date) {
                target.release_date = source.release_date;
            }

            if (!target.limit && source.limit) {
                target.limit = source.limit;
            } else if (target.limit && source.limit) {
                const targetLimit = JSON.parse(target.limit) as {
                    context?: number;
                    output?: number;
                };
                const sourceLimit = JSON.parse(source.limit) as {
                    context?: number;
                    output?: number;
                };
                const mergedLimit = {
                    context:
                        Math.max(targetLimit.context || 0, sourceLimit.context || 0) || undefined,
                    output: Math.max(targetLimit.output || 0, sourceLimit.output || 0) || undefined,
                };
                target.limit = JSON.stringify(mergedLimit);
            }
        };

        const metadataMap = new Map<string, NewLlmMetadata>();

        for (const providerId in rawData) {
            const provider = rawData[providerId];
            if (!provider?.models) continue;

            for (const modelId in provider.models) {
                const model = provider.models[modelId];
                if (!model) continue;

                const modalities = model.modalities || { input: ['text'], output: ['text'] };

                const entry: NewLlmMetadata = {
                    model_id: model.id,
                    name: model.name,
                    attachment: model.attachment ? 1 : 0,
                    modalities: JSON.stringify(modalities),
                    open_weights: model.open_weights ? 1 : 0,
                    reasoning: model.reasoning ? 1 : 0,
                    release_date: model.release_date || null,
                    temperature: model.temperature ? 1 : 0,
                    tool_call: model.tool_call ? 1 : 0,
                    knowledge: model.knowledge || null,
                    limit: model.limit ? JSON.stringify(model.limit) : null,
                };

                const existing = metadataMap.get(entry.model_id);
                if (existing) {
                    mergeCapabilities(existing, entry);
                } else {
                    metadataMap.set(entry.model_id, entry);
                }
            }
        }

        const metadataList = Array.from(metadataMap.values());

        // 优先保留包含关系中最长的 model_id（如 ABBA 覆盖 BBA、BA），并叠加能力
        const sortedByLength = [...metadataList].sort(
            (a, b) => b.model_id.length - a.model_id.length
        );
        const filteredList: NewLlmMetadata[] = [];

        for (const item of sortedByLength) {
            const target = filteredList.find((existing) =>
                existing.model_id.includes(item.model_id)
            );
            if (!target) {
                filteredList.push(item);
            } else {
                mergeCapabilities(target, item);
            }
        }

        await clearLlmMetadata();
        await insertLlmMetadata(filteredList);
    } catch (error) {
        console.error('[ModelMetadata] Failed to update metadata:', error);
        throw error;
    }
}
