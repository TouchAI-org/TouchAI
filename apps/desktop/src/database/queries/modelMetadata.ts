import { eq, sql } from 'drizzle-orm';

import { type DatabaseExecutor, db } from '../index';
import {
    llmMetadata,
    llmMetadataAliases,
    models,
    type NewLlmMetadata,
    type NewLlmMetadataAlias,
    StatisticKey,
} from '../schema';
import type { RecordUpstreamModelMetadataPayload } from '../types';
import { createModels, recordUpstreamModelMetadata } from './models';
import { setStatistic } from './statistics';

export interface MetadataTargetRow {
    id: number;
    modelId: string;
    upstreamMetadata: string | null;
}
export interface MetadataCatalogRow {
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
}
export interface MetadataUpdateRow {
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
/** Pure matching callbacks; the database never receives a module or service instance. */
export interface MetadataSyncPolicy {
    candidates(targets: readonly MetadataTargetRow[]): string[];
    resolve(input: {
        targets: readonly MetadataTargetRow[];
        aliases: readonly { alias: string; modelId: string }[];
        records: readonly MetadataCatalogRow[];
    }): MetadataUpdateRow[];
}

export function synchronizeModelMetadata(policy: MetadataSyncPolicy): Promise<void> {
    return synchronizeMetadataRows(policy, db);
}

async function synchronizeMetadataRows(
    policy: MetadataSyncPolicy,
    database: DatabaseExecutor
): Promise<void> {
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

    const candidates = policy.candidates(targets);

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

    const rows = policy.resolve({ targets, aliases: aliasRows, records: metadataRows });

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

/** 把数组切成固定大小的批次 */
function chunked<T>(items: readonly T[], size: number): T[][] {
    if (items.length === 0) {
        return [];
    }
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }
    return chunks;
}

export async function replaceModelMetadataCache(
    {
        metadataList,
        aliasList,
    }: { metadataList: NewLlmMetadata[]; aliasList: NewLlmMetadataAlias[] },
    {
        sourceEtag = null,
        markUpdatedAt,
    }: {
        markUpdatedAt: boolean;
        sourceEtag?: string | null;
    },
    policy: MetadataSyncPolicy
): Promise<void> {
    await db.transaction(async (tx) => {
        await tx.delete(llmMetadataAliases).run();
        await tx.delete(llmMetadata).run();

        // 分批写入：SQLite 对单条语句的参数个数有上限（默认 32766），
        // 目录有 2000+ 行 × 十几列，一次性写入会直接超限。
        for (const chunk of chunked(metadataList, 200)) {
            await tx
                .insert(llmMetadata)
                .values(chunk)
                .onConflictDoNothing({ target: llmMetadata.model_id })
                .run();
        }

        for (const chunk of chunked(aliasList, 500)) {
            await tx
                .insert(llmMetadataAliases)
                .values(chunk)
                .onConflictDoNothing({ target: llmMetadataAliases.alias })
                .run();
        }

        await synchronizeMetadataRows(policy, tx);

        if (markUpdatedAt) {
            const now = new Date().toISOString();

            await setStatistic({
                key: StatisticKey.MODEL_METADATA_LAST_UPDATED_AT,
                value: now,
                database: tx,
            });
            await setStatistic({
                key: StatisticKey.MODEL_METADATA_LAST_CHECKED_AT,
                value: now,
                database: tx,
            });

            if (sourceEtag) {
                await setStatistic({
                    key: StatisticKey.MODEL_METADATA_SOURCE_ETAG,
                    value: sourceEtag,
                    database: tx,
                });
            }
        }
    });
}

export async function persistDiscoveredModels(
    {
        providerId,
        models: fetchedModels,
        entries,
    }: {
        providerId: number;
        models: readonly { id: string; name: string }[];
        entries: RecordUpstreamModelMetadataPayload['entries'];
    },
    policy: MetadataSyncPolicy
): Promise<{ addedCount: number }> {
    return await db.transaction(async (tx) => {
        const existingRows = await tx
            .select({ modelId: models.model_id })
            .from(models)
            .where(eq(models.provider_id, providerId))
            .all();
        const existingModelIds = new Set(existingRows.map((row) => row.modelId));

        const newModels = fetchedModels
            .filter((fetchedModel) => !existingModelIds.has(fetchedModel.id))
            .map((fetchedModel) => ({
                provider_id: providerId,
                name: fetchedModel.name,
                model_id: fetchedModel.id,
                is_default: 0,
            }));

        if (newModels.length > 0) {
            await createModels(newModels, tx);
        }

        if (entries.length > 0) {
            await recordUpstreamModelMetadata({ providerId, entries }, tx);
        }

        await synchronizeMetadataRows(policy, tx);

        return { addedCount: newModels.length };
    });
}
