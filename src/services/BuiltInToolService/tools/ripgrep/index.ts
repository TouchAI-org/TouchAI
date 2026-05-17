// Copyright (c) 2026. 千诚. Licensed under GPL v3.

/**
 * Ripgrep 内置工具入口。
 *
 * 负责三件事：
 * 1. 把模型参数翻译为原生 rg 执行请求（via helper）
 * 2. 管理 AbortSignal 与原生侧取消信号的桥接
 * 3. 解析 rg 输出并返回统一的 BuiltInToolExecutionResult
 */

import { native } from '@services/NativeService';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import { RIPGREP_TOOL_DESCRIPTION, RIPGREP_TOOL_INPUT_SCHEMA } from './constants';
import { buildRipgrepRequest, formatRipgrepResult, parseRipgrepJsonLines } from './helper';

/** 从参数中提取 pattern 作为对话面板的搜索目标展示。 */
function buildConversationSemantic(args: Record<string, unknown>): BuiltInToolConversationSemantic {
    return {
        action: 'search',
        target: truncateText(
            normalizeOptionalString(args.pattern, { collapseWhitespace: true }) || 'content',
            120
        ),
    };
}

function throwIfCancelled(signal?: AbortSignal) {
    if (signal?.aborted) {
        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
    }
}

/**
 * 包装原生 rg 执行，接入 AbortSignal 取消机制。
 *
 * 信号触发时通知原生侧 cancelRipgrep，等待原生侧确认取消或进程自行终止。
 * 前后都检查信号状态，覆盖"请求已取消但响应尚未返回"的时序问题。
 */
async function executeCancelableRipgrep(
    request: {
        executionId: string;
        argv: string[];
        workingDirectory?: string | null;
        timeoutMs?: number | null;
    },
    signal?: AbortSignal
) {
    throwIfCancelled(signal);
    let cancelIssued = false;
    const handleAbort = () => {
        cancelIssued = true;
        void native.builtInTools.cancelRipgrep(request.executionId).catch((error) => {
            console.warn('[RipgrepTool] Failed to cancel native ripgrep execution:', error);
        });
    };

    signal?.addEventListener('abort', handleAbort, { once: true });
    try {
        const response = await native.builtInTools.executeRipgrep(request);
        if (cancelIssued || response.cancelled) {
            throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        }
        throwIfCancelled(signal);
        return response;
    } finally {
        signal?.removeEventListener('abort', handleAbort);
    }
}

/**
 * Ripgrep 工具的完整执行入口。
 *
 * 构建请求 → 可取消执行 → 解析 JSON 输出 → 格式化结果。
 * rg 退出码 0 和 1 都视为成功（1 = 无匹配），其他退出码或超时视为错误。
 */
export async function executeRipgrepTool(
    args: Record<string, unknown>,
    config: Record<string, never>,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    void config;
    const requestContext = buildRipgrepRequest(args);
    const response = await executeCancelableRipgrep(
        { ...requestContext.request, executionId: context.callId },
        context.signal
    );

    const matches = parseRipgrepJsonLines(response.stdout);
    const result = formatRipgrepResult(requestContext, response, matches);

    if (response.timedOut) {
        return {
            result,
            isError: true,
            status: 'timeout',
            errorMessage: 'Ripgrep search timed out',
        };
    }

    if (response.exitCode !== 0 && response.exitCode !== 1) {
        return {
            result,
            isError: true,
            status: 'error',
            errorMessage:
                response.stderr.trim() || `ripgrep failed with exit code ${response.exitCode}`,
        };
    }

    return {
        result,
        isError: false,
        status: 'success',
    };
}

/** 内置工具描述符，向注册表暴露 id、描述、schema 和执行入口。 */
class RipgrepTool extends BuiltInTool<Record<string, never>> {
    readonly id = 'ripgrep' as const;
    readonly displayName = 'Ripgrep';
    readonly description = RIPGREP_TOOL_DESCRIPTION;
    readonly inputSchema = RIPGREP_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildConversationSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: Record<string, never>,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeRipgrepTool(args, config, context);
    }
}

export const ripgrepTool = new RipgrepTool();
export const builtInTools: BuiltInToolGroup = [ripgrepTool];
