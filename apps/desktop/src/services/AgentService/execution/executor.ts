// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMcpToolLog, updateMcpToolLogByCallId } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import type { ProviderDriver } from '@database/schema';
import type { Span } from '@opentelemetry/api';
import { error as obsError, event, log } from '@services/ObservabilityService';
import { ATTR } from '@services/ObservabilityService/attributes';
import { serializeAuditPayload } from '@services/ObservabilityService/redact';
import { withSpan } from '@services/ObservabilityService/tracing';

import { tt } from '@/i18n';
import {
    type BuiltInToolControlSignal,
    type BuiltInToolId,
    builtInToolService,
} from '@/services/BuiltInToolService';
import { parseRequestedTimeoutMs } from '@/utils/timeouts';
import { z } from '@/utils/zod';

import { createProviderForModel, getModel, resolveToolDefinitions } from '../catalog';
import { AiError, AiErrorCode } from '../contracts/errors';
import {
    addAiUsage,
    type AiCallRecord,
    type AiMessage,
    type AiStreamChunk,
    type AiUsage,
    emptyAiUsage,
    type JsonObject,
    normalizeOutputParts,
    type PersistedOutputPart,
} from '../contracts/protocol';
import {
    DEFAULT_REASONING_LEVEL,
    parseReasoningOptions,
    type ReasoningOption,
    type SelectableReasoningLevel,
} from '../contracts/reasoning';
import type {
    AiToolCall,
    AiToolDefinition,
    AskUserAnswer,
    AskUserQuestion,
    ToolApprovalDecisionRequest,
    ToolEventModelSummary,
} from '../contracts/tooling';
import {
    type AttachmentIndex,
    buildAttachmentParts,
    getModelAttachmentCapabilities,
    getUnsupportedAttachmentTypes,
} from '../infrastructure/attachments';
import { mcpManager } from '../infrastructure/mcp';
import { type AiProvider, parseProviderConfigJson } from '../infrastructure/providers';
import { createProviderFromRegistry } from '../infrastructure/providers/drivers';
import type { ModelLanguageContext } from '../languageContext';
import { PersistenceProjector } from '../outputs/persistence';
import type { TurnEvent } from './runtime';

const BUILT_IN_UPGRADE_TOOL_NAME = 'builtin__upgrade_model';
const MAX_REQUEST_MODEL_SWITCHES = 4;
const MODEL_SWITCH_EXCLUDED_TOOL_NAMES = [BUILT_IN_UPGRADE_TOOL_NAME];
const toolArgumentsSchema = z.record(z.string(), z.unknown());
/**
 * 这些文本会进入工具结果和会话历史，属于用户可见内容，因此统一使用中文。
 * console 日志仍保留英文，便于对齐 SDK、provider 和协议层排障信息。
 */
const formatToolArgumentJsonError = (toolName: string): string =>
    tt('工具参数协议错误：{toolName} 返回了无效的 JSON 参数。', { toolName });
const formatToolArgumentShapeError = (toolName: string, issues: string): string =>
    `${tt('工具参数协议错误：{toolName} 必须接收 JSON 对象。', { toolName })}\n${issues}`;
const formatToolNotFoundError = (toolName: string): string =>
    tt('未找到工具：{toolName}', { toolName });
const formatToolExecutionFailedError = (errorMessage: string): string =>
    tt('工具执行失败：{error}', { error: errorMessage });

/** 合并 reasoning 片段的 providerOptions（外层 provider，内层字段）。 */
function mergeReasoningProviderOptions(
    target: Record<string, JsonObject> | undefined,
    incoming: Record<string, JsonObject> | undefined
): Record<string, JsonObject> | undefined {
    if (!incoming) return target;
    const merged: Record<string, JsonObject> = { ...(target ?? {}) };
    for (const [provider, options] of Object.entries(incoming)) {
        merged[provider] = { ...(merged[provider] ?? {}), ...options };
    }
    return merged;
}

interface ProviderErrorDetails {
    statusCode?: number;
    url?: string;
    responseBody?: unknown;
    requestBodyValues?: unknown;
    data?: unknown;
}

export interface RequestExecutionCallbacks {
    taskId?: string;
    signal?: AbortSignal;
    onChunk?: (chunk: AiStreamChunk) => void;
    onTurnEvent?: (event: TurnEvent) => void;
    onAttachmentManifestResolved?: (
        request: import('../contracts/protocol').AttachmentDeliveryManifestRequest
    ) => Promise<void> | void;
    requestToolApproval?: (payload: ToolApprovalDecisionRequest) => Promise<boolean>;
    requestUserQuestions?: (
        callId: string,
        questions: AskUserQuestion[]
    ) => Promise<AskUserAnswer[] | null>;
}

export interface AttemptCheckpoint {
    activeModel: ModelWithProvider;
    messages: AiMessage[];
    response: string;
    reasoning: string;
    iteration: number;
    modelSwitchCount: number;
    modelLanguageContext: ModelLanguageContext;
    executedBuiltInToolIds: BuiltInToolId[];
    /** Ordered output accumulated before the next safe tool checkpoint. */
    outputParts: PersistedOutputPart[];
}

interface AttemptRuntime {
    activeModel: ModelWithProvider;
    provider: AiProvider;
    tools?: AiToolDefinition[];
    messages: AiMessage[];
    response: string;
    reasoning: string;
    iteration: number;
    modelSwitchCount: number;
    modelLanguageContext: ModelLanguageContext;
    hasVisibleOutputSinceCheckpoint: boolean;
    hasToolActivitySinceCheckpoint: boolean;
    executedBuiltInTools: Set<BuiltInToolId>;
    outputParts: PersistedOutputPart[];
    currentStepOutputParts: PersistedOutputPart[];
    currentStepReasoningStartedAt: number | null;
    /** 本 attempt 内所有 LLM 调用记录，按 iteration 顺序 */
    calls: AiCallRecord[];
    /** 累加的总用量 */
    totalUsage: AiUsage;
    /** 首字延迟取第一次调用（后续轮次的首字对用户体验无意义） */
    firstTtftMs: number | null;
    firstTextMs: number | null;
    /** 工具参数解析失败次数（量化结构化输出能力） */
    toolArgumentErrors: number;
    /** 工具调用被用户拒绝次数 */
    /** 是否触达模型切换上限 */
    hitModelSwitchCeiling: boolean;
}

interface ToolExecutionResult {
    toolCall: AiToolCall;
    result: string;
    isError: boolean;
    toolLogId: number | null;
    attachments?: AttachmentIndex[];
    builtInToolId?: BuiltInToolId;
    controlSignal?: BuiltInToolControlSignal;
}

type AttemptStepResult =
    | {
          type: 'done';
          outputParts: PersistedOutputPart[];
          call: AiCallRecord;
      }
    | {
          type: 'tool_calls';
          outputParts: PersistedOutputPart[];
          toolCalls: AiToolCall[];
          call: AiCallRecord;
      };

export type AttemptExecutionResult =
    | {
          type: 'completed';
          model: ModelWithProvider;
          response: string;
          reasoning: string;
          finalStepOutputParts: PersistedOutputPart[];
          calls: AiCallRecord[];
          totalUsage: AiUsage;
          firstTtftMs: number | null;
          firstTextMs: number | null;
          toolArgumentErrors: number;
          modelSwitchCount: number;
          hitModelSwitchCeiling: boolean;
      }
    | {
          type: 'failed';
          error: AiError;
          response: string;
          reasoning: string;
          partialOutputParts: PersistedOutputPart[];
          resumeCheckpoint: AttemptCheckpoint;
          hasVisibleOutputSinceCheckpoint: boolean;
          hasToolActivitySinceCheckpoint: boolean;
          providerErrorDetails: ProviderErrorDetails | null;
          calls: AiCallRecord[];
          totalUsage: AiUsage;
          firstTtftMs: number | null;
          firstTextMs: number | null;
          toolArgumentErrors: number;
          modelSwitchCount: number;
          hitModelSwitchCeiling: boolean;
      };

export type AttemptFailureResult = Extract<AttemptExecutionResult, { type: 'failed' }>;

export interface RunAttemptOptions extends RequestExecutionCallbacks {
    startCheckpoint: AttemptCheckpoint;
    persister: PersistenceProjector;
    parentSpan?: Span;
}

function isProviderErrorDetails(value: unknown): value is ProviderErrorDetails {
    return !!value && typeof value === 'object';
}

/**
 * AI SDK 的 RetryError 将真正的错误包在 lastError 中。
 * 解包后返回底层错误，以便 AiError.fromError 能正确分类。
 */
function unwrapRetryError(error: unknown): unknown {
    let current = error;
    const visited = new Set<unknown>();

    while (
        current !== null &&
        typeof current === 'object' &&
        'lastError' in current &&
        !visited.has(current)
    ) {
        const lastError = current.lastError;
        if (lastError === undefined) {
            break;
        }

        visited.add(current);
        current = lastError;
    }

    return current;
}

/**
 * 提取 provider SDK 错误里的关键诊断字段。
 * Vercel AI SDK 的 APICallError 会把 responseBody / requestBodyValues 挂在错误对象上。
 * AI SDK 的 AI_RetryError 会把真正的错误包装在 lastError 里——优先解包。
 */
function extractProviderErrorDetails(error: unknown): ProviderErrorDetails | null {
    const target = unwrapRetryError(error);

    if (!isProviderErrorDetails(target)) {
        return null;
    }

    const details: ProviderErrorDetails = {};

    if (typeof target.statusCode === 'number') {
        details.statusCode = target.statusCode;
    }
    if (typeof target.url === 'string') {
        details.url = target.url;
    }
    if ('responseBody' in target) {
        details.responseBody = target.responseBody;
    }
    if ('requestBodyValues' in target) {
        details.requestBodyValues = target.requestBodyValues;
    }
    if ('data' in target) {
        details.data = target.data;
    }

    return Object.keys(details).length > 0 ? details : null;
}

/**
 * 日志里只保留可以安全落盘的诊断字段。
 * provider 错误对象上的 responseBody、requestBodyValues 和 data 都是正文，
 * 完整内容仍随失败结果返回给调用方，但绝不写进日志。
 */
function summarizeProviderErrorDetails(details: ProviderErrorDetails): Record<string, unknown> {
    const summary: Record<string, unknown> = {};

    if (typeof details.statusCode === 'number') {
        summary.statusCode = details.statusCode;
    }
    if (typeof details.url === 'string') {
        summary.url = redactLogUrl(details.url);
    }
    if (details.responseBody !== undefined) {
        summary.responseBodyBytes = serializedByteLength(details.responseBody);
    }
    if (details.requestBodyValues !== undefined) {
        summary.requestBodyBytes = serializedByteLength(details.requestBodyValues);
    }
    if (details.data !== undefined) {
        summary.dataBytes = serializedByteLength(details.data);
    }

    const providerErrorCode =
        extractProviderErrorCode(details.data) ?? extractProviderErrorCode(details.responseBody);
    if (providerErrorCode) {
        summary.providerErrorCode = providerErrorCode;
    }

    return summary;
}

/** 错误本身进日志时同样要去掉可能夹带正文的 message。 */
function describeErrorForLog(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) {
        return { type: typeof error };
    }

    const details = extractProviderErrorDetails(error);
    const description: Record<string, unknown> = { name: error.name };

    if (details?.statusCode !== undefined) {
        description.statusCode = details.statusCode;
    }

    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length <= 64) {
        description.code = code;
    }

    if (details?.responseBody !== undefined || details?.requestBodyValues !== undefined) {
        description.messageLength = error.message.length;
    } else {
        description.message = redactLogText(error.message).slice(0, 300);
    }

    return description;
}

function extractProviderErrorCode(value: unknown): string | null {
    if (!value || typeof value !== 'object') return null;

    const record = value as Record<string, unknown>;
    const nested = record.error;
    const nestedRecord =
        nested && typeof nested === 'object' ? (nested as Record<string, unknown>) : undefined;
    const candidates = [nestedRecord?.code, nestedRecord?.type, record.code, record.type];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)) {
            return candidate;
        }
    }
    return null;
}

function serializedByteLength(value: unknown): number | null {
    try {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        return serialized === undefined ? null : new TextEncoder().encode(serialized).length;
    } catch {
        return null;
    }
}

const REDACTED_URL = '[redacted-url]';

function redactLogUrl(raw: string): string {
    try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        // 解析失败时无法判断 userinfo 和路径的边界，整体丢弃而不是猜。
        return REDACTED_URL;
    }
}

/** 错误文本里的 URL 同样可能带 userinfo 或 query，进日志前替换成脱敏形式。 */
function redactLogText(text: string): string {
    return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (match) => redactLogUrl(match));
}

function cloneAiMessages(messages: AiMessage[]): AiMessage[] {
    return JSON.parse(JSON.stringify(messages)) as AiMessage[];
}

function buildAssistantToolCallHistoryMessage(
    parts: PersistedOutputPart[],
    toolCalls: AiToolCall[]
): AiMessage {
    return {
        role: 'assistant',
        content: parts.map((part) =>
            part.type === 'reasoning'
                ? {
                      type: 'reasoning' as const,
                      text: part.content,
                      ...(part.providerOptions ? { providerOptions: part.providerOptions } : {}),
                  }
                : { type: part.type, text: part.content }
        ),
        tool_calls: toolCalls,
    };
}
async function buildToolResultMessageContent(
    result: string,
    attachments?: AttachmentIndex[]
): Promise<AiMessage['content']> {
    if (!attachments || attachments.length === 0) {
        return result;
    }

    const attachmentParts = await buildAttachmentParts(attachments, {
        includeAnchorText: false,
    });
    if (attachmentParts.length === 0) {
        return result;
    }

    return result
        ? ([{ type: 'text', text: result }, ...attachmentParts] as AiMessage['content'])
        : attachmentParts;
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
    }
}

function throwIfAttachmentsUnsupportedByModel(
    attachments: AttachmentIndex[] | undefined,
    model: ModelWithProvider
): void {
    const unsupportedAttachmentTypes = getUnsupportedAttachmentTypes(
        attachments ?? [],
        getModelAttachmentCapabilities(model)
    );
    if (unsupportedAttachmentTypes.length === 0) {
        return;
    }

    throw new AiError(AiErrorCode.UNSUPPORTED_INPUT, {
        unsupportedAttachmentTypes,
        modelId: model.model_id,
        providerId: model.provider_id,
    });
}

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

function parseToolCallArguments(toolCall: AiToolCall):
    | {
          ok: true;
          toolArgs: Record<string, unknown>;
      }
    | {
          ok: false;
          errorResult: string;
      } {
    let parsedArguments: unknown;

    try {
        parsedArguments = JSON.parse(toolCall.arguments);
    } catch {
        return {
            ok: false,
            errorResult: formatToolArgumentJsonError(toolCall.name),
        };
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

    return {
        ok: true,
        toolArgs: result.data,
    };
}

/**
 * 负责单次模型执行的底层编排：
 * - 模型解析
 * - provider 实例创建
 * - tool loop 执行
 * - 单次 attempt 的完成/失败结果归并
 *
 * 不负责请求级生命周期，例如：
 * - 会话初始化
 * - 重试调度
 * - 轮次持久化收尾
 * - 设置快照
 */
export class AiRequestExecutor {
    /**
     * 获取模型（统一入口）
     * - 不传参数：返回默认模型
     * - 传 providerId + modelId：返回指定模型
     */
    async getModel(options?: {
        providerId?: number;
        modelId?: string;
    }): Promise<ModelWithProvider> {
        return getModel(options);
    }

    /**
     * 创建服务商的 provider 实例（公共方法）
     */
    createProviderInstance(
        providerDriver: ProviderDriver,
        apiEndpoint: string,
        apiKey?: string | null,
        configJson?: string | null
    ): AiProvider {
        return createProviderFromRegistry(providerDriver, {
            apiEndpoint,
            apiKey: apiKey || undefined,
            config: parseProviderConfigJson(configJson),
        });
    }

    private createProviderForModel(model: ModelWithProvider): AiProvider {
        return createProviderForModel(model);
    }

    /**
     * 流式 AI 响应（纯粹的流式生成器）
     */
    private async *stream(
        provider: AiProvider,
        providerId: number,
        modelId: string,
        messages: AiMessage[],
        tools?: AiToolDefinition[],
        modelLanguageContext?: ModelLanguageContext,
        signal?: AbortSignal,
        attachmentRequestIndex?: number,
        onAttachmentManifestResolved?: RequestExecutionCallbacks['onAttachmentManifestResolved'],
        supportsReasoning = true,
        reasoningLevel?: SelectableReasoningLevel,
        reasoningOptions?: ReasoningOption[]
    ): AsyncGenerator<AiStreamChunk, void, unknown> {
        log.debug(
            `[AiRequestExecutor] Start stream request, model=${modelId}, messages=${messages.length}, tools=${tools?.length ?? 0}`
        );
        for await (const chunk of provider.stream({
            model: modelId,
            providerId,
            messages,
            supportsReasoning,
            reasoningLevel,
            reasoningOptions,
            tools,
            modelLanguageContext,
            signal,
            attachmentRequestIndex,
            onAttachmentManifestResolved,
        })) {
            yield chunk;
        }
    }

    private emitToolEvent(
        onChunk: RequestExecutionCallbacks['onChunk'],
        toolEvent: AiStreamChunk['toolEvent']
    ): void {
        onChunk?.({
            content: '',
            done: false,
            toolEvent,
        });
    }

    private buildToolEventModelSummary(model: ModelWithProvider): ToolEventModelSummary {
        return {
            providerId: model.provider_id,
            providerName: model.provider_name,
            modelId: model.model_id,
            modelName: model.name,
        };
    }

    private async executeMcpToolCall(options: {
        toolCall: AiToolCall;
        toolArgs: Record<string, unknown>;
        iteration: number;
        signal?: AbortSignal;
        toolCallMessageId: number | null;
        sessionId: number | null;
        onChunk?: RequestExecutionCallbacks['onChunk'];
        requestedTimeoutMs?: number;
    }): Promise<{
        toolCall: AiToolCall;
        result: string;
        isError: boolean;
        toolLogId: number | null;
        attachments?: AttachmentIndex[];
        builtInToolId?: undefined;
        controlSignal?: undefined;
    }> {
        const callStartTime = Date.now();
        const mapping = await mcpManager.resolveToolCall(options.toolCall.name);

        if (!mapping) {
            const errorResult = formatToolNotFoundError(options.toolCall.name);
            const durationMs = Date.now() - callStartTime;
            this.emitToolEvent(options.onChunk, {
                type: 'call_end',
                callId: options.toolCall.id,
                result: errorResult,
                isError: true,
                durationMs,
                finalStatus: 'error',
            });

            return {
                toolCall: options.toolCall,
                result: errorResult,
                isError: true,
                toolLogId: null,
                controlSignal: undefined,
            };
        }

        this.emitToolEvent(options.onChunk, {
            type: 'call_start',
            callId: options.toolCall.id,
            toolName: mapping.originalName,
            namespacedName: options.toolCall.name,
            source: 'mcp',
            startedAt: callStartTime,
            serverId: mapping.serverId,
            arguments: options.toolArgs,
        });

        let toolLogId: number | null = null;
        try {
            const toolLog = await createMcpToolLog({
                server_id: mapping.serverId,
                tool_name: mapping.originalName,
                tool_call_id: options.toolCall.id,
                session_id: options.sessionId,
                message_id: options.toolCallMessageId,
                iteration: options.iteration,
                input: serializeAuditPayload(options.toolArgs),
                status: 'pending',
            });
            toolLogId = toolLog.id;
        } catch (error) {
            log.error('[AiRequestExecutor] Failed to create MCP tool log:', error);
        }

        let toolResult: { result: string; isError: boolean; attachments?: AttachmentIndex[] };
        try {
            toolResult = await mcpManager.executeTool(options.toolCall.name, options.toolArgs, {
                signal: options.signal,
                iteration: options.iteration,
                toolCallId: options.toolCall.id,
                requestedTimeoutMs: options.requestedTimeoutMs,
                resolved: {
                    serverId: mapping.serverId,
                    originalName: mapping.originalName,
                    toolTimeout: mapping.toolTimeout,
                },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(
                `[AiRequestExecutor] MCP tool execution failed: ${options.toolCall.name}`,
                error
            );
            toolResult = {
                result: formatToolExecutionFailedError(errorMessage),
                isError: true,
            };
        }

        const durationMs = Date.now() - callStartTime;
        this.emitToolEvent(options.onChunk, {
            type: 'call_end',
            callId: options.toolCall.id,
            result: toolResult.result,
            isError: toolResult.isError,
            durationMs,
            finalStatus: toolResult.isError ? 'error' : 'completed',
        });

        await updateMcpToolLogByCallId(options.toolCall.id, {
            output: serializeAuditPayload(toolResult.result),
            status: toolResult.isError ? 'error' : 'success',
            duration_ms: durationMs,
            error_message: toolResult.isError ? serializeAuditPayload(toolResult.result) : null,
        }).catch((error) => {
            log.error('[AiRequestExecutor] Failed to update MCP tool log:', error);
        });

        return {
            toolCall: options.toolCall,
            result: toolResult.result,
            isError: toolResult.isError,
            toolLogId,
            attachments: toolResult.attachments,
            controlSignal: undefined,
        };
    }

    createInitialCheckpoint(options: {
        initialModel: ModelWithProvider;
        baseMessages: AiMessage[];
        modelLanguageContext: ModelLanguageContext;
    }): AttemptCheckpoint {
        return {
            activeModel: options.initialModel,
            messages: cloneAiMessages(options.baseMessages),
            response: '',
            reasoning: '',
            iteration: 0,
            modelSwitchCount: 0,
            modelLanguageContext: options.modelLanguageContext,
            executedBuiltInToolIds: [],
            outputParts: [],
        };
    }

    private async createAttemptRuntime(
        startCheckpoint: AttemptCheckpoint
    ): Promise<AttemptRuntime> {
        const { activeModel, modelLanguageContext, modelSwitchCount } = startCheckpoint;

        return {
            activeModel,
            provider: this.createProviderForModel(activeModel),
            tools: await resolveToolDefinitions(activeModel, {
                excludedToolNames:
                    modelSwitchCount >= MAX_REQUEST_MODEL_SWITCHES
                        ? MODEL_SWITCH_EXCLUDED_TOOL_NAMES
                        : undefined,
            }),
            messages: cloneAiMessages(startCheckpoint.messages),
            response: startCheckpoint.response,
            reasoning: startCheckpoint.reasoning,
            iteration: startCheckpoint.iteration,
            modelSwitchCount,
            modelLanguageContext,
            hasVisibleOutputSinceCheckpoint: false,
            hasToolActivitySinceCheckpoint: false,
            executedBuiltInTools: new Set(startCheckpoint.executedBuiltInToolIds),
            outputParts: normalizeOutputParts(startCheckpoint.outputParts),
            currentStepOutputParts: [],
            currentStepReasoningStartedAt: null,
            calls: [],
            totalUsage: emptyAiUsage(),
            firstTtftMs: null,
            firstTextMs: null,
            toolArgumentErrors: 0,
            hitModelSwitchCeiling: false,
        };
    }

    private createCheckpoint(runtime: AttemptRuntime): AttemptCheckpoint {
        return {
            activeModel: runtime.activeModel,
            messages: cloneAiMessages(runtime.messages),
            response: runtime.response,
            reasoning: runtime.reasoning,
            iteration: runtime.iteration,
            modelSwitchCount: runtime.modelSwitchCount,
            modelLanguageContext: runtime.modelLanguageContext,
            executedBuiltInToolIds: [...runtime.executedBuiltInTools],
            outputParts: normalizeOutputParts(runtime.outputParts),
        };
    }

    private commitCheckpoint(runtime: AttemptRuntime): AttemptCheckpoint {
        const checkpoint = this.createCheckpoint(runtime);
        runtime.hasVisibleOutputSinceCheckpoint = false;
        runtime.hasToolActivitySinceCheckpoint = false;
        return checkpoint;
    }

    private async consumeModelStep(
        runtime: AttemptRuntime,
        options: Pick<
            RequestExecutionCallbacks,
            'signal' | 'onChunk' | 'onAttachmentManifestResolved'
        > & {
            persister: PersistenceProjector;
        }
    ): Promise<AttemptStepResult> {
        // Relay metadata is not authoritative: some models report reasoning=0
        // while still requiring an explicit reasoning option to expose reasoning.
        // The executor always passes TouchAI's canonical level; each provider
        // driver translates it into the vendor-specific request parameter.
        const stream = this.stream(
            runtime.provider,
            runtime.activeModel.provider_id,
            runtime.activeModel.model_id,
            runtime.messages,
            runtime.tools,
            runtime.modelLanguageContext,
            options.signal,
            runtime.iteration,
            options.onAttachmentManifestResolved,
            runtime.activeModel.reasoning === 1,
            DEFAULT_REASONING_LEVEL,
            parseReasoningOptions(runtime.activeModel.reasoning_options)
        );
        let finishReason: string | undefined;
        let toolCalls: AiToolCall[] | undefined;
        let finalUsage: AiUsage | undefined;
        // Each model/tool-loop round is an independent persisted message part.
        // Keep the aggregate on `runtime.outputParts`, but never leak the
        // previous round into this round's final-step result.
        runtime.currentStepOutputParts = [];
        runtime.currentStepReasoningStartedAt = null;

        // ===== 首字计时与用量采集 =====
        const callStartedAt = Date.now();
        let firstContentAt: number | null = null;
        let firstTextAt: number | null = null;
        const stepToolArgumentErrors = 0;
        /** 记录内容块到达时刻与字符数，用于算 flowMs（10%→90% 窗口） */
        const contentArrivals: Array<{ at: number; chars: number }> = [];

        const markContent = (chars: number, isText: boolean) => {
            const now = Date.now();
            if (firstContentAt === null) firstContentAt = now;
            if (isText && firstTextAt === null) firstTextAt = now;
            if (chars > 0) contentArrivals.push({ at: now, chars });
        };

        let progressWrites = Promise.resolve();
        // 用递增 revision 代替每次边界 stringify 全量 parts：
        // 片段只能追加或就地扩展/封口，revision 变化即代表持久化快照变化。
        let stepRevision = 0;
        let lastSavedRevision = -1;
        const saveOutputParts = () => {
            if (stepRevision === lastSavedRevision) return;
            lastSavedRevision = stepRevision;
            const parts = normalizeOutputParts(this.getCurrentStepOutputParts(runtime));
            if (parts.length === 0) return;
            progressWrites = progressWrites
                .then(async () => {
                    await options.persister.persistOutputProgress(parts);
                })
                .catch((error) => {
                    log.error('[AiRequestExecutor] Failed to persist output parts:', error);
                });
        };
        let activeTextPart: Extract<PersistedOutputPart, { type: 'text' }> | null = null;
        const finishTextSegment = () => {
            if (!activeTextPart) return;
            activeTextPart = null;
            saveOutputParts();
        };
        const startReasoningSegment = (providerOptions?: Record<string, JsonObject>) => {
            // Some providers omit text-end; a reasoning fragment also closes text.
            finishTextSegment();
            if (runtime.currentStepReasoningStartedAt === null) {
                runtime.currentStepReasoningStartedAt = Date.now();
                ensureReasoningPart(providerOptions);
                saveOutputParts();
            }
        };
        const ensureReasoningPart = (providerOptions?: Record<string, JsonObject>) => {
            const lastPart =
                runtime.currentStepOutputParts[runtime.currentStepOutputParts.length - 1];
            if (lastPart?.type === 'reasoning' && lastPart.endedAt === undefined) {
                const merged = mergeReasoningProviderOptions(
                    lastPart.providerOptions,
                    providerOptions
                );
                if (merged) {
                    lastPart.providerOptions = merged;
                    stepRevision += 1;
                }
                return lastPart;
            }

            const part: PersistedOutputPart = {
                type: 'reasoning',
                content: '',
                startedAt: runtime.currentStepReasoningStartedAt ?? Date.now(),
                ...(providerOptions ? { providerOptions } : {}),
            };
            runtime.currentStepOutputParts.push(part);
            runtime.outputParts.push(part);
            stepRevision += 1;
            return part;
        };
        const finishReasoningSegment = () => {
            const lastPart =
                runtime.currentStepOutputParts[runtime.currentStepOutputParts.length - 1];
            const closed = lastPart?.type === 'reasoning' && lastPart.endedAt === undefined;
            if (closed) {
                lastPart.endedAt = Date.now();
                stepRevision += 1;
                saveOutputParts();
            }
            runtime.currentStepReasoningStartedAt = null;
        };
        const appendText = (content: string) => {
            if (activeTextPart) {
                activeTextPart.content += content;
                stepRevision += 1;
                return;
            }
            const part: PersistedOutputPart = { type: 'text', content };
            activeTextPart = part;
            runtime.currentStepOutputParts.push(part);
            runtime.outputParts.push(part);
            stepRevision += 1;
        };
        try {
            for await (const chunk of stream) {
                throwIfAborted(options.signal);
                if (chunk.textState === 'start') {
                    finishReasoningSegment();
                    finishTextSegment();
                }
                if (chunk.reasoningState === 'start') {
                    finishReasoningSegment();
                    startReasoningSegment(chunk.reasoningProviderOptions);
                }
                if (chunk.reasoning) {
                    startReasoningSegment(chunk.reasoningProviderOptions);
                    const reasoningPart = ensureReasoningPart(chunk.reasoningProviderOptions);
                    reasoningPart.content += chunk.reasoning;
                    stepRevision += 1;
                    runtime.reasoning += chunk.reasoning;
                    runtime.hasVisibleOutputSinceCheckpoint = true;
                    markContent(chunk.reasoning.length, false);
                }
                if (chunk.content) {
                    finishReasoningSegment();
                    appendText(chunk.content);
                    runtime.response += chunk.content;
                    runtime.hasVisibleOutputSinceCheckpoint = true;
                    markContent(chunk.content.length, true);
                }
                if (
                    chunk.toolEvent ||
                    chunk.toolCallDeltas?.length ||
                    (chunk.done && chunk.toolCalls?.length)
                ) {
                    runtime.hasToolActivitySinceCheckpoint = true;
                    finishReasoningSegment();
                    finishTextSegment();
                    if (firstContentAt === null) firstContentAt = Date.now();
                }
                if (chunk.reasoningState === 'end' || chunk.done) {
                    finishReasoningSegment();
                }
                if (chunk.textState === 'end' || chunk.done) {
                    finishTextSegment();
                }
                options.onChunk?.(chunk);
                if (chunk.done) {
                    finishReason = chunk.finishReason;
                    toolCalls = chunk.toolCalls;
                    finalUsage = chunk.usage;
                    break;
                }
            }
        } finally {
            finishReasoningSegment();
            finishTextSegment();
            await progressWrites;
        }

        const outputParts = normalizeOutputParts(runtime.currentStepOutputParts);
        const isToolRelated = finishReason === 'tool_calls' || finishReason === 'tool_use';
        const hasToolCalls = Boolean(toolCalls && toolCalls.length > 0);

        // ===== 组装本次调用的用量与耗时记录 =====
        const callEndedAt = Date.now();
        const usage = finalUsage ?? emptyAiUsage();
        const call: AiCallRecord = {
            iteration: runtime.iteration,
            modelId: runtime.activeModel.id,
            modelName: runtime.activeModel.model_id,
            providerId: runtime.activeModel.provider_id,
            providerName: runtime.activeModel.provider_name,
            usage,
            timing: {
                ttftMs: firstContentAt === null ? undefined : firstContentAt - callStartedAt,
                firstTextMs: firstTextAt === null ? undefined : firstTextAt - callStartedAt,
                flowMs: computeFlowWindow(contentArrivals),
                durationMs: callEndedAt - callStartedAt,
            },
            finishReason,
            toolCallsInStep: isToolRelated && hasToolCalls ? toolCalls!.length : 0,
            toolArgumentErrors: stepToolArgumentErrors,
        };

        runtime.calls.push(call);
        runtime.totalUsage = addAiUsage(runtime.totalUsage, usage);
        runtime.toolArgumentErrors += stepToolArgumentErrors;
        if (runtime.firstTtftMs === null && call.timing.ttftMs !== undefined) {
            runtime.firstTtftMs = call.timing.ttftMs;
            runtime.firstTextMs = call.timing.firstTextMs ?? null;
        }

        if (!isToolRelated || !hasToolCalls) {
            return { type: 'done', outputParts, call };
        }

        runtime.hasToolActivitySinceCheckpoint = true;
        return {
            type: 'tool_calls',
            outputParts,
            toolCalls: toolCalls!,
            call,
        };
    }

    private getCurrentStepOutputParts(
        runtime: AttemptRuntime,
        closeActiveAt?: number
    ): PersistedOutputPart[] {
        return runtime.currentStepOutputParts.map((part) => {
            if (
                part.type === 'reasoning' &&
                closeActiveAt !== undefined &&
                part.endedAt === undefined &&
                part.startedAt !== undefined
            ) {
                return { ...part, endedAt: Math.max(part.startedAt, closeActiveAt) };
            }
            return { ...part };
        });
    }

    private async executeToolCall(
        runtime: AttemptRuntime,
        options: {
            toolCall: AiToolCall;
            toolCallMessageId: number | null;
            persister: PersistenceProjector;
        } & RequestExecutionCallbacks
    ): Promise<ToolExecutionResult> {
        throwIfAborted(options.signal);

        const parsedToolArguments = parseToolCallArguments(options.toolCall);
        if (!parsedToolArguments.ok) {
            // 参数解析失败是「结构化输出能力」的直接信号，计入 attempt 级计数。
            runtime.toolArgumentErrors += 1;
            this.emitToolEvent(options.onChunk, {
                type: 'call_end',
                callId: options.toolCall.id,
                result: parsedToolArguments.errorResult,
                isError: true,
                durationMs: 0,
                finalStatus: 'error',
            });

            return {
                toolCall: options.toolCall,
                result: parsedToolArguments.errorResult,
                isError: true,
                toolLogId: null,
            };
        }

        // 只有声明了自适应超时的工具才会把 `_meta` 当作超时信封剥离；
        // 其余工具（含自带 `_meta` 业务参数的 MCP 工具）原样透传参数。
        const supportsAdaptiveTimeout =
            runtime.tools?.some(
                (tool) =>
                    tool.name === options.toolCall.name &&
                    tool.adaptiveTimeoutCeilingMs !== undefined
            ) ?? false;
        const { requestedTimeoutMs, sanitizedToolArgs } = supportsAdaptiveTimeout
            ? parseRequestedTimeoutMs(parsedToolArguments.toolArgs)
            : { requestedTimeoutMs: undefined, sanitizedToolArgs: parsedToolArguments.toolArgs };

        const builtInResult = await builtInToolService.executeTool({
            toolCall: options.toolCall,
            toolArgs: sanitizedToolArgs,
            iteration: runtime.iteration,
            currentModel: runtime.activeModel,
            hasExecutedBuiltInTool: (toolId) => runtime.executedBuiltInTools.has(toolId),
            signal: options.signal,
            toolCallMessageId: options.toolCallMessageId,
            sessionId: options.persister.getSessionId(),
            requestToolApproval: options.requestToolApproval,
            requestUserQuestions: options.requestUserQuestions,
            emitToolEvent: (toolEvent) => this.emitToolEvent(options.onChunk, toolEvent),
            requestedTimeoutMs,
        });

        if (builtInResult) {
            return builtInResult;
        }

        return this.executeMcpToolCall({
            toolCall: options.toolCall,
            toolArgs: sanitizedToolArgs,
            iteration: runtime.iteration,
            signal: options.signal,
            toolCallMessageId: options.toolCallMessageId,
            sessionId: options.persister.getSessionId(),
            onChunk: options.onChunk,
            requestedTimeoutMs,
        });
    }

    private async runToolRound(
        runtime: AttemptRuntime,
        options: {
            step: Extract<AttemptStepResult, { type: 'tool_calls' }>;
            persister: PersistenceProjector;
            parentSpan?: Span;
        } & RequestExecutionCallbacks
    ): Promise<void> {
        this.emitToolEvent(options.onChunk, {
            type: 'iteration_start',
            iteration: runtime.iteration,
        });

        runtime.messages.push(
            buildAssistantToolCallHistoryMessage(options.step.outputParts, options.step.toolCalls)
        );

        const toolCallMessageId = await options.persister.persistToolCallMessage(
            options.step.outputParts
        );

        const toolResults = await Promise.all(
            options.step.toolCalls.map((toolCall) =>
                withSpan(
                    'touchai.tool',
                    {
                        [ATTR.toolCallId]: toolCall.id,
                        [ATTR.toolName]: toolCall.name,
                    },
                    () =>
                        this.executeToolCall(runtime, {
                            toolCall,
                            toolCallMessageId,
                            persister: options.persister,
                            signal: options.signal,
                            onChunk: options.onChunk,
                            requestToolApproval: options.requestToolApproval,
                            requestUserQuestions: options.requestUserQuestions,
                        }),
                    options.parentSpan
                )
            )
        );

        const requestedModelSwitch =
            toolResults.find(({ controlSignal }) => controlSignal?.type === 'upgrade_model')
                ?.controlSignal ?? null;
        const nextModel =
            requestedModelSwitch?.type === 'upgrade_model'
                ? requestedModelSwitch.targetModel
                : runtime.activeModel;

        for (const {
            toolCall,
            builtInToolId,
            result,
            isError,
            toolLogId,
            attachments,
        } of toolResults) {
            throwIfAttachmentsUnsupportedByModel(attachments, nextModel);

            runtime.messages.push({
                role: 'tool',
                content: await buildToolResultMessageContent(result, attachments),
                tool_call_id: toolCall.id,
                name: toolCall.name,
                isError,
            });

            await options.persister.persistToolResult({
                result,
                toolCallId: toolCall.id,
                toolCallPartId: toolLogId,
                toolCallMessageId,
                attachments,
            });

            if (builtInToolId && !isError) {
                runtime.executedBuiltInTools.add(builtInToolId);
            }
            event('agent.tool.completed', {
                [ATTR.toolCallId]: toolCall.id,
                [ATTR.toolName]: toolCall.name,
                'tool.success': !isError,
            });
        }

        this.emitToolEvent(options.onChunk, {
            type: 'iteration_end',
            iteration: runtime.iteration,
        });

        if (requestedModelSwitch?.type === 'upgrade_model') {
            const previousModel = runtime.activeModel;
            runtime.activeModel = requestedModelSwitch.targetModel;
            runtime.modelSwitchCount += 1;
            if (runtime.modelSwitchCount >= MAX_REQUEST_MODEL_SWITCHES) {
                runtime.hitModelSwitchCeiling = true;
            }
            runtime.provider = this.createProviderForModel(runtime.activeModel);
            runtime.tools = await resolveToolDefinitions(runtime.activeModel, {
                excludedToolNames:
                    runtime.modelSwitchCount >= MAX_REQUEST_MODEL_SWITCHES
                        ? MODEL_SWITCH_EXCLUDED_TOOL_NAMES
                        : undefined,
            });

            this.emitToolEvent(options.onChunk, {
                type: 'model_switched',
                fromModel: this.buildToolEventModelSummary(previousModel),
                toModel: this.buildToolEventModelSummary(runtime.activeModel),
                restart: requestedModelSwitch.restartCurrentRequest,
            });
        }
    }

    /**
     * 执行一次完整 attempt。
     *
     * 这里的“attempt”只覆盖：
     * - 当前模型/上下文下的流式响应
     * - tool loop 与切模
     * - attempt 级结果汇总
     *
     * 不覆盖：
     * - 是否进入下一次重试
     * - turn 的最终落库状态
     */
    async runAttempt(options: RunAttemptOptions): Promise<AttemptExecutionResult> {
        const runtime = await this.createAttemptRuntime(options.startCheckpoint);
        let resumeCheckpoint = options.startCheckpoint;
        try {
            while (true) {
                throwIfAborted(options.signal);

                const step = await withSpan(
                    'touchai.model',
                    {
                        [ATTR.requestModel]: runtime.activeModel.model_id,
                        [ATTR.providerName]: runtime.activeModel.provider_name,
                    },
                    () =>
                        this.consumeModelStep(runtime, {
                            signal: options.signal,
                            onChunk: options.onChunk,
                            persister: options.persister,
                            onAttachmentManifestResolved: async (request) => {
                                try {
                                    await options.persister.syncDeliveryManifestRequest(request);
                                } catch (error) {
                                    log.error(
                                        '[AiRequestExecutor] Failed to persist attachment delivery manifest request:',
                                        error
                                    );
                                }
                            },
                        }),
                    options.parentSpan
                );

                if (step.type === 'done') {
                    break;
                }

                await this.runToolRound(runtime, {
                    step,
                    persister: options.persister,
                    parentSpan: options.parentSpan,
                    signal: options.signal,
                    onChunk: options.onChunk,
                    requestToolApproval: options.requestToolApproval,
                    requestUserQuestions: options.requestUserQuestions,
                });

                runtime.iteration += 1;
                resumeCheckpoint = this.commitCheckpoint(runtime);
                await options.persister.persistCheckpoint(resumeCheckpoint).catch((error) => {
                    log.error('[AiRequestExecutor] Failed to persist checkpoint:', error);
                });
                if (options.taskId) {
                    options.onTurnEvent?.({
                        type: 'checkpoint_committed',
                        taskId: options.taskId,
                        checkpoint: resumeCheckpoint,
                    });
                }
            }

            if (!runtime.response.trim() && !runtime.reasoning.trim()) {
                throw new AiError(AiErrorCode.EMPTY_RESPONSE);
            }

            return {
                type: 'completed',
                model: runtime.activeModel,
                response: runtime.response,
                reasoning: runtime.reasoning,
                finalStepOutputParts: normalizeOutputParts(runtime.currentStepOutputParts),
                calls: runtime.calls,
                totalUsage: runtime.totalUsage,
                firstTtftMs: runtime.firstTtftMs,
                firstTextMs: runtime.firstTextMs,
                toolArgumentErrors: runtime.toolArgumentErrors,
                modelSwitchCount: runtime.modelSwitchCount,
                hitModelSwitchCeiling: runtime.hitModelSwitchCeiling,
            };
        } catch (error) {
            // AI SDK RetryError 包装了真正的错误——解包后传递给分类器
            const unwrapped = unwrapRetryError(error);
            const providerErrorDetails = extractProviderErrorDetails(unwrapped);

            // 先让 provider 自己分类，再 fallback 到通用启发式。
            // 分类器只负责提升错误信息，不能覆盖真正的请求失败原因。
            let classifiedError: AiError;
            try {
                classifiedError =
                    runtime.provider.classifyError?.(unwrapped) ?? AiError.fromError(unwrapped);
            } catch (classificationError) {
                log.warn(
                    '[AiRequestExecutor] Provider error classification failed:',
                    classificationError
                );
                classifiedError = AiError.fromError(unwrapped);
            }

            // 事件带的是分类后的 code，否则 429 之类只带状态码的失败会记成 unknown。
            obsError(
                'agent.request.failed',
                classifiedError,
                {
                    [ATTR.providerName]: runtime.activeModel.provider_name,
                    [ATTR.requestModel]: runtime.activeModel.model_id,
                    ...(providerErrorDetails?.statusCode !== undefined
                        ? { [ATTR.httpStatus]: providerErrorDetails.statusCode }
                        : {}),
                },
                'Agent request failed'
            );
            log.warn('[AiRequestExecutor] Request failed:', describeErrorForLog(unwrapped));
            if (providerErrorDetails) {
                log.warn(
                    '[AiRequestExecutor] Provider error details:',
                    summarizeProviderErrorDetails(providerErrorDetails)
                );
            }

            return {
                type: 'failed',
                error: classifiedError,
                response: runtime.response,
                reasoning: runtime.reasoning,
                partialOutputParts: normalizeOutputParts(runtime.currentStepOutputParts),
                resumeCheckpoint,
                hasVisibleOutputSinceCheckpoint: runtime.hasVisibleOutputSinceCheckpoint,
                hasToolActivitySinceCheckpoint: runtime.hasToolActivitySinceCheckpoint,
                providerErrorDetails,
                calls: runtime.calls,
                totalUsage: runtime.totalUsage,
                firstTtftMs: runtime.firstTtftMs,
                firstTextMs: runtime.firstTextMs,
                toolArgumentErrors: runtime.toolArgumentErrors,
                modelSwitchCount: runtime.modelSwitchCount,
                hitModelSwitchCeiling: runtime.hitModelSwitchCeiling,
            };
        }
    }
}

/**
 * 计算「10% 内容 → 90% 内容」的耗时窗口。
 *
 * 目的：供应商把回复憋住一次性吐出时，`duration - ttft` 会算出荒谬的速度
 * （magpie 遇到过 1367 tok/s 的假值）。用 10%→90% 窗口能识别这种情形：
 * 一次性吐出的回复该窗口接近 0，此时应判定为「测不出速度」而非给假数字。
 *
 * 返回 undefined 表示窗口不可用（内容块太少或时间跨度为 0）。
 */
function computeFlowWindow(
    arrivals: ReadonlyArray<{ at: number; chars: number }>
): number | undefined {
    if (arrivals.length < 2) {
        return undefined;
    }

    const total = arrivals.reduce((sum, item) => sum + item.chars, 0);
    if (total <= 0) {
        return undefined;
    }

    let cumulative = 0;
    let at10: number | undefined;
    let at90: number | undefined;
    for (const arrival of arrivals) {
        cumulative += arrival.chars;
        const ratio = cumulative / total;
        if (at10 === undefined && ratio >= 0.1) {
            at10 = arrival.at;
        }
        if (at90 === undefined && ratio >= 0.9) {
            at90 = arrival.at;
            break;
        }
    }

    if (at10 === undefined || at90 === undefined || at90 <= at10) {
        return undefined;
    }

    return at90 - at10;
}

export type { ModelWithProvider };
