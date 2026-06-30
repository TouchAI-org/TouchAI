// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';

import { tt } from '@/i18n';

import { parseToolArguments } from '../../utils/toolSchema';
import { formatUpgradeModelChain, type UpgradeModelChainEntry } from './chain';
import { UPGRADE_MODEL_TOOL_NAME, upgradeModelArgsSchema } from './constants';

export type UpgradeModelArgs = {
    role?: 'entry' | 'fast' | 'general';
    scenario?: string | null;
    restore?: boolean;
};

function formatModelLabel(model: {
    name: string;
    model_id: string;
    provider_name: string;
}): string {
    void model.model_id;
    return `${model.provider_name} / ${model.name}`;
}

export function formatCurrentModelLabel(model?: ModelWithProvider): string {
    return model ? formatModelLabel(model) : tt('未知');
}

export function buildUpgradeSummary(options: {
    currentModel?: ModelWithProvider;
    targetModel: ModelWithProvider;
    chainEntries: UpgradeModelChainEntry[];
}): string {
    return [
        tt('模型已升级'),
        `${tt('当前模型')}: ${formatCurrentModelLabel(options.currentModel)}`,
        `${tt('目标模型')}: ${formatCurrentModelLabel(options.targetModel)}`,
        `${tt('升级链')}: ${formatUpgradeModelChain(options.chainEntries)}`,
        tt('系统将直接切换到新模型，并沿当前上下文继续后续问答。'),
    ].join('\n');
}

export function parseUpgradeTargetLabel(result?: string): string | null {
    const matched = result?.match(/^(?:目标模型|Target model):\s*(.+)$/m);
    return matched?.[1]?.trim() || null;
}

export function parseUpgradeModelArgs(args: Record<string, unknown>): UpgradeModelArgs {
    return parseToolArguments(UPGRADE_MODEL_TOOL_NAME, upgradeModelArgsSchema, args);
}
