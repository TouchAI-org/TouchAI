// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { eq } from 'drizzle-orm';

import { db } from '../index';
import { MetaKey, touchaiMeta } from '../schema';

/**
 * 获取元数据值
 */
export async function getMeta({ key }: { key: MetaKey }): Promise<string | null> {
    const result = await db
        .select({ value: touchaiMeta.value })
        .from(touchaiMeta)
        .where(eq(touchaiMeta.key, key))
        .get();

    return result?.value ?? null;
}

/**
 * 设置元数据值
 */
export async function setMeta({ key, value }: { key: MetaKey; value: string }): Promise<void> {
    const drizzle = db;
    await drizzle
        .insert(touchaiMeta)
        .values({ key, value })
        .onConflictDoUpdate({ target: touchaiMeta.key, set: { value } })
        .run();
}

/**
 * 删除元数据
 */
export async function deleteMeta({ key }: { key: MetaKey }): Promise<void> {
    await db.delete(touchaiMeta).where(eq(touchaiMeta.key, key)).run();
}
