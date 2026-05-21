// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseJsonWithSchema } from '@/utils/zod';

import { nonEmptyTrimmedStringSchema, z } from '../../utils/toolSchema';

/**
 * 升级链中的单个模型引用。
 *
 * 使用 `providerId + modelId` 组合作为持久化标识，
 * 避免依赖本地数据库自增 ID 这种不稳定主键。
 */
export interface UpgradeModelChainEntry {
    providerId: number;
    modelId: string;
}

export const upgradeModelChainEntrySchema = z.object({
    providerId: z.number().int(),
    modelId: nonEmptyTrimmedStringSchema,
});

/**
 * 判断未知值是否是可接受的升级链项。
 */
export function isUpgradeModelChainEntry(value: unknown): value is UpgradeModelChainEntry {
    return upgradeModelChainEntrySchema.safeParse(value).success;
}

/**
 * 规范化单个升级链项。
 */
export function normalizeUpgradeModelChainEntry(value: unknown): UpgradeModelChainEntry {
    const result = upgradeModelChainEntrySchema.safeParse(value);
    if (!result.success) {
        throw new Error('升级链条中的每一项都必须包含 providerId 和非空 modelId。');
    }

    return result.data;
}

/**
 * 规范化升级链条数组，并去重保留首次出现的顺序。
 */
export function normalizeUpgradeModelChain(value: unknown): UpgradeModelChainEntry[] {
    if (value === undefined || value === null || value === '') {
        return [];
    }

    const rawEntries =
        typeof value === 'string'
            ? parseJsonWithSchema(
                  z.array(z.unknown()),
                  value,
                  '升级链条必须是数组或可解析为数组的 JSON 字符串。'
              )
            : value;

    if (!Array.isArray(rawEntries)) {
        throw new Error('升级链条必须是数组或可解析为数组的 JSON 字符串。');
    }

    const normalizedEntries = z.array(upgradeModelChainEntrySchema).parse(rawEntries);
    const seen = new Set<string>();

    return normalizedEntries.filter((entry) => {
        const key = `${entry.providerId}:${entry.modelId}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

/**
 * 将升级链条序列化为 JSON 字符串。
 */
export function serializeUpgradeModelChain(entries: UpgradeModelChainEntry[]): string {
    return JSON.stringify(normalizeUpgradeModelChain(entries));
}

/**
 * 判断两个模型引用是否指向同一模型。
 */
export function isSameUpgradeModelChainEntry(
    left: UpgradeModelChainEntry,
    right: UpgradeModelChainEntry
): boolean {
    return left.providerId === right.providerId && left.modelId === right.modelId;
}

/**
 * 将升级链条格式化为单行摘要。
 */
export function formatUpgradeModelChain(entries: UpgradeModelChainEntry[]): string {
    if (entries.length === 0) {
        return '未配置';
    }

    return entries.map((entry) => `${entry.providerId}:${entry.modelId}`).join(' -> ');
}
