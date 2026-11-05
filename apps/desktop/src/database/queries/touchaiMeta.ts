// Copyright (c) 2026. 千诚. Licensed under GPL v3.

import { native } from '@services/NativeService';

import { MetaKey } from '../keys';

/**
 * 获取元数据值
 */
export async function getMeta({ key }: { key: MetaKey }): Promise<string | null> {
    return native.database.operation<string | null>({ kind: 'meta_get', key });
}

/**
 * 设置元数据值
 */
export async function setMeta({ key, value }: { key: MetaKey; value: string }): Promise<void> {
    await native.database.operation({ kind: 'meta_set', key, value });
}

/**
 * 删除元数据
 */
export async function deleteMeta({ key }: { key: MetaKey }): Promise<void> {
    await native.database.operation({ kind: 'meta_delete', key });
}
