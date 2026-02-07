// Copyright (c) 2025. 千诚. Licensed under GPL v3

import { db } from '../index';
import type { LlmMetadata, LlmMetadataUpdate, NewLlmMetadata } from '../schema';

/**
 * 根据 model_id 查询 LLM 元数据
 */
export async function findLlmMetadataByModelId(modelId: string): Promise<LlmMetadata | null> {
    const kysely = await db.getKysely();
    const result = await kysely
        .selectFrom('llm_metadata')
        .selectAll()
        .where('model_id', '=', modelId)
        .executeTakeFirst();

    return result || null;
}

/**
 * 批量插入 LLM 元数据
 * 使用 INSERT OR IGNORE 避免重复插入（基于 model_id 的 UNIQUE 约束）
 */
export async function insertLlmMetadata(metadata: NewLlmMetadata[]): Promise<void> {
    if (metadata.length === 0) return;

    const kysely = await db.getKysely();

    // 使用 onConflict 处理重复的 model_id
    await kysely
        .insertInto('llm_metadata')
        .values(metadata)
        .onConflict((oc) => oc.column('model_id').doNothing())
        .execute();
}

/**
 * 更新或创建 LLM 元数据
 */
export async function upsertLlmMetadata(modelId: string, data: LlmMetadataUpdate): Promise<void> {
    const kysely = await db.getKysely();

    // 检查是否存在
    const existing = await findLlmMetadataByModelId(modelId);

    if (existing) {
        // 更新
        await kysely
            .updateTable('llm_metadata')
            .set(data)
            .where('model_id', '=', modelId)
            .execute();
    } else {
        // 创建
        await kysely
            .insertInto('llm_metadata')
            .values({
                model_id: modelId,
                name: modelId,
                attachment: 0,
                modalities: JSON.stringify({ input: [], output: [] }),
                open_weights: 0,
                reasoning: 0,
                temperature: 1,
                tool_call: 0,
                ...data,
            })
            .execute();
    }
}

/**
 * 清空 LLM 元数据表
 */
export async function clearLlmMetadata(): Promise<void> {
    const kysely = await db.getKysely();
    await kysely.deleteFrom('llm_metadata').execute();
}
