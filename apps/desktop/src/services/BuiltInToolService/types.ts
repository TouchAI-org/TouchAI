// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';
import type { BuiltInToolEntity } from '@database/types';

import type {
    AiToolDefinition,
    ToolApprovalRequest,
    ToolEvent,
    ToolEventBuiltInConversationSemantic,
    ToolEventBuiltInConversationSemanticAction,
} from '@/services/AgentService/contracts/tooling';
import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';

/**
 * 当前内置工具体系允许暴露给模型的稳定工具标识。
 */
export type BuiltInToolId =
    | 'bash'
    | 'file_search'
    | 'read'
    | 'setting'
    | 'web_fetch'
    | 'upgrade_model'
    | 'show_widget'
    | 'visualize_read_me';

/**
 * 所有内置工具共享的最小运行时上下文。
 */
export interface BaseBuiltInToolExecutionContext {
    signal?: AbortSignal;
    currentModel?: ModelWithProvider;
    callId: string;
    iteration: number;
    emitToolEvent?: (toolEvent: ToolEvent) => void;
    // 由 request 编排层提供的只读查询能力，用来表达工具间的前置依赖，
    // 但不把具体状态容器暴露给每个工具实现。
    hasExecutedBuiltInTool: (toolId: BuiltInToolId) => boolean;
}

/**
 * 由工具返回给上层请求循环的控制信号。
 *
 * 工具本身只声明“接下来应该发生什么”，真正的请求重启或模型切换
 * 仍由 AI 请求循环统一落地，避免工具直接改写外层流程状态。
 */
export interface UpgradeModelControlSignal {
    type: 'upgrade_model';
    targetModel: ModelWithProvider;
    restartCurrentRequest: boolean;
}

export type BuiltInToolControlSignal = UpgradeModelControlSignal;

/**
 * 内置工具统一执行结果。
 */
export interface BuiltInToolExecutionResult {
    result: string;
    isError: boolean;
    status: 'success' | 'error' | 'timeout';
    errorMessage?: string | null;
    approvalSummary?: string | null;
    attachments?: AttachmentIndex[];
    controlSignal?: BuiltInToolControlSignal;
}

export type BuiltInToolConversationStatus =
    | 'executing'
    | 'awaiting_approval'
    | 'completed'
    | 'error'
    | 'rejected'
    | 'cancelled';

export type BuiltInToolConversationSemanticAction = ToolEventBuiltInConversationSemanticAction;

export type BuiltInToolConversationSemantic = ToolEventBuiltInConversationSemantic;

export interface BuiltInToolConversationPresentation {
    verb: string;
    content?: string;
}

/**
 * 单个内置工具的静态描述与执行入口。
 */
export abstract class BuiltInTool<
    TConfig = unknown,
    TContext extends BaseBuiltInToolExecutionContext = BaseBuiltInToolExecutionContext,
> {
    abstract readonly id: BuiltInToolId;
    abstract readonly displayName: string;
    abstract readonly description: string;
    abstract readonly inputSchema: AiToolDefinition['input_schema'];
    abstract readonly defaultConfig: TConfig;

    /**
     * 解析数据库中持久化的工具配置。
     *
     * 默认直接回退到工具默认配置；有专门配置结构的工具再自行覆写。
     *
     * @param configJson 数据库存储的配置 JSON。
     * @returns 标准化后的工具配置。
     */
    parseConfig(configJson: string | null): TConfig {
        void configJson;
        return this.defaultConfig;
    }

    /**
     * 构建审批请求。
     *
     * 默认表示该工具无需审批；涉及副作用的工具再按需覆写。
     *
     * @param args 模型传入的工具参数。
     * @param config 当前工具配置。
     * @param namespacedName 带 `builtin__` 前缀的工具名。
     * @param context 当前执行上下文。
     * @returns 审批请求；无需审批时返回 `null`。
     */
    buildApprovalRequest(
        args: Record<string, unknown>,
        config: TConfig,
        namespacedName: string,
        context: TContext
    ): ToolApprovalRequest | null | Promise<ToolApprovalRequest | null> {
        void args;
        void config;
        void namespacedName;
        void context;
        return null;
    }

    buildConversationSemantic(args: Record<string, unknown>): BuiltInToolConversationSemantic {
        void args;
        return {
            action: 'process',
            target: this.displayName,
        };
    }

    buildConversationSemanticWithContext(
        args: Record<string, unknown>,
        config: TConfig,
        context: TContext
    ): BuiltInToolConversationSemantic | Promise<BuiltInToolConversationSemantic> {
        void config;
        void context;
        return this.buildConversationSemantic(args);
    }

    buildConversationSemanticFromResult(
        result: string,
        args: Record<string, unknown>
    ): BuiltInToolConversationSemantic | null {
        void result;
        void args;
        return null;
    }

    /**
     * 执行工具主逻辑。
     *
     * @param args 模型传入的工具参数。
     * @param config 当前工具配置。
     * @param context 当前执行上下文。
     * @returns 工具执行结果。
     */
    abstract execute(
        args: Record<string, unknown>,
        config: TConfig,
        context: TContext
    ): Promise<BuiltInToolExecutionResult>;
}

/**
 * 同一工具目录可导出的一组内置工具实例。
 *
 * 用这个类型表达“一个文件夹可以承载多个 tool”的注册约定，
 * 比各处临时写匿名数组更清晰，也便于注册表统一接收。
 */
export type BuiltInToolGroup = readonly BuiltInTool[];

/**
 * 经过“数据库启用状态 + 注册表描述符”双重解析后的可执行调用信息。
 */
export interface ResolvedBuiltInToolCall<
    TConfig = unknown,
    TContext extends BaseBuiltInToolExecutionContext = BaseBuiltInToolExecutionContext,
> {
    entity: BuiltInToolEntity;
    tool: BuiltInTool<TConfig, TContext>;
    config: TConfig;
    namespacedName: string;
}
