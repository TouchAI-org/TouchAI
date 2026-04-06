// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { count, eq } from 'drizzle-orm';

import { db } from '../index';
import { llmMetadata } from '../schema';
import type { LlmMetadataCreateData, LlmMetadataEntity } from '../types';

/**
 * 根据 model_id 查询 LLM 元数据
 */
export async function findLlmMetadataByModelId({
    modelId,
}: {
    modelId: string;
}): Promise<LlmMetadataEntity | null> {
    const result = await db
        .select()
        .from(llmMetadata)
        .where(eq(llmMetadata.model_id, modelId))
        .get();

    return result || null;
}

/**
 * 批量插入 LLM 元数据
 * 使用 INSERT OR IGNORE 避免重复插入（基于 model_id 的 UNIQUE 约束）
 */
export async function insertLlmMetadata(data: LlmMetadataCreateData[]): Promise<void> {
    if (data.length === 0) return;

    await db
        .insert(llmMetadata)
        .values(data)
        .onConflictDoNothing({ target: llmMetadata.model_id })
        .run();
}

/**
 * 清空 LLM 元数据表
 */
export async function clearLlmMetadata(): Promise<void> {
    await db.delete(llmMetadata).run();
}

/**
 * 检查 LLM 元数据表是否为空
 */
export async function isLlmMetadataEmpty(): Promise<boolean> {
    const result = await db.select({ count: count() }).from(llmMetadata).get();

    return (result?.count ?? 0) === 0;
}
