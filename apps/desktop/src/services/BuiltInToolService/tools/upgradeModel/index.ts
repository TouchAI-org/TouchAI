// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { findModelByProviderAndModelId } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';

import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    formatUpgradeModelChain,
    isSameUpgradeModelChainEntry,
    type UpgradeModelChainEntry,
} from './chain';
import {
    DEFAULT_UPGRADE_MODEL_TOOL_CONFIG,
    parseUpgradeModelToolConfig,
    type UpgradeModelToolConfig,
} from './config';
import { UPGRADE_MODEL_TOOL_DESCRIPTION, UPGRADE_MODEL_TOOL_INPUT_SCHEMA } from './constants';
import {
    buildUpgradeSummary,
    formatCurrentModelLabel,
    parseUpgradeModelArgs,
    parseUpgradeTargetLabel,
} from './helper';

interface ResolvedUpgradeTarget {
    chainEntry: UpgradeModelChainEntry;
    model: ModelWithProvider;
}

async function resolveChainTargets(
    chainEntries: UpgradeModelChainEntry[]
): Promise<ResolvedUpgradeTarget[]> {
    // 升级链配置引用的是 providerId/modelId。
    // 这里先一次性解析成真实模型对象，后面审批文案和执行控制信号都复用同一份结果，
    // 避免同一次工具调用在不同阶段看到不一致的目标模型。
    const resolvedEntries = await Promise.all(
        chainEntries.map(async (chainEntry) => {
            try {
                const model = await findModelByProviderAndModelId({
                    providerId: chainEntry.providerId,
                    modelId: chainEntry.modelId,
                });
                if (!model || model.provider_enabled === 0) {
                    throw new Error('Target model is unavailable');
                }
                return {
                    chainEntry,
                    model,
                };
            } catch (error) {
                console.warn('[UpgradeModel] Skip invalid chain entry:', chainEntry, error);
                return null;
            }
        })
    );

    return resolvedEntries.filter((item): item is ResolvedUpgradeTarget => Boolean(item));
}

function selectUpgradeTarget(
    currentModel: ModelWithProvider | undefined,
    chainTargets: ResolvedUpgradeTarget[]
): ResolvedUpgradeTarget {
    if (chainTargets.length === 0) {
        throw new Error('请先在 UpgradeModel 配置中设置模型升级链。');
    }

    if (!currentModel) {
        return chainTargets[0]!;
    }

    const currentRef: UpgradeModelChainEntry = {
        providerId: currentModel.provider_id,
        modelId: currentModel.model_id,
    };
    const currentIndex = chainTargets.findIndex((target) =>
        isSameUpgradeModelChainEntry(target.chainEntry, currentRef)
    );

    // 当前模型命中升级链时，行为必须严格表现为“升级到下一档”，
    // 而不是重新选择任意不同模型，否则用户维护的链顺序就失去意义。
    if (currentIndex >= 0) {
        const nextTarget = chainTargets[currentIndex + 1];
        if (!nextTarget) {
            throw new Error('当前模型已经位于升级链末尾，没有更高一级模型可用。');
        }

        return nextTarget;
    }

    // 当前模型不在链上时，说明用户可能临时切到了链外模型。
    // 这里回退到“链上第一个与当前不同的可用模型”，保证工具仍然能把会话拉回用户预设的升级轨道。
    const firstDifferentTarget = chainTargets.find(
        (target) =>
            target.model.provider_id !== currentModel.provider_id ||
            target.model.model_id !== currentModel.model_id
    );
    if (!firstDifferentTarget) {
        throw new Error('升级链中没有比当前模型不同的可用模型。');
    }

    return firstDifferentTarget;
}

async function resolveUpgradeTarget(
    currentModel: ModelWithProvider | undefined,
    config: UpgradeModelToolConfig
): Promise<{
    chainEntries: UpgradeModelChainEntry[];
    target: ResolvedUpgradeTarget;
}> {
    const chainEntries = [...config.chain];
    const chainTargets = await resolveChainTargets(chainEntries);
    const target = selectUpgradeTarget(currentModel, chainTargets);

    return {
        chainEntries,
        target,
    };
}

function buildUpgradeConversationSemantic(targetLabel: string): BuiltInToolConversationSemantic {
    return {
        action: 'switch',
        target: targetLabel,
    };
}

/**
 * 构建模型切换审批卡片。
 * @param args 工具参数。
 * @param config UpgradeModel 配置。
 * @param namespacedName 带命名空间的工具名。
 * @param context 当前执行上下文。
 * @returns 审批请求；无法解析目标模型时返回 `null`。
 */
export async function buildUpgradeModelApprovalRequest(
    args: Record<string, unknown>,
    config: UpgradeModelToolConfig,
    namespacedName: string,
    context: BaseBuiltInToolExecutionContext
): Promise<ToolApprovalRequest | null> {
    void namespacedName;

    try {
        parseUpgradeModelArgs(args);
        const { target } = await resolveUpgradeTarget(context.currentModel, config);

        // 审批阶段只负责把即将发生的模型切换说清楚。
        // 真正的切换由 execute 返回 controlSignal 后再由上层统一落地，避免审批阶段产生副作用。
        return {
            title: '模型切换确认',
            description: `允许从 ${formatCurrentModelLabel(context.currentModel)} 切换到 ${formatCurrentModelLabel(target.model)}`,
            command: `${formatCurrentModelLabel(context.currentModel)} -> ${formatCurrentModelLabel(target.model)}`,
            riskLabel: '',
            reason: '这会修改当前问答后续使用的模型，并同步影响后续默认模型。',
            commandLabel: '',
            approveLabel: '批准',
            rejectLabel: '拒绝',
            enterHint: 'Enter',
            escHint: 'Esc',
            keyboardApproveDelayMs: 450,
        };
    } catch {
        return null;
    }
}

/**
 * 执行 UpgradeModel 工具，返回统一的模型切换控制信号。
 * @param args 工具参数。
 * @param config UpgradeModel 配置。
 * @param context 当前执行上下文。
 * @returns 标准化后的工具执行结果。
 */
export async function executeUpgradeModelTool(
    args: Record<string, unknown>,
    config: UpgradeModelToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    parseUpgradeModelArgs(args);
    void context.signal;

    try {
        const { chainEntries, target } = await resolveUpgradeTarget(context.currentModel, config);

        // 工具本身不直接修改前端状态，而是返回统一的控制信号。
        // 这样模型切换、日志记录和请求重启都能继续走网关已有的单一路径。
        return {
            result: buildUpgradeSummary({
                currentModel: context.currentModel,
                targetModel: target.model,
                chainEntries,
            }),
            isError: false,
            status: 'success',
            controlSignal: {
                type: 'upgrade_model',
                targetModel: target.model,
                restartCurrentRequest: false,
            },
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
            result: [
                '模型升级失败',
                `当前模型: ${formatCurrentModelLabel(context.currentModel)}`,
                `升级链: ${formatUpgradeModelChain(config.chain)}`,
                `原因: ${errorMessage}`,
            ].join('\n'),
            isError: true,
            status: 'error',
            errorMessage,
        };
    }
}

/**
 * UpgradeModel 工具。
 */
class UpgradeModelTool extends BuiltInTool<UpgradeModelToolConfig> {
    readonly id = 'upgrade_model' as const;
    readonly displayName = 'UpgradeModel';
    readonly description = UPGRADE_MODEL_TOOL_DESCRIPTION;
    readonly inputSchema = UPGRADE_MODEL_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = DEFAULT_UPGRADE_MODEL_TOOL_CONFIG;

    override parseConfig(configJson: string | null): UpgradeModelToolConfig {
        return parseUpgradeModelToolConfig(configJson);
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        void args;
        return buildUpgradeConversationSemantic('高一级模型');
    }

    override async buildConversationSemanticWithContext(
        args: Record<string, unknown>,
        config: UpgradeModelToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        parseUpgradeModelArgs(args);
        const { target } = await resolveUpgradeTarget(context.currentModel, config);
        return buildUpgradeConversationSemantic(formatCurrentModelLabel(target.model));
    }

    override buildConversationSemanticFromResult(result: string, args: Record<string, unknown>) {
        void args;
        const targetLabel = parseUpgradeTargetLabel(result);
        return targetLabel ? buildUpgradeConversationSemantic(targetLabel) : null;
    }

    override buildApprovalRequest(
        args: Record<string, unknown>,
        config: UpgradeModelToolConfig,
        namespacedName: string,
        context: BaseBuiltInToolExecutionContext
    ) {
        return buildUpgradeModelApprovalRequest(args, config, namespacedName, context);
    }

    override execute(
        args: Record<string, unknown>,
        config: UpgradeModelToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeUpgradeModelTool(args, config, context);
    }
}

export const upgradeModelTool = new UpgradeModelTool();
export const builtInTools: BuiltInToolGroup = [upgradeModelTool];

export type { UpgradeModelToolConfig } from './config';
