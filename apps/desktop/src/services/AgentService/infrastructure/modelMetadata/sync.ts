/*
 * Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3
 */

import { type DatabaseExecutor, db } from '@database';
import { llmMetadata, llmMetadataAliases, models } from '@database/schema';
import type { UpstreamModelMetadataPatch } from '@database/types';
import { eq, sql } from 'drizzle-orm';

import { expandModelIdCandidates } from './modelIdCandidates';

/**
 * 把运行时模型行与 models.dev 元数据对齐：匹配规则是纯函数、可脱离数据库单测，
 * SQL 只负责批量读出候选命中的别名与元数据，再用一次 UPDATE 落库。
 * 行上记录的上游声明（`upstream_metadata`）优先于 models.dev 兜底值。
 */

export interface ModelMetadataTarget {
    id: number;
    modelId: string;
}

/** 运行时模型行，带上一次上游 `/v1/models` 记录的能力声明。 */
export interface ModelMetadataTargetRow extends ModelMetadataTarget {
    upstreamMetadata: string | null;
}

export interface ModelMetadataUpdateRow {
    id: number;
    attachment: number | null;
    modalities: string | null;
    open_weights: number | null;
    reasoning: number | null;
    reasoning_options: string | null;
    release_date: string | null;
    temperature: number | null;
    tool_call: number | null;
    knowledge: string | null;
    context_limit: number | null;
    output_limit: number | null;
    clear_reasoning_options: number;
}

export interface LlmMetadataRecord {
    modelId: string;
    attachment: number;
    modalities: string;
    openWeights: number;
    reasoning: number;
    reasoningOptions: string | null;
    releaseDate: string | null;
    temperature: number;
    toolCall: number;
    knowledge: string | null;
    contextLimit: number | null;
    outputLimit: number | null;
}

export interface ModelMetadataSelection {
    modelRowId: number;
    metadata: LlmMetadataRecord;
}

/** 声明得越多的条目越可信。 */
function metadataRichness(record: LlmMetadataRecord): number {
    return (
        record.attachment +
        record.openWeights +
        record.reasoning +
        record.temperature +
        record.toolCall +
        (record.modalities.length > 0 ? 1 : 0)
    );
}

interface RankedMatch {
    depth: number;
    metadata: LlmMetadataRecord;
}

/** 选优：裁剪最少 > 元数据最全 > model_id 最长，全并列时取字典序保证稳定。 */
function isBetterMatch(candidate: RankedMatch, current: RankedMatch): boolean {
    if (candidate.depth !== current.depth) {
        return candidate.depth < current.depth;
    }

    const candidateScore = metadataRichness(candidate.metadata);
    const currentScore = metadataRichness(current.metadata);
    if (candidateScore !== currentScore) {
        return candidateScore > currentScore;
    }

    if (candidate.metadata.modelId.length !== current.metadata.modelId.length) {
        return candidate.metadata.modelId.length > current.metadata.modelId.length;
    }

    return candidate.metadata.modelId < current.metadata.modelId;
}

/** 为每个模型行选出最可信的元数据条目；没有候选命中别名表时跳过该行。 */
export function selectModelMetadata(
    targets: readonly ModelMetadataTarget[],
    aliasTargets: ReadonlyMap<string, string>,
    metadataByModelId: ReadonlyMap<string, LlmMetadataRecord>
): ModelMetadataSelection[] {
    const selections: ModelMetadataSelection[] = [];

    for (const target of targets) {
        let best: RankedMatch | null = null;

        for (const { candidate, depth } of expandModelIdCandidates(target.modelId)) {
            const metadataModelId = aliasTargets.get(candidate);
            if (!metadataModelId) {
                continue;
            }

            const metadata = metadataByModelId.get(metadataModelId);
            if (!metadata) {
                continue;
            }

            const match: RankedMatch = { depth, metadata };
            if (!best || isBetterMatch(match, best)) {
                best = match;
            }
        }

        if (best) {
            selections.push({ modelRowId: target.id, metadata: best.metadata });
        }
    }

    return selections;
}

/** `llm_metadata.limit` 是 JSON 字符串，缺字段或非数字都视为未声明。 */
function parseModelLimit(limit: string | null): {
    contextLimit: number | null;
    outputLimit: number | null;
} {
    if (!limit) {
        return { contextLimit: null, outputLimit: null };
    }

    const parsed: unknown = JSON.parse(limit);
    if (typeof parsed !== 'object' || parsed === null) {
        return { contextLimit: null, outputLimit: null };
    }

    const record = parsed as Record<string, unknown>;
    const context = record.context;
    const output = record.output;

    return {
        contextLimit: typeof context === 'number' ? context : null,
        outputLimit: typeof output === 'number' ? output : null,
    };
}

function toMetadataRecord(row: {
    modelId: string;
    attachment: number;
    modalities: string;
    openWeights: number;
    reasoning: number;
    reasoningOptions: string | null;
    releaseDate: string | null;
    temperature: number;
    toolCall: number;
    knowledge: string | null;
    limit: string | null;
}): LlmMetadataRecord {
    const { contextLimit, outputLimit } = parseModelLimit(row.limit);

    return {
        modelId: row.modelId,
        attachment: row.attachment,
        modalities: row.modalities,
        openWeights: row.openWeights,
        reasoning: row.reasoning,
        reasoningOptions: row.reasoningOptions,
        releaseDate: row.releaseDate,
        temperature: row.temperature,
        toolCall: row.toolCall,
        knowledge: row.knowledge,
        contextLimit,
        outputLimit,
    };
}

/** 列里存的是 JSON 字符串；损坏或非对象都当作没有上游声明。 */
function parseUpstreamMetadata(value: string | null): UpstreamModelMetadataPatch | null {
    if (!value) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as UpstreamModelMetadataPatch)
            : null;
    } catch {
        return null;
    }
}

/**
 * 上游声明 > models.dev 兜底 > 行内已有值：`null` 交给 SQL 的 COALESCE 保留旧值。
 * 上游显式声明不支持思考时，连同旧档位一起清空。
 */
export function resolveModelMetadataRow(
    target: ModelMetadataTargetRow,
    metadata: LlmMetadataRecord | undefined
): ModelMetadataUpdateRow | null {
    const upstream = parseUpstreamMetadata(target.upstreamMetadata);
    if (!upstream && !metadata) {
        return null;
    }

    const clearReasoningOptions = upstream?.reasoning === 0 ? 1 : 0;

    return {
        id: target.id,
        attachment: upstream?.attachment ?? metadata?.attachment ?? null,
        modalities: upstream?.modalities ?? metadata?.modalities ?? null,
        open_weights: metadata?.openWeights ?? null,
        reasoning: upstream?.reasoning ?? metadata?.reasoning ?? null,
        reasoning_options: clearReasoningOptions
            ? null
            : (upstream?.reasoning_options ?? metadata?.reasoningOptions ?? null),
        release_date: metadata?.releaseDate ?? null,
        temperature: metadata?.temperature ?? null,
        tool_call: upstream?.tool_call ?? metadata?.toolCall ?? null,
        knowledge: metadata?.knowledge ?? null,
        context_limit: upstream?.context_limit ?? metadata?.contextLimit ?? null,
        output_limit: upstream?.output_limit ?? metadata?.outputLimit ?? null,
        clear_reasoning_options: clearReasoningOptions,
    };
}

/** 同步所有非自定义模型的元数据：三次读取 + 内存匹配 + 单条集合 UPDATE。 */
export async function syncAllModelsMetadata(database: DatabaseExecutor = db): Promise<void> {
    const targets = await database
        .select({
            id: models.id,
            modelId: models.model_id,
            upstreamMetadata: models.upstream_metadata,
        })
        .from(models)
        .where(eq(models.is_custom_metadata, 0))
        .all();

    if (targets.length === 0) {
        return;
    }

    const candidates = new Set<string>();
    for (const target of targets) {
        for (const { candidate } of expandModelIdCandidates(target.modelId)) {
            candidates.add(candidate);
        }
    }

    const aliasRows = await database
        .select({ alias: llmMetadataAliases.alias, modelId: llmMetadataAliases.model_id })
        .from(llmMetadataAliases)
        .where(
            sql`${llmMetadataAliases.alias} IN (SELECT value FROM json_each(${JSON.stringify([...candidates])}))`
        )
        .all();

    const metadataModelIds = [...new Set(aliasRows.map((row) => row.modelId))];
    const metadataRows =
        metadataModelIds.length > 0
            ? await database
                  .select({
                      modelId: llmMetadata.model_id,
                      attachment: llmMetadata.attachment,
                      modalities: llmMetadata.modalities,
                      openWeights: llmMetadata.open_weights,
                      reasoning: llmMetadata.reasoning,
                      reasoningOptions: llmMetadata.reasoning_options,
                      releaseDate: llmMetadata.release_date,
                      temperature: llmMetadata.temperature,
                      toolCall: llmMetadata.tool_call,
                      knowledge: llmMetadata.knowledge,
                      limit: llmMetadata.limit,
                  })
                  .from(llmMetadata)
                  .where(
                      sql`${llmMetadata.model_id} IN (SELECT value FROM json_each(${JSON.stringify(metadataModelIds)}))`
                  )
                  .all()
            : [];

    const aliasTargets = new Map(aliasRows.map((row) => [row.alias, row.modelId] as const));
    const metadataByModelId = new Map(
        metadataRows.map((row) => [row.modelId, toMetadataRecord(row)] as const)
    );

    const selections = selectModelMetadata(targets, aliasTargets, metadataByModelId);
    const selectedByRowId = new Map(
        selections.map((selection) => [selection.modelRowId, selection.metadata] as const)
    );

    const rows: ModelMetadataUpdateRow[] = [];
    for (const target of targets) {
        const row = resolveModelMetadataRow(target, selectedByRowId.get(target.id));
        if (row) {
            rows.push(row);
        }
    }

    if (rows.length === 0) {
        return;
    }

    const payload = JSON.stringify(rows);

    await database.run(sql`
        WITH selected_model_metadata AS (
            SELECT
                json_extract(entry.value, '$.id') AS model_row_id,
                json_extract(entry.value, '$.attachment') AS attachment,
                json_extract(entry.value, '$.modalities') AS modalities,
                json_extract(entry.value, '$.open_weights') AS open_weights,
                json_extract(entry.value, '$.reasoning') AS reasoning,
                json_extract(entry.value, '$.reasoning_options') AS reasoning_options,
                json_extract(entry.value, '$.release_date') AS release_date,
                json_extract(entry.value, '$.temperature') AS temperature,
                json_extract(entry.value, '$.tool_call') AS tool_call,
                json_extract(entry.value, '$.knowledge') AS knowledge,
                json_extract(entry.value, '$.context_limit') AS context_limit,
                json_extract(entry.value, '$.output_limit') AS output_limit,
                json_extract(entry.value, '$.clear_reasoning_options') AS clear_reasoning_options
            FROM json_each(${payload}) AS entry
        )
        UPDATE models
        SET
            attachment = COALESCE((
                SELECT selected_model_metadata.attachment
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), attachment),
            modalities = COALESCE((
                SELECT selected_model_metadata.modalities
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), modalities),
            open_weights = COALESCE((
                SELECT selected_model_metadata.open_weights
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), open_weights),
            reasoning = COALESCE((
                SELECT selected_model_metadata.reasoning
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), reasoning),
            reasoning_options = CASE
                WHEN (
                    SELECT selected_model_metadata.clear_reasoning_options
                    FROM selected_model_metadata
                    WHERE selected_model_metadata.model_row_id = models.id
                ) = 1 THEN NULL
                ELSE COALESCE((
                    SELECT selected_model_metadata.reasoning_options
                    FROM selected_model_metadata
                    WHERE selected_model_metadata.model_row_id = models.id
                ), reasoning_options)
            END,
            release_date = COALESCE((
                SELECT selected_model_metadata.release_date
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), release_date),
            temperature = COALESCE((
                SELECT selected_model_metadata.temperature
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), temperature),
            tool_call = COALESCE((
                SELECT selected_model_metadata.tool_call
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), tool_call),
            knowledge = COALESCE((
                SELECT selected_model_metadata.knowledge
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), knowledge),
            context_limit = COALESCE((
                SELECT selected_model_metadata.context_limit
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), context_limit),
            output_limit = COALESCE((
                SELECT selected_model_metadata.output_limit
                FROM selected_model_metadata
                WHERE selected_model_metadata.model_row_id = models.id
            ), output_limit),
            updated_at = datetime('now')
        WHERE is_custom_metadata = 0
          AND EXISTS (
              SELECT 1
              FROM selected_model_metadata
              WHERE selected_model_metadata.model_row_id = models.id
          )
    `);
}
