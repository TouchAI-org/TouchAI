/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import type { NewLlmMetadata, NewLlmMetadataAlias } from '@database/schema.ts';
import {
    buildCatalog,
    type CatalogModel as RawModel,
    type ModelCatalog,
} from '@touchai/models/catalog';
import { normalizeReasoningOptions, serializeReasoningOptions } from '@touchai/models/contracts';

import { serializeModelLimit } from '@/utils/modelSchemas';
export type { ModelCatalog } from '@touchai/models/catalog';
export { buildCatalog } from '@touchai/models/catalog';

/**
 * 把 models.dev 的 `tiers` 归成紧凑的「超出即切价」数组。
 *
 * 只保留 `type === 'context'` 且有正 `size` 的档位：
 * 其他类型（如果上游未来加了）与零尺寸档都不能当作「超过多少 token」。
 * 未给价的字段留 `null`，表示沿用基础价，而不是当作 0。
 */
function serializeCostTiers(cost: RawModel['cost']): string | null {
    const tiers = cost?.tiers;
    if (!tiers || tiers.length === 0) {
        return null;
    }

    const normalized = tiers
        .filter((tier) => (tier.tier?.type ?? 'context') === 'context')
        .map((tier) => ({
            above: tier.tier?.size ?? 0,
            input: tier.input ?? null,
            output: tier.output ?? null,
            cacheRead: tier.cache_read ?? null,
            cacheWrite: tier.cache_write ?? null,
            reasoning: tier.reasoning ?? null,
        }))
        .filter((tier) => tier.above > 0)
        .sort((left, right) => left.above - right.above);

    return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

/**
 * 把整理后的目录展开成扁平元数据列表。
 */
function flattenCatalog(catalog: ModelCatalog): NewLlmMetadata[] {
    const metadataList: NewLlmMetadata[] = [];

    for (const [modelId, model] of Object.entries(catalog.models)) {
        metadataList.push({
            model_id: modelId,
            name: model.name,
            attachment: model.attachment ? 1 : 0,
            modalities: JSON.stringify(
                model.modalities ?? {
                    input: ['text'],
                    output: ['text'],
                }
            ),
            open_weights: model.open_weights ? 1 : 0,
            reasoning: model.reasoning ? 1 : 0,
            release_date: model.release_date || null,
            temperature: model.temperature ? 1 : 0,
            tool_call: model.tool_call ? 1 : 0,
            knowledge: model.knowledge || null,
            limit: serializeModelLimit(model.limit),
            reasoning_options: serializeReasoningOptions(
                normalizeReasoningOptions(model.reasoning_options)
            ),
            input_cost_per_million: model.cost?.input?.toString() ?? null,
            output_cost_per_million: model.cost?.output?.toString() ?? null,
            cache_read_cost_per_million: model.cost?.cache_read?.toString() ?? null,
            cache_write_cost_per_million: model.cost?.cache_write?.toString() ?? null,
            // 缺省时为 null，查询时回退到 output 价（不在这里写死，
            // 否则 output 价更新后残留的旧值会变成真正的错误定价）
            reasoning_cost_per_million: model.cost?.reasoning?.toString() ?? null,
            cost_currency: model.cost?.currency ?? (model.cost ? 'USD' : null),
            cost_tiers: serializeCostTiers(model.cost),
        });
    }

    return metadataList;
}

/**
 * 把别名表展开成可入库的别名行。
 */
function flattenAliases(catalog: ModelCatalog): NewLlmMetadataAlias[] {
    const aliasList: NewLlmMetadataAlias[] = [];

    for (const [alias, modelId] of Object.entries(catalog.alias)) {
        if (catalog.models[modelId]) {
            aliasList.push({ alias, model_id: modelId });
        }
    }

    return aliasList;
}

export interface ParsedModelCatalog {
    metadataList: NewLlmMetadata[];
    aliasList: NewLlmMetadataAlias[];
}

/**
 * 把整理后的目录解析成可入库的元数据与别名。
 *
 * 快照已按此结构生成；远端拉到的 models.dev 原始结构会先经过 {@link buildCatalog}。
 * 空目录直接拒绝：远端可能返回 200 但内容为空，此时覆盖会清空本地缓存。
 */
export function buildMetadataList(rawData: unknown): ParsedModelCatalog {
    const catalog = buildCatalog(rawData);
    const metadataList = flattenCatalog(catalog);

    if (metadataList.length === 0) {
        throw new Error('Refusing to replace model metadata with an empty catalog');
    }

    return { metadataList, aliasList: flattenAliases(catalog) };
}
