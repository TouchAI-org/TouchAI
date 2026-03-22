/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { clearLlmMetadata, insertLlmMetadata } from '@database/queries/llmMetadata.ts';
import { setStatistic } from '@database/queries/statistics.ts';
import type { NewLlmMetadata } from '@database/schema.ts';
import { StatisticKey } from '@database/schema.ts';

import {
    modelLimitSchema,
    modelModalitiesSchema,
    parseModelLimit,
    parseModelModalities,
    serializeModelLimit,
} from '@/utils/modelSchemas';
import { z } from '@/utils/zod';

const rawModelSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    attachment: z.boolean().catch(false),
    modalities: modelModalitiesSchema.optional(),
    open_weights: z.boolean().catch(false),
    reasoning: z.boolean().catch(false),
    release_date: z.string().optional(),
    temperature: z.boolean().catch(false),
    tool_call: z.boolean().catch(false),
    knowledge: z.string().optional(),
    limit: modelLimitSchema.optional(),
});
const rawModelDataSchema = z.record(
    z.string(),
    z.object({
        models: z.record(z.string(), rawModelSchema),
    })
);

type RawModelData = z.infer<typeof rawModelDataSchema>;

/**
 * 合并两个元数据的能力字段
 */
function mergeCapabilities(target: NewLlmMetadata, source: NewLlmMetadata): void {
    // 合并布尔能力字段（任一为真则为真）
    target.attachment = target.attachment || source.attachment ? 1 : 0;
    target.open_weights = target.open_weights || source.open_weights ? 1 : 0;
    target.reasoning = target.reasoning || source.reasoning ? 1 : 0;
    target.temperature = target.temperature || source.temperature ? 1 : 0;
    target.tool_call = target.tool_call || source.tool_call ? 1 : 0;

    // 合并 modalities（取并集）
    const targetModalities = target.modalities ? parseModelModalities(target.modalities) : null;
    const sourceModalities = source.modalities ? parseModelModalities(source.modalities) : null;

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

    // 合并 knowledge（取较长的）
    if (!target.knowledge && source.knowledge) {
        target.knowledge = source.knowledge;
    } else if (target.knowledge && source.knowledge) {
        target.knowledge =
            source.knowledge.length > target.knowledge.length ? source.knowledge : target.knowledge;
    }

    // 合并 release_date（优先保留已有的）
    if (!target.release_date && source.release_date) {
        target.release_date = source.release_date;
    }

    // 合并 limit（取最大值）
    if (!target.limit && source.limit) {
        target.limit = serializeModelLimit(parseModelLimit(source.limit));
    } else if (target.limit && source.limit) {
        const targetLimit = parseModelLimit(target.limit);
        const sourceLimit = parseModelLimit(source.limit);
        const mergedLimit = {
            context: Math.max(targetLimit.context || 0, sourceLimit.context || 0) || undefined,
            output: Math.max(targetLimit.output || 0, sourceLimit.output || 0) || undefined,
        };
        target.limit = serializeModelLimit(mergedLimit);
    }
}

/**
 * 将 API 原始数据转换为元数据列表
 */
function parseRawData(rawData: RawModelData): NewLlmMetadata[] {
    const metadataMap = new Map<string, NewLlmMetadata>();

    for (const providerId in rawData) {
        const provider = rawData[providerId];
        if (!provider?.models) continue;

        for (const modelId in provider.models) {
            const model = provider.models[modelId];
            if (!model) continue;

            const modalities = model.modalities || { input: ['text'], output: ['text'] };
            const serializedLimit = serializeModelLimit(model.limit);

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
                limit: serializedLimit,
            };

            const existing = metadataMap.get(entry.model_id);
            if (existing) {
                mergeCapabilities(existing, entry);
            } else {
                metadataMap.set(entry.model_id, entry);
            }
        }
    }

    return Array.from(metadataMap.values());
}

/**
 * 去重并合并包含关系的元数据
 * 优先保留最长的 model_id，并叠加能力
 */
function deduplicateMetadata(metadataList: NewLlmMetadata[]): NewLlmMetadata[] {
    const sortedByLength = [...metadataList].sort((a, b) => b.model_id.length - a.model_id.length);
    const filteredList: NewLlmMetadata[] = [];

    for (const item of sortedByLength) {
        const target = filteredList.find((existing) => existing.model_id.includes(item.model_id));
        if (!target) {
            filteredList.push(item);
        } else {
            mergeCapabilities(target, item);
        }
    }

    return filteredList;
}

/**
 * 从 API 更新模型元数据
 */
export async function updateModelMetadata(): Promise<void> {
    try {
        // 1. 获取原始数据
        const response = await fetch('https://llm-metadata.pages.dev/api/all.json');
        if (!response.ok) {
            throw new Error(`Failed to fetch metadata: ${response.statusText}`);
        }
        const rawData = rawModelDataSchema.parse(await response.json());

        // 2. 解析并合并同 model_id 的数据
        const metadataList = parseRawData(rawData);

        // 3. 去重并合并包含关系的元数据
        const filteredList = deduplicateMetadata(metadataList);

        // 4. 更新数据库
        await clearLlmMetadata();
        await insertLlmMetadata(filteredList);

        // 5. 记录更新时间
        await setStatistic({
            key: StatisticKey.MODEL_METADATA_LAST_UPDATED_AT,
            value: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[ModelMetadata] Failed to update metadata:', error);
        throw error;
    }
}
