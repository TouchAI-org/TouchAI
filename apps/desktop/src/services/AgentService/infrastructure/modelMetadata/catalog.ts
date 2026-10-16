/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import type { NewLlmMetadata, NewLlmMetadataAlias } from '@database/schema.ts';

import { modelLimitSchema, modelModalitiesSchema, serializeModelLimit } from '@/utils/modelSchemas';
import { z } from '@/utils/zod';

import { normalizeReasoningOptions, serializeReasoningOptions } from '../../contracts/reasoning';

const rawModelSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    family: z.string().optional(),
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
    canonical_model_id: z.string().optional(),
});

const rawProviderSchema = z.object({
    models: z.record(z.string(), rawModelSchema),
});

const rawCatalogSchema = z.record(z.string(), z.unknown());

type RawModel = z.infer<typeof rawModelSchema>;

interface SourceEntry {
    providerId: string;
    modelKey: string;
    model: RawModel;
    canonicalId: string;
}

export interface ModelCatalog {
    models: Record<string, RawModel>;
    alias: Record<string, string>;
}

/** 从模型名推导出来的别名优先级最低，避免盖掉真实收录方的写法。 */
const DERIVED_ALIAS_PRIORITY = 2000;
const FAMILY_ALIAS_PRIORITY = 5000;

/** 已整理过的目录结构：模型表 + 别名表。 */
const curatedCatalogSchema = z.object({
    models: z.record(z.string(), rawModelSchema),
    alias: z.record(z.string(), z.string()),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 已整理过的目录固定带 `models` + `alias` 两个对象字段，跟上游的 provider 结构区分开。 */
function isCuratedCatalog(value: Record<string, unknown>): boolean {
    if (!isPlainObject(value.models) || !isPlainObject(value.alias)) {
        return false;
    }

    return Object.values(value.alias).every((alias) => typeof alias === 'string');
}

function ownerSegmentOf(canonicalId: string): string {
    const separatorIndex = canonicalId.indexOf('/');
    return separatorIndex === -1 ? canonicalId : canonicalId.slice(0, separatorIndex);
}

function nameSegmentOf(canonicalId: string): string {
    const separatorIndex = canonicalId.indexOf('/');
    return separatorIndex === -1 ? '' : canonicalId.slice(separatorIndex + 1);
}

/** 归属 provider 自己的条目优先，其次才是别家转载的条目。 */
function sourcePriority(entry: SourceEntry): number {
    const owner = ownerSegmentOf(entry.canonicalId);
    const name = nameSegmentOf(entry.canonicalId);

    if (entry.providerId === owner && entry.modelKey === name) {
        return 0;
    }

    if (entry.providerId === owner) {
        return 1;
    }

    if (entry.modelKey === name) {
        return 2;
    }

    return 3;
}

/** 别名优先级：官方写法 > 其他收录方写法 > 从模型名推导的写法。 */
function aliasPriority(entry: SourceEntry, providerIds: Set<string>): number {
    const owner = ownerSegmentOf(entry.canonicalId);
    const name = nameSegmentOf(entry.canonicalId);
    let priority = 0;

    if (entry.providerId !== owner) {
        priority += 1000;
    }

    if (entry.modelKey !== name) {
        priority += 100;
    }

    if (!providerIds.has(owner)) {
        priority += 10;
    }

    return priority;
}

const RETAINED_MODEL_FIELDS = [
    'id',
    'name',
    'family',
    'attachment',
    'modalities',
    'open_weights',
    'reasoning',
    'release_date',
    'temperature',
    'tool_call',
    'knowledge',
    'limit',
    'reasoning_options',
] as const;

function retainedFieldCount(model: RawModel): number {
    let count = 0;

    for (const field of RETAINED_MODEL_FIELDS) {
        if (model[field] !== undefined) {
            count += 1;
        }
    }

    if (Array.isArray(model.reasoning_options) && model.reasoning_options.length > 0) {
        count += 2;
    }

    return count;
}

/**
 * 把 models.dev 的原始目录整理成「模型表 + 别名表」。
 *
 * 模型表按 canonical id 去重，同一模型有多家收录时保留官方条目；
 * 别名表保留所有收录方的写法，让中转站的自定义命名也能命中。
 */
export function buildCatalog(rawData: unknown): ModelCatalog {
    const rawCatalog = rawCatalogSchema.parse(rawData);

    // 内置快照已经是整理后的结构，直接用，避免二次整理。
    if (isCuratedCatalog(rawCatalog)) {
        return curatedCatalogSchema.parse(rawCatalog);
    }

    const groups = new Map<string, SourceEntry[]>();

    for (const [providerId, rawProvider] of Object.entries(rawCatalog)) {
        const parsedProvider = rawProviderSchema.safeParse(rawProvider);
        if (!parsedProvider.success) {
            continue;
        }

        for (const [modelKey, model] of Object.entries(parsedProvider.data.models)) {
            const canonicalId = model.canonical_model_id || modelKey.toLowerCase();
            const entries = groups.get(canonicalId) ?? [];
            entries.push({ providerId, modelKey, model, canonicalId });
            groups.set(canonicalId, entries);
        }
    }

    const providerIds = new Set(Object.keys(rawCatalog));
    const models: Record<string, RawModel> = {};
    const aliasCandidates = new Map<string, { canonicalId: string; priority: number }>();

    const offerAlias = (alias: string, canonicalId: string, priority: number): void => {
        if (alias.length === 0) {
            return;
        }

        const key = alias.toLowerCase();
        const current = aliasCandidates.get(key);

        if (current) {
            if (current.priority < priority) {
                return;
            }

            if (current.priority === priority && current.canonicalId <= canonicalId) {
                return;
            }
        }

        aliasCandidates.set(key, { canonicalId, priority });
    };

    for (const canonicalId of Object.keys(Object.fromEntries(groups)).sort()) {
        const entries = groups.get(canonicalId)!;

        entries.sort((left, right) => {
            const leftPriority = sourcePriority(left);
            const rightPriority = sourcePriority(right);

            if (leftPriority !== rightPriority) {
                return leftPriority - rightPriority;
            }

            const leftFields = retainedFieldCount(left.model);
            const rightFields = retainedFieldCount(right.model);

            if (leftFields !== rightFields) {
                return rightFields - leftFields;
            }

            if (left.modelKey.length !== right.modelKey.length) {
                return left.modelKey.length - right.modelKey.length;
            }

            return left.modelKey < right.modelKey ? -1 : left.modelKey > right.modelKey ? 1 : 0;
        });

        const source = entries[0]!;
        const record: Record<string, unknown> = {};

        for (const field of RETAINED_MODEL_FIELDS) {
            if (source.model[field] !== undefined) {
                record[field] = source.model[field];
            }
        }

        models[canonicalId] = record as RawModel;

        for (const entry of entries) {
            const priority = aliasPriority(entry, providerIds);
            offerAlias(entry.modelKey, canonicalId, priority);
            offerAlias(entry.model.id, canonicalId, priority + 1);
        }

        const derivedPriority =
            DERIVED_ALIAS_PRIORITY + (providerIds.has(ownerSegmentOf(canonicalId)) ? 0 : 10);
        offerAlias(nameSegmentOf(canonicalId) || canonicalId, canonicalId, derivedPriority);
        offerAlias(canonicalId, canonicalId, derivedPriority + 1);

        if (typeof source.model.family === 'string') {
            offerAlias(source.model.family, canonicalId, FAMILY_ALIAS_PRIORITY);
        }
    }

    const alias: Record<string, string> = {};
    for (const key of [...aliasCandidates.keys()].sort()) {
        alias[key] = aliasCandidates.get(key)!.canonicalId;
    }

    return { models, alias };
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
