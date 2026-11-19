import type { ToolApproval, ToolInvocationScope, ToolPreparationScope } from '../../contracts';
import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../contracts/builtin';
import type { ToolMessages, ToolModelCapabilities, ToolModelReference } from '../../contracts/host';
import { parseToolArguments } from '../../execution/schema';
import {
    createUpgradeModelConfiguration,
    DEFAULT_UPGRADE_MODEL_TOOL_CONFIG,
    isSameUpgradeModelChainEntry,
    type UpgradeModelChainEntry,
    type UpgradeModelToolConfig,
} from './configuration';
import {
    UPGRADE_MODEL_TOOL_DESCRIPTION,
    UPGRADE_MODEL_TOOL_INPUT_SCHEMA,
    UPGRADE_MODEL_TOOL_NAME,
    upgradeModelArgsSchema,
} from './constants';

interface ResolvedTarget {
    chainEntry: UpgradeModelChainEntry;
    model: ToolModelReference;
}

export function createUpgradeModelTools(input: {
    messages: ToolMessages;
    models: ToolModelCapabilities;
}): BuiltInToolGroup {
    const messages = Object.freeze({
        t: input.messages.t.bind(input.messages),
        tt: input.messages.tt.bind(input.messages),
    });
    const models = Object.freeze({
        resolve: input.models.resolve.bind(input.models),
        isAvailable: input.models.isAvailable.bind(input.models),
    });
    const configuration = createUpgradeModelConfiguration(messages);
    const label = (model?: ToolModelReference) =>
        model ? `${model.provider_name} / ${model.name}` : messages.tt('未知');
    const validate = (args: Record<string, unknown>) =>
        parseToolArguments(UPGRADE_MODEL_TOOL_NAME, upgradeModelArgsSchema, args);
    const select = (current: ToolModelReference, targets: ResolvedTarget[]) => {
        if (!targets.length)
            throw new Error(messages.tt('请先在 UpgradeModel 配置中设置模型升级链。'));
        const currentIndex = targets.findIndex((target) =>
            isSameUpgradeModelChainEntry(target.chainEntry, {
                providerId: current.provider_id,
                modelId: current.model_id,
            })
        );
        if (currentIndex >= 0) {
            const next = targets[currentIndex + 1];
            if (!next)
                throw new Error(messages.tt('当前模型已经位于升级链末尾，没有更高一级模型可用。'));
            return next;
        }
        const next = targets.find(
            (target) =>
                target.model.provider_id !== current.provider_id ||
                target.model.model_id !== current.model_id
        );
        if (!next) throw new Error(messages.tt('升级链中没有比当前模型不同的可用模型。'));
        return next;
    };

    class UpgradeModelTool extends BuiltInTool<UpgradeModelToolConfig> {
        readonly id = 'upgrade_model' as const;
        readonly displayName = 'UpgradeModel';
        readonly description = UPGRADE_MODEL_TOOL_DESCRIPTION;
        readonly inputSchema = UPGRADE_MODEL_TOOL_INPUT_SCHEMA;
        readonly defaultConfig = DEFAULT_UPGRADE_MODEL_TOOL_CONFIG;

        constructor(
            private readonly prepared?: {
                taskId: string;
                current: ToolModelReference;
                target?: ResolvedTarget;
                error?: string;
            }
        ) {
            super();
        }

        override parseConfig(text: string | null) {
            return configuration.parse(text);
        }

        override async prepareForTurn(
            config: UpgradeModelToolConfig,
            scope?: ToolPreparationScope
        ) {
            if (!scope) throw new Error('TOOL_PREPARATION_REQUIRED');
            const taskId = scope.taskId;
            const current = structuredClone(scope.currentModel);
            try {
                const targets = await Promise.all(
                    config.chain.map(async (chainEntry) => {
                        try {
                            const model = await models.resolve(taskId, chainEntry);
                            return model && (await models.isAvailable(taskId, model))
                                ? { chainEntry, model: structuredClone(model) }
                                : null;
                        } catch {
                            return null;
                        }
                    })
                );
                return new UpgradeModelTool({
                    taskId,
                    current,
                    target: select(
                        current,
                        targets.filter((target): target is ResolvedTarget => target !== null)
                    ),
                });
            } catch (error) {
                return new UpgradeModelTool({
                    taskId,
                    current,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        override async isAuthorized(scope: ToolInvocationScope) {
            if (!this.prepared || scope.task?.taskId !== this.prepared.taskId) return false;
            return this.prepared.target
                ? models.isAvailable(this.prepared.taskId, this.prepared.target.model)
                : true;
        }

        override buildConversationSemantic(): BuiltInToolConversationSemantic {
            return {
                action: 'switch',
                target: this.prepared?.target
                    ? label(this.prepared.target.model)
                    : messages.tt('高一级模型'),
            };
        }

        override buildApprovalRequest(args: Record<string, unknown>): ToolApproval | null {
            validate(args);
            if (!this.prepared?.target) return null;
            const currentModel = label(this.prepared.current);
            const targetModel = label(this.prepared.target.model);
            return {
                title: messages.tt('模型切换确认'),
                description: messages.tt('允许从 {currentModel} 切换到 {targetModel}', {
                    currentModel,
                    targetModel,
                }),
                command: `${currentModel} -> ${targetModel}`,
                riskLabel: '',
                reason: messages.tt('这会修改当前问答后续使用的模型，并同步影响后续默认模型。'),
                commandLabel: '',
                approveLabel: messages.tt('批准'),
                rejectLabel: messages.tt('拒绝'),
                enterHint: 'Enter',
                escHint: 'Esc',
                keyboardApproveDelayMs: 450,
            };
        }

        override async execute(
            args: Record<string, unknown>,
            config: UpgradeModelToolConfig,
            context: BaseBuiltInToolExecutionContext
        ): Promise<BuiltInToolExecutionResult> {
            validate(args);
            context.signal?.throwIfAborted();
            const prepared = this.prepared;
            if (!prepared) throw new Error('TOOL_PREPARATION_REQUIRED');
            const target = prepared.target;
            const errorMessage =
                target && (await models.isAvailable(prepared.taskId, target.model))
                    ? undefined
                    : (prepared.error ?? 'Target model is unavailable');
            context.signal?.throwIfAborted();
            if (errorMessage || !target)
                return {
                    result: [
                        messages.tt('模型升级失败'),
                        `${messages.tt('当前模型')}: ${label(prepared.current)}`,
                        `${messages.tt('升级链')}: ${configuration.formatChain(config.chain)}`,
                        `${messages.tt('原因')}: ${errorMessage}`,
                    ].join('\n'),
                    isError: true,
                    status: 'error',
                    errorMessage,
                };
            return {
                result: [
                    messages.tt('模型已升级'),
                    `${messages.tt('当前模型')}: ${label(prepared.current)}`,
                    `${messages.tt('目标模型')}: ${label(target.model)}`,
                    `${messages.tt('升级链')}: ${configuration.formatChain(config.chain)}`,
                    messages.tt('系统将直接切换到新模型，并沿当前上下文继续后续问答。'),
                ].join('\n'),
                isError: false,
                status: 'success',
                controlSignal: {
                    type: 'upgrade_model',
                    targetModel: target.model,
                    restartCurrentRequest: false,
                },
            };
        }
    }
    return [new UpgradeModelTool()];
}
