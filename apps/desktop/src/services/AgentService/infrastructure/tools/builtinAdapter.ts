// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { builtInToolService } from '@/services/BuiltInToolService';

import type { BuiltinToolOutcome, ToolCallInvocation } from './types';

/**
 * 执行一次内置工具调用。
 *
 * 审批、ask_user 提问、工具事件、调用日志与 native 执行都由
 * `builtInToolService` 负责；这里只把 attempt 循环的上下文转交过去，不重复它
 * 已有的逻辑。返回 `null` 表示工具名不是已启用的内置工具，调用方据此回退到 MCP。
 */
export async function executeBuiltinTool(
    invocation: ToolCallInvocation
): Promise<BuiltinToolOutcome | null> {
    const { context, toolArgs, requestedTimeoutMs } = invocation;
    const response = await builtInToolService.executeTool({
        toolCall: context.toolCall,
        toolArgs,
        iteration: context.iteration,
        currentModel: context.currentModel,
        hasExecutedBuiltInTool: context.hasExecutedBuiltInTool,
        signal: context.signal,
        toolCallMessageId: context.toolCallMessageId,
        sessionId: context.sessionId,
        requestToolApproval: context.requestToolApproval,
        requestUserQuestions: context.requestUserQuestions,
        emitToolEvent: context.emitToolEvent,
        requestedTimeoutMs,
    });

    if (!response) {
        return null;
    }

    return {
        builtInToolId: response.builtInToolId,
        result: response.result,
        isError: response.isError,
        toolLogId: response.toolLogId,
        attachments: response.attachments,
        controlSignal: response.controlSignal,
    };
}
