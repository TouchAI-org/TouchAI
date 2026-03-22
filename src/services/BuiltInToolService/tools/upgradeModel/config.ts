// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { parseToolConfigJson, z } from '../../utils/toolSchema';
import {
    normalizeUpgradeModelChain,
    serializeUpgradeModelChain,
    type UpgradeModelChainEntry,
    upgradeModelChainEntrySchema,
} from './chain';

/**
 * `upgrade_model` 工具的配置结构。
 */
export interface UpgradeModelToolConfig {
    chain: UpgradeModelChainEntry[];
}

export const DEFAULT_UPGRADE_MODEL_TOOL_CONFIG: UpgradeModelToolConfig = {
    chain: [],
};

const upgradeModelToolConfigSchema = z
    .object({
        chain: z.array(upgradeModelChainEntrySchema).optional(),
    })
    .transform(
        (value): UpgradeModelToolConfig => ({
            chain: normalizeUpgradeModelChain(value.chain ?? []),
        })
    );

/**
 * 解析 `upgrade_model` 工具配置。
 *
 * 配置统一按对象持久化，避免工具配置格式继续分叉。
 */
export function parseUpgradeModelToolConfig(configJson: string | null): UpgradeModelToolConfig {
    return parseToolConfigJson(
        upgradeModelToolConfigSchema,
        configJson,
        DEFAULT_UPGRADE_MODEL_TOOL_CONFIG
    );
}

/**
 * 序列化 `upgrade_model` 工具配置。
 */
export function serializeUpgradeModelToolConfig(config: UpgradeModelToolConfig): string {
    return JSON.stringify({
        chain: normalizeUpgradeModelChain(config.chain),
    });
}

/**
 * 深拷贝并规范化 `upgrade_model` 配置。
 */
export function cloneUpgradeModelToolConfig(
    config: UpgradeModelToolConfig
): UpgradeModelToolConfig {
    return {
        chain: normalizeUpgradeModelChain(config.chain),
    };
}

/**
 * 生成人类可读的配置摘要。
 */
export function formatUpgradeModelToolConfigSummary(config: UpgradeModelToolConfig): string {
    return serializeUpgradeModelChain(config.chain);
}
