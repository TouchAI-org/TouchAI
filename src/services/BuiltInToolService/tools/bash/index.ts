// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { ToolApprovalRequest } from '@services/AiService/types';
import { native } from '@services/NativeService';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
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
import { parseBashToolConfig, resolveCommandContext, truncateOutput } from './helper';

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
): ToolApprovalRequest | null {
    const parsedApprovalPayload = parseToolArguments(
        BASH_TOOL_NAME,
        bashApprovalPayloadSchema,
        args
    );
    const commandContext = resolveCommandContext(args, config);
    const requestedReason = parsedApprovalPayload.reason ?? parsedApprovalPayload.description ?? '';
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
    const commandContext = resolveCommandContext(args, config);
    const response = await native.builtInTools.executeBash({
        command: commandContext.command,
        workingDirectory: commandContext.workingDirectory,
        timeoutMs: config.timeoutMs,
    });

    void context.signal;

    const header = [
        `Shell: ${response.shell}`,
        `Working directory: ${commandContext.workingDirectory}`,
        `Exit code: ${response.exitCode ?? 'none'}`,
        `Duration: ${response.durationMs}ms`,
    ].join('\n');
    const output = truncateOutput(response.combinedOutput.trim(), config.maxOutputChars);
    const result = [header, '', output || '[命令无输出]'].join('\n');

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
export { parseBashToolConfig } from './helper';
export type { BashApprovalMode, BashCommandContext, BashToolConfig, FormattedBashExecution };
