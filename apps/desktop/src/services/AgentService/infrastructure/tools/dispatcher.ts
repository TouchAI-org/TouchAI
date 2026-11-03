// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { tt } from '@/i18n';
import { parseRequestedTimeoutMs } from '@/utils/timeouts';
import { z } from '@/utils/zod';

import { AiError, AiErrorCode } from '../../contracts/errors';
import type { AiToolCall } from '../../contracts/tooling';
import { executeBuiltinTool } from './builtinAdapter';
import { executeMcpTool } from './mcpAdapter';
import type { ToolDispatchRequest, ToolDispatchResult } from './types';

const toolArgumentsSchema = z.record(z.string(), z.unknown());

/**
 * 这些文本会进入工具结果和会话历史，属于用户可见内容，因此统一使用中文。
 */
const formatToolArgumentJsonError = (toolName: string): string =>
    tt('工具参数协议错误：{toolName} 返回了无效的 JSON 参数。', { toolName });
const formatToolArgumentShapeError = (toolName: string, issues: string): string =>
    `${tt('工具参数协议错误：{toolName} 必须接收 JSON 对象。', { toolName })}\n${issues}`;

function formatToolArgumentsIssues(error: z.ZodError): string {
    return error.issues
        .map((issue) => {
            const path =
                issue.path.length > 0
                    ? issue.path.map((segment) => String(segment)).join('.')
                    : 'input';
            return `- "${path}": ${issue.message}`;
        })
        .join('\n');
}

function parseToolArguments(
    toolCall: AiToolCall
): { ok: true; toolArgs: Record<string, unknown> } | { ok: false; errorResult: string } {
    let parsedArguments: unknown;

    try {
        parsedArguments = JSON.parse(toolCall.arguments);
    } catch {
        return { ok: false, errorResult: formatToolArgumentJsonError(toolCall.name) };
    }

    const result = toolArgumentsSchema.safeParse(parsedArguments);
    if (!result.success) {
        return {
            ok: false,
            errorResult: formatToolArgumentShapeError(
                toolCall.name,
                formatToolArgumentsIssues(result.error)
            ),
        };
    }

    return { ok: true, toolArgs: result.data };
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
    }
}

/**
 * 平台工具分发的唯一入口：解析参数、按需剥离超时信封，再决定由内置工具还是
 * MCP 执行。
 *
 * 只拥有「怎么把一次工具调用送到正确的适配器」这一件事；并发、iteration、模型
 * 切换、checkpoint 与结果持久化仍由 attempt 循环负责，所以这里既不设迭代上限，
 * 也不改写调用方的流程状态。
 */
export async function dispatchToolCall(request: ToolDispatchRequest): Promise<ToolDispatchResult> {
    throwIfAborted(request.signal);

    const parsed = parseToolArguments(request.toolCall);
    if (!parsed.ok) {
        request.emitToolEvent({
            type: 'call_end',
            callId: request.toolCall.id,
            result: parsed.errorResult,
            isError: true,
            durationMs: 0,
            finalStatus: 'error',
        });

        return {
            toolCall: request.toolCall,
            result: parsed.errorResult,
            isError: true,
            toolLogId: null,
            argumentParseFailed: true,
        };
    }

    // 只有声明了自适应超时的工具才会把 `_meta` 当作超时信封剥离；
    // 其余工具（含自带 `_meta` 业务参数的 MCP 工具）原样透传参数。
    const supportsAdaptiveTimeout =
        request.toolDefinitions?.some(
            (tool) =>
                tool.name === request.toolCall.name && tool.adaptiveTimeoutCeilingMs !== undefined
        ) ?? false;
    const { requestedTimeoutMs, sanitizedToolArgs } = supportsAdaptiveTimeout
        ? parseRequestedTimeoutMs(parsed.toolArgs)
        : { requestedTimeoutMs: undefined, sanitizedToolArgs: parsed.toolArgs };

    const invocation = {
        context: request,
        toolArgs: sanitizedToolArgs,
        requestedTimeoutMs,
    };

    const builtinOutcome = await executeBuiltinTool(invocation);
    if (builtinOutcome) {
        return { toolCall: request.toolCall, ...builtinOutcome };
    }

    const mcpOutcome = await executeMcpTool(invocation);
    return { toolCall: request.toolCall, ...mcpOutcome };
}
