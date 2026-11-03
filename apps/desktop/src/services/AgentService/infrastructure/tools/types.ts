// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ModelWithProvider } from '@database/queries/models';

import type { BuiltInToolControlSignal, BuiltInToolId } from '@/services/BuiltInToolService';

import type {
    AiToolCall,
    AiToolDefinition,
    AskUserAnswer,
    AskUserQuestion,
    ToolApprovalDecisionRequest,
    ToolEvent,
} from '../../contracts/tooling';
import type { AttachmentIndex } from '../attachments';

/**
 * 单次工具调用的平台无关上下文，由 attempt 循环在调用点装配。
 *
 * 只承载分发所需的运行时信息；模型切换、checkpoint、iteration 计数等请求级
 * 状态仍由 executor 持有，不进入这里。
 */
export interface ToolCallContext {
    toolCall: AiToolCall;
    iteration: number;
    currentModel: ModelWithProvider;
    signal?: AbortSignal;
    sessionId: number | null;
    toolCallMessageId: number | null;
    emitToolEvent: (event: ToolEvent) => void;
    requestToolApproval?: (payload: ToolApprovalDecisionRequest) => Promise<boolean>;
    requestUserQuestions?: (
        callId: string,
        questions: AskUserQuestion[]
    ) => Promise<AskUserAnswer[] | null>;
}

/**
 * 交给具体适配器的调用参数。
 *
 * `toolArgs` 是已按需剥离超时信封后的业务参数；`requestedTimeoutMs` 是模型
 * 通过 `_meta.timeoutMs` 建议、且该工具声明支持自适应超时时才解析出的值。
 */
export interface ToolCallInvocation {
    context: ToolCallContext;
    toolArgs: Record<string, unknown>;
    requestedTimeoutMs?: number;
}

/**
 * 分发请求：调用上下文加上当前解析出的工具目录。
 *
 * 工具目录只用于判断某个工具是否声明了自适应超时上限，即是否允许把
 * `_meta` 当作超时信封剥离；它不参与执行。
 */
export interface ToolDispatchRequest extends ToolCallContext {
    toolDefinitions?: AiToolDefinition[];
}

/**
 * 内置工具适配器的执行结果。
 *
 * `null` 表示工具名不命中任何已启用的内置工具，调用方据此回退到 MCP。
 */
export interface BuiltinToolOutcome {
    builtInToolId: BuiltInToolId;
    result: string;
    persistedResult?: string;
    isError: boolean;
    toolLogId: number | null;
    attachments?: AttachmentIndex[];
    controlSignal?: BuiltInToolControlSignal;
}

/** MCP 工具适配器的执行结果。 */
export interface McpToolOutcome {
    result: string;
    isError: boolean;
    toolLogId: number | null;
    attachments?: AttachmentIndex[];
}

/**
 * 统一的平台工具分发结果。
 *
 * 形状与 executor 现有的工具执行结果一致；`argumentParseFailed` 额外标记参数
 * 在进入任何适配器之前就已失败，供调用方累计结构化输出指标。
 */
export interface ToolDispatchResult {
    toolCall: AiToolCall;
    result: string;
    persistedResult?: string;
    isError: boolean;
    toolLogId: number | null;
    attachments?: AttachmentIndex[];
    builtInToolId?: BuiltInToolId;
    controlSignal?: BuiltInToolControlSignal;
    argumentParseFailed?: boolean;
}
