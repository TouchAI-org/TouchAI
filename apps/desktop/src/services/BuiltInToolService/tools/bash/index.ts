// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { native } from '@services/NativeService';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type { ToolApprovalRequest } from '@/services/AgentService/contracts/tooling';
import { normalizeOptionalString, truncateText } from '@/utils/text';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import { parseToolArguments } from '../../utils/toolSchema';
import {
    BASH_TOOL_DESCRIPTION,
    BASH_TOOL_INPUT_SCHEMA,
    BASH_TOOL_NAME,
    type BashApprovalMode,
    bashApprovalPayloadSchema,
    type BashCommandContext,
    type BashToolConfig,
    DEFAULT_BASH_TOOL_CONFIG,
    type FormattedBashExecution,
    HIGH_RISK_RULES,
} from './constants';
import { formatBashToolResult, parseBashToolConfig, resolveCommandContext } from './helper';

function buildBashConversationSemantic(
    args: Record<string, unknown>
): BuiltInToolConversationSemantic {
    return {
        action: 'run',
        target: truncateText(
            normalizeOptionalString(args.command, { collapseWhitespace: true }) || '命令',
            120
        ),
    };
}

function throwIfCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
    }
}

async function executeCancelableBash(
    request: {
        executionId: string;
        command: string;
        workingDirectory?: string | null;
        timeoutMs?: number | null;
    },
    signal?: AbortSignal
) {
    throwIfCancelled(signal);

    let cancelIssued = false;
    const handleAbort = () => {
        cancelIssued = true;
        void native.builtInTools.cancelBash(request.executionId).catch((error) => {
            console.warn('[BashTool] Failed to cancel native bash execution:', error);
        });
    };

    if (signal) {
        signal.addEventListener('abort', handleAbort, { once: true });
    }

    try {
        const response = await native.builtInTools.executeBash(request);
        if (cancelIssued || response.cancelled) {
            throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        }

        throwIfCancelled(signal);
        return response;
    } catch (error) {
        if (cancelIssued || signal?.aborted) {
            throw new AiError(AiErrorCode.REQUEST_CANCELLED, error);
        }

        throw error;
    } finally {
        signal?.removeEventListener('abort', handleAbort);
    }
}

/**
 * 根据审批策略和命令内容决定是否请求用户同意。
 *
 * @param args 工具参数。
 * @param config 当前 Bash 工具配置。
 * @returns 审批请求；无需审批时返回 `null`。
 */
export function createBashApprovalRequest(
    args: Record<string, unknown>,
    config: BashToolConfig
): Promise<ToolApprovalRequest | null> {
    const parsedApprovalPayload = parseToolArguments(
        BASH_TOOL_NAME,
        bashApprovalPayloadSchema,
        args
    );
    return resolveCommandContext(args, config).then((commandContext) => {
        const requestedReason =
            parsedApprovalPayload.reason ?? parsedApprovalPayload.description ?? '';
        if (config.approvalMode === 'never') {
            return null;
        }

        const matchedRule =
            config.approvalMode === 'always'
                ? { reason: '当前配置要求所有 Bash 命令都必须先批准。' }
                : HIGH_RISK_RULES.find((rule) => rule.pattern.test(commandContext.command));

        if (!matchedRule) {
            return null;
        }

        return {
            title: '命令执行确认',
            description: requestedReason,
            command: commandContext.command,
            riskLabel: '',
            reason: matchedRule.reason,
            commandLabel: '',
            approveLabel: '批准',
            rejectLabel: '拒绝',
            enterHint: 'Enter',
            escHint: 'Esc',
            keyboardApproveDelayMs: 450,
        };
    });
}

/**
 * 执行 Bash 工具，并把原生执行结果格式化成统一文本输出。
 *
 * @param args 工具参数。
 * @param config 当前 Bash 工具配置。
 * @param context 当前执行上下文。
 * @returns 标准化后的工具执行结果。
 */
export async function executeBashTool(
    args: Record<string, unknown>,
    config: BashToolConfig,
    context: BaseBuiltInToolExecutionContext
): Promise<BuiltInToolExecutionResult> {
    const commandContext = await resolveCommandContext(args, config);
    const response = await executeCancelableBash(
        {
            executionId: context.callId,
            command: commandContext.command,
            workingDirectory: commandContext.workingDirectory,
            timeoutMs: config.timeoutMs,
        },
        context.signal
    );

    const output = response.combinedOutput.trim();
    const result = formatBashToolResult(response, commandContext, config.maxOutputChars);

    if (response.timedOut) {
        return {
            result,
            isError: true,
            status: 'timeout',
            errorMessage: 'Command execution timed out',
        };
    }

    if (!response.success) {
        return {
            result,
            isError: true,
            status: 'error',
            errorMessage: output || `Command failed with exit code ${response.exitCode}`,
        };
    }

    return {
        result,
        isError: false,
        status: 'success',
    };
}

/**
 * Bash 工具。
 */
class BashTool extends BuiltInTool<BashToolConfig> {
    readonly id = 'bash' as const;
    readonly displayName = 'Bash';
    readonly description = BASH_TOOL_DESCRIPTION;
    readonly inputSchema = BASH_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = DEFAULT_BASH_TOOL_CONFIG;

    override parseConfig(configJson: string | null): BashToolConfig {
        return parseBashToolConfig(configJson);
    }

    override buildApprovalRequest(args: Record<string, unknown>, config: BashToolConfig) {
        return createBashApprovalRequest(args, config);
    }

    override buildConversationSemantic(args: Record<string, unknown>) {
        return buildBashConversationSemantic(args);
    }

    override execute(
        args: Record<string, unknown>,
        config: BashToolConfig,
        context: BaseBuiltInToolExecutionContext
    ) {
        return executeBashTool(args, config, context);
    }
}

export const bashTool = new BashTool();
export const builtInTools: BuiltInToolGroup = [bashTool];

export { DEFAULT_BASH_TOOL_CONFIG } from './constants';
export { parseBashToolConfig, parseBashToolResult } from './helper';
export type { BashApprovalMode, BashCommandContext, BashToolConfig, FormattedBashExecution };
