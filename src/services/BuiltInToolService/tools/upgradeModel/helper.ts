// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';

import { parseToolArguments } from '../../utils/toolSchema';
import { formatUpgradeModelChain, type UpgradeModelChainEntry } from './chain';
import { UPGRADE_MODEL_TOOL_NAME, upgradeModelArgsSchema } from './constants';

function formatModelLabel(model: {
    name: string;
    model_id: string;
    provider_name: string;
}): string {
    return `${model.provider_name} / ${model.name} (${model.model_id})`;
}

export function formatCurrentModelLabel(model?: ModelWithProvider): string {
    return model ? formatModelLabel(model) : '未知';
}

export function buildUpgradeSummary(options: {
    currentModel?: ModelWithProvider;
    targetModel: ModelWithProvider;
    chainEntries: UpgradeModelChainEntry[];
}): string {
    return [
        '模型已升级',
        `当前模型: ${formatCurrentModelLabel(options.currentModel)}`,
        `目标模型: ${formatCurrentModelLabel(options.targetModel)}`,
        `升级链: ${formatUpgradeModelChain(options.chainEntries)}`,
        '系统将直接切换到新模型，并沿当前上下文继续后续问答。',
    ].join('\n');
}

export function parseUpgradeModelArgs(args: Record<string, unknown>): void {
    parseToolArguments(UPGRADE_MODEL_TOOL_NAME, upgradeModelArgsSchema, args);
}
