// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    type BuiltInBashExecutionResponse,
    type BuiltInBashOutputDelta,
    native,
} from '@services/NativeService';
import { log } from '@services/ObservabilityService';

import { t, tt } from '@/i18n';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type {
    AiToolDefinition,
    ToolApprovalRequest,
} from '@/services/AgentService/contracts/tooling';
import { normalizeOptionalString, truncateText } from '@/utils/text';
import { clampTimeoutMs, resolveAdaptiveTimeoutCeilingMs } from '@/utils/timeouts';

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
    BASH_TOOL_TIMEOUT_DISABLED,
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

/**
 * 流式输出合并窗口。
 *
 * 原生读取循环按很小的粒度推送 chunk，逐行输出的命令每秒可以产生几百个 chunk。
 * 如果每个 chunk 都直接生成一次 `result_delta`，会话快照发布会持续克隆整段历史，
 * 并让整棵会话树按 chunk 频率重渲染，渲染进程被占满后窗口尺寸同步等交互都会卡住。
 * 这里以固定窗口合并 UI 可见的输出快照：先到的那次立即展示，窗口内后续 chunk 合并成一次补发。
 */
const STREAM_RESULT_DELTA_INTERVAL_MS = 100;

interface StreamResultDeltaEmitter<TDelta> {
    push(delta: TDelta): void;
    flush(): void;
    cancel(): void;
}

function createStreamResultDeltaEmitter<TDelta>(
    emit: (delta: TDelta) => void,
    intervalMs = STREAM_RESULT_DELTA_INTERVAL_MS
): StreamResultDeltaEmitter<TDelta> {
    // 使用负无穷确保首个 chunk 一定走前导发送，不受运行时钟起点影响。
    let lastEmitAt = Number.NEGATIVE_INFINITY;
    let pendingDelta: TDelta | null = null;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTrailingTimer() {
        if (trailingTimer === null) {
            return;
        }

        clearTimeout(trailingTimer);
        trailingTimer = null;
    }

    function emitPendingDelta() {
        const delta = pendingDelta;
        pendingDelta = null;
        if (delta === null) {
            return;
        }

        lastEmitAt = Date.now();
        emit(delta);
    }

    function push(delta: TDelta) {
        const now = Date.now();
        if (trailingTimer === null && now - lastEmitAt >= intervalMs) {
            lastEmitAt = now;
            emit(delta);
            return;
        }

        pendingDelta = delta;
        if (trailingTimer !== null) {
            return;
        }

        trailingTimer = setTimeout(
            () => {
                trailingTimer = null;
                emitPendingDelta();
            },
            Math.max(0, intervalMs - (now - lastEmitAt))
        );
    }

    return {
        push,
        flush: () => {
            clearTrailingTimer();
            emitPendingDelta();
        },
        cancel: () => {
            clearTrailingTimer();
            pendingDelta = null;
        },
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
        compactOutput?: boolean;
        rawOutput?: boolean;
    },
    signal?: AbortSignal,
    onOutputDelta?: (event: BuiltInBashOutputDelta) => void
) {
    throwIfCancelled(signal);

    let cancelIssued = false;
    const handleAbort = () => {
        cancelIssued = true;
        void native.builtInTools.cancelBash(request.executionId).catch((error) => {
            log.warn('[BashTool] Failed to cancel native bash execution:', error);
        });
    };

    if (signal) {
        signal.addEventListener('abort', handleAbort, { once: true });
    }

    try {
        const response = await native.builtInTools.executeBash(request, {
            onOutputDelta,
        });
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

function createStreamingBashResponseSnapshot(
    commandContext: BashCommandContext,
    outputDelta: BuiltInBashOutputDelta,
    startedAt: number
): BuiltInBashExecutionResponse {
    return {
        command: commandContext.command,
        shell: 'powershell',
        workingDirectory: commandContext.workingDirectory,
        exitCode: null,
        success: false,
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - startedAt,
        stdout: outputDelta.stdout,
        stderr: outputDelta.stderr,
        combinedOutput: outputDelta.combinedOutput,
    };
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
            title: tt('命令执行确认'),
            description: requestedReason,
            command: commandContext.command,
            riskLabel: '',
            reason: tt(matchedRule.reason),
            commandLabel: '',
            approveLabel: tt('批准'),
            rejectLabel: tt('拒绝'),
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

    // 用户配置的超时既是本次执行的默认值，也是硬上限：模型只能收紧。
    // 配置为 0 表示不设超时，此时忽略模型建议（工具目录也不会给它 `_meta`）。
    const effectiveTimeout =
        config.timeoutMs > 0
            ? clampTimeoutMs(context.requestedTimeoutMs, config.timeoutMs, config.timeoutMs)
            : BASH_TOOL_TIMEOUT_DISABLED;

    const startedAt = Date.now();
    const streamEmitter = createStreamResultDeltaEmitter<BuiltInBashOutputDelta>((outputDelta) => {
        const snapshot = createStreamingBashResponseSnapshot(
            commandContext,
            outputDelta,
            startedAt
        );
        context.emitToolEvent?.({
            type: 'result_delta',
            callId: context.callId,
            result: formatBashToolResult(snapshot, commandContext, config.maxOutputChars),
        });
    });

    // 只有调用方需要工具事件时才走流式 IPC；否则保留普通的一元调用，
    // 避免无监听方时额外创建 channel 和 watchdog。
    const onOutputDelta = context.emitToolEvent
        ? (outputDelta: BuiltInBashOutputDelta) => {
              streamEmitter.push(outputDelta);
          }
        : undefined;

    let response: BuiltInBashExecutionResponse;
    try {
        response = await executeCancelableBash(
            {
                executionId: context.callId,
                command: commandContext.command,
                workingDirectory: commandContext.workingDirectory,
                timeoutMs: effectiveTimeout,
                compactOutput: config.compactOutput,
                rawOutput: commandContext.rawOutput,
            },
            context.signal,
            onOutputDelta
        );
    } catch (error) {
        // 失败或取消时不再补发半成品输出，最终状态由调用方统一收尾。
        streamEmitter.cancel();
        throw error;
    }
    streamEmitter.flush();

    const output = response.combinedOutput.trim();
    const result = formatBashToolResult(response, commandContext, config.maxOutputChars);

    if (response.timedOut) {
        return {
            result,
            isError: true,
            status: 'timeout',
            errorMessage: t('builtInTools.bash.error.timeout'),
        };
    }

    if (!response.success) {
        return {
            result,
            isError: true,
            status: 'error',
            errorMessage:
                output ||
                t('builtInTools.bash.error.exitCode', { exitCode: response.exitCode ?? 'none' }),
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

    /**
     * 用户配置的超时同时是模型可建议区间的上限：模型只能收紧本次执行。
     */
    override buildToolDefinition(namespacedName: string, config: BashToolConfig): AiToolDefinition {
        return {
            name: namespacedName,
            description: this.description,
            input_schema: this.inputSchema,
            adaptiveTimeoutCeilingMs: resolveAdaptiveTimeoutCeilingMs(config.timeoutMs),
        };
    }

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
