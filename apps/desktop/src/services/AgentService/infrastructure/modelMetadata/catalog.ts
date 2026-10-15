/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import type { NewLlmMetadata } from '@database/schema.ts';

import {
    modelLimitSchema,
    modelModalitiesSchema,
    parseModelLimit,
    parseModelModalities,
    serializeModelLimit,
} from '@/utils/modelSchemas';
import { z } from '@/utils/zod';

import { normalizeReasoningOptions, serializeReasoningOptions } from '../../contracts/reasoning';

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
    reasoning_options: z.unknown().optional(),
});

const rawModelDataSchema = z.record(
    z.string(),
    z.object({
        models: z.record(z.string(), rawModelSchema),
    })
);

type RawModelData = z.infer<typeof rawModelDataSchema>;

/**
 * 合并同一模型的能力字段。
 */
function mergeCapabilities(target: NewLlmMetadata, source: NewLlmMetadata): void {
    target.attachment = target.attachment || source.attachment ? 1 : 0;
    target.open_weights = target.open_weights || source.open_weights ? 1 : 0;
    target.reasoning = target.reasoning || source.reasoning ? 1 : 0;
    target.temperature = target.temperature || source.temperature ? 1 : 0;
    target.tool_call = target.tool_call || source.tool_call ? 1 : 0;

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

    if (!target.knowledge && source.knowledge) {
        target.knowledge = source.knowledge;
    } else if (target.knowledge && source.knowledge) {
        target.knowledge =
            source.knowledge.length > target.knowledge.length ? source.knowledge : target.knowledge;
    }

    const targetReasoning = normalizeReasoningOptions(target.reasoning_options);
    const sourceReasoning = normalizeReasoningOptions(source.reasoning_options);
    if (sourceReasoning.length > targetReasoning.length) {
        target.reasoning_options = serializeReasoningOptions(sourceReasoning);
    } else if (targetReasoning.length > 0) {
        target.reasoning_options = serializeReasoningOptions(targetReasoning);
    }

    if (!target.release_date && source.release_date) {
        target.release_date = source.release_date;
    }

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
 * 把远端原始数据展开成扁平元数据列表。
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
                reasoning_options: serializeReasoningOptions(
                    normalizeReasoningOptions(model.reasoning_options)
                ),
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
 * 去重同一模型 ID 的元数据。
 */
function deduplicateMetadata(metadataList: NewLlmMetadata[]): NewLlmMetadata[] {
    const metadataMap = new Map<string, NewLlmMetadata>();

    for (const item of metadataList) {
        const key = item.model_id.toLowerCase();
        const existing = metadataMap.get(key);
        if (existing) {
            mergeCapabilities(existing, item);
            continue;
        }

        metadataMap.set(key, { ...item });
    }

    return Array.from(metadataMap.values());
}

/**
 * 把原始目录解析成可入库的去重列表。
 *
 * 空目录直接拒绝：远端可能返回 200 但内容为空，此时覆盖会清空本地缓存。
 */
export function buildMetadataList(rawData: unknown): NewLlmMetadata[] {
    const filteredList = deduplicateMetadata(parseRawData(rawModelDataSchema.parse(rawData)));

    if (filteredList.length === 0) {
        throw new Error('Refusing to replace model metadata with an empty catalog');
    }

    return filteredList;
}
