// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { BuiltInBashExecutionResponse } from '@services/NativeService';

import type { AiToolDefinition } from '@/services/AgentService/contracts/tooling';

import {
    nonEmptyTrimmedStringSchema,
    optionalIntegerInRangeSchema,
    optionalTrimmedStringSchema,
    z,
} from '../../utils/toolSchema';

export const BASH_TOOL_NAME = 'Bash';

/**
 * Bash 单次执行允许的超时上限（毫秒）。
 *
 * 必须与 Rust 侧 `core::built_in_tools::bash` 的 `MAX_TIMEOUT_MS` 保持一致：
 * 这里是本地配置与模型建议超时的共同封顶值，任一侧更小都会造成静默截断。
 */
export const BASH_TOOL_TIMEOUT_MAX_MS = 120000;

/**
 * Bash 的“不设超时”配置值。
 *
 * 与常见 CLI 语义一致：`0` 表示关闭超时，命令只受用户取消约束，
 * 用于人工确认过的长任务；正数则视为单次执行上限。
 */
export const BASH_TOOL_TIMEOUT_DISABLED = 0;

/**
 * Bash 工具的审批策略。
 */
export type BashApprovalMode = 'high_risk' | 'always' | 'never';

/**
 * Bash 工具的持久化配置。
 */
export interface BashToolConfig {
    approvalMode: BashApprovalMode;
    defaultWorkingDirectory: string;
    allowedWorkingDirectories: string[];
    timeoutMs: number;
    maxOutputChars: number;
    compactOutput: boolean;
}

/**
 * 一次命令执行在真正落地前的标准化上下文。
 */
export interface BashCommandContext {
    command: string;
    workingDirectory: string;
    rawOutput: boolean;
}

/**
 * Bash 工具执行后用于展示的格式化结果。
 */
export interface FormattedBashExecution {
    response: BuiltInBashExecutionResponse;
    commandContext: BashCommandContext;
    combinedOutput: string;
}

/**
 * Bash 工具默认配置。
 */
export const DEFAULT_BASH_TOOL_CONFIG: BashToolConfig = {
    approvalMode: 'high_risk',
    defaultWorkingDirectory: '',
    allowedWorkingDirectories: [],
    // 与参考实现保持一致的前台默认值：2 分钟。
    timeoutMs: BASH_TOOL_TIMEOUT_MAX_MS,
    maxOutputChars: 12000,
    compactOutput: false,
};

export const bashCommandContextSchema = z.object({
    command: nonEmptyTrimmedStringSchema,
    workingDirectory: optionalTrimmedStringSchema,
    rawOutput: z.boolean().optional(),
});

export const bashApprovalPayloadSchema = bashCommandContextSchema.extend({
    reason: optionalTrimmedStringSchema,
    description: optionalTrimmedStringSchema,
});

export const bashToolConfigSchema = z
    .object({
        approvalMode: z.enum(['high_risk', 'always', 'never']).optional().catch(undefined),
        defaultWorkingDirectory: optionalTrimmedStringSchema.catch(undefined),
        allowedWorkingDirectories: z
            .preprocess((value) => {
                if (!Array.isArray(value)) {
                    return undefined;
                }

                return value;
            }, z.array(nonEmptyTrimmedStringSchema).optional())
            .catch(undefined),
        // 0 表示不设超时（见 BASH_TOOL_TIMEOUT_DISABLED），正数则收敛到执行器上限。
        timeoutMs: optionalIntegerInRangeSchema(
            BASH_TOOL_TIMEOUT_DISABLED,
            BASH_TOOL_TIMEOUT_MAX_MS
        ).catch(undefined),
        maxOutputChars: optionalIntegerInRangeSchema(1000, 50000).catch(undefined),
        compactOutput: z.boolean().optional().catch(undefined),
    })
    .transform(
        (value): BashToolConfig => ({
            approvalMode: value.approvalMode ?? DEFAULT_BASH_TOOL_CONFIG.approvalMode,
            defaultWorkingDirectory:
                value.defaultWorkingDirectory ?? DEFAULT_BASH_TOOL_CONFIG.defaultWorkingDirectory,
            allowedWorkingDirectories:
                value.allowedWorkingDirectories && value.allowedWorkingDirectories.length > 0
                    ? value.allowedWorkingDirectories
                    : DEFAULT_BASH_TOOL_CONFIG.allowedWorkingDirectories,
            timeoutMs: value.timeoutMs ?? DEFAULT_BASH_TOOL_CONFIG.timeoutMs,
            maxOutputChars: value.maxOutputChars ?? DEFAULT_BASH_TOOL_CONFIG.maxOutputChars,
            compactOutput: value.compactOutput ?? DEFAULT_BASH_TOOL_CONFIG.compactOutput,
        })
    );

// 这里只做保守的高风险启发式识别；
// 真正是否批准仍交给用户确认，避免误判导致完全阻断可用命令。
export const HIGH_RISK_RULES: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\b(remove-item|del|erase|rm)\b/i, reason: '命令可能删除文件或目录。' },
    { pattern: /\b(git\s+reset|git\s+clean)\b/i, reason: '命令可能重置或清理 Git 工作区。' },
    {
        pattern: /\b(copy-item|move-item|rename-item|new-item|set-content|add-content|out-file)\b/i,
        reason: '命令可能修改或覆盖文件内容。',
    },
    { pattern: />\s*[^>]/, reason: '命令包含输出重定向，可能覆写文件。' },
    {
        pattern: /\b(reg\s+(add|delete)|shutdown|restart-computer|stop-computer|format-volume)\b/i,
        reason: '命令可能修改系统配置或影响设备状态。',
    },
];

/**
 * 暴露给模型的 Bash 工具说明。
 */
export const BASH_TOOL_DESCRIPTION = [
    'Execute terminal commands in the real local environment.',
    'Platform: Windows.',
    'Shell: Windows PowerShell (`powershell.exe` run with `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command`).',
    'Use PowerShell syntax, cmdlets, and Windows paths instead of bash/sh syntax.',
    'For multiline text in PowerShell, prefer here-strings such as `@\'...\'@` or `@"..."@` instead of `\\n` escape sequences.',
    '`rg` (ripgrep) is available on PATH. For content/code search, ALWAYS use `rg` instead of `Select-String`, `findstr`, or reading files manually — ripgrep is faster, respects .gitignore, and supports regex.',
    'Common rg examples: `rg "pattern" src/`, `rg -t ts "pattern"`, `rg --json "pattern" src/`, `rg -g "*.ts" "pattern"`.',
].join(' ');

/**
 * 暴露给模型的 Bash 工具输入 schema。
 */
export const BASH_TOOL_INPUT_SCHEMA: AiToolDefinition['input_schema'] = {
    type: 'object',
    properties: {
        command: {
            type: 'string',
            description:
                'The Windows PowerShell command to execute. Use PowerShell syntax. For multiline text, prefer here-strings instead of `\\n` escape sequences.',
        },
        reason: {
            type: 'string',
            description:
                'Required user-facing explanation for the approval UI: explain why this command is needed, what it will do, and any important impact or risk.',
        },
        workingDirectory: {
            type: 'string',
            description: 'Optional working directory inside the configured allowlist.',
        },
        rawOutput: {
            type: 'boolean',
            description:
                'Default false: command output is compressed to essential information. Set to true if the compressed output is missing information you need — this returns the raw, unfiltered result (WILL RERUN).',
            default: false,
        },
    },
    required: ['command', 'reason'],
};
