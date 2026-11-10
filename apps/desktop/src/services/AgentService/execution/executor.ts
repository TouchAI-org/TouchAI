// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMcpToolLog, updateMcpToolLogById } from '@database/queries';
import { findMcpServerById } from '@database/queries/mcpServers';
import type { ModelWithProvider } from '@database/queries/models';
import { createToolPart } from '@database/queries/toolParts';
import type { ProviderDriver } from '@database/schema';
import type { Span } from '@opentelemetry/api';
import { error as obsError, event, log } from '@services/ObservabilityService';
import { ATTR } from '@services/ObservabilityService/attributes';
import { serializeAuditPayload } from '@services/ObservabilityService/redact';
import { withSpan } from '@services/ObservabilityService/tracing';

import { t, tt } from '@/i18n';
import {
    type BuiltInToolControlSignal,
    type BuiltInToolId,
    builtInToolService,
} from '@/services/BuiltInToolService';
import { parseRequestedTimeoutMs } from '@/utils/timeouts';
import { z } from '@/utils/zod';

import { createProviderForModel, getModel, resolveToolDefinitions } from '../catalog';
import { MAX_SUMMARY_CHARS } from '../contracts/context';
import { AiError, AiErrorCode } from '../contracts/errors';
import {
    addAiUsage,
    type AiCallRecord,
    type AiMessage,
    type AiRequestOptions,
    type AiStreamChunk,
    type AiUsage,
    emptyAiUsage,
    type JsonObject,
    normalizeOutputParts,
    type PersistedOutputPart,
} from '../contracts/protocol';
import { DEFAULT_REASONING_LEVEL, parseReasoningOptions } from '../contracts/reasoning';
import type {
    AiToolCall,
    AiToolDefinition,
    AskUserAnswer,
    AskUserQuestion,
    ToolApprovalDecisionRequest,
    ToolEventModelSummary,
} from '../contracts/tooling';
import { type AgentRequestAnalytics, toolCategoryForName } from '../infrastructure/analytics';
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
import { MAX_SELECTED_SKILLS } from '../skills/activation';
import { publicWidgetArguments, WidgetSkillAccess } from '../skills/widgetAccess';
import { ContextWindow, type SummaryResult } from './context';
import { snapshotAiMessages } from './messages';
import type { TurnEvent } from './runtime';
import { publicToolCall, publicWidgetChunk } from './widgetStream';

const BUILT_IN_UPGRADE_TOOL_NAME = 'builtin__upgrade_model';
const BUILT_IN_SKILL_TOOL_NAME = 'builtin__activate_skill';
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
    /** Per-logical-request analytics sink; absent for callers without one. */
    analytics?: AgentRequestAnalytics;
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

/** Lives for one logical request, including retries; never published or persisted. */
export interface RequestPrivateState {
    messageContents: Map<number, AiMessage['content']>;
    messageToolCalls: Map<number, AiToolCall[]>;
    skillActivationAttempts: number;
    widgetSkillAccess: WidgetSkillAccess;
}

interface AttemptRuntime {
    promptCacheKey: string;
    nextAttachmentRequestIndex: number;
    activeModel: ModelWithProvider;
    provider: AiProvider;
    tools?: AiToolDefinition[];
    messages: AiMessage[];
    privateMessageContents: Map<number, AiMessage['content']>;
    privateMessageToolCalls: Map<number, AiToolCall[]>;
    privateState: RequestPrivateState;
    response: string;
    reasoning: string;
    iteration: number;
    modelSwitchCount: number;
    modelLanguageContext: ModelLanguageContext;
    hasVisibleOutputSinceCheckpoint: boolean;
    hasToolActivitySinceCheckpoint: boolean;
    /** Kept only to round-trip older persisted checkpoints. No execution gate reads it. */
    legacyExecutedBuiltInToolIds: BuiltInToolId[];
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
    /** 真正由供应商返回 usage 的调用数（含显式零），用于用量覆盖率 */
    usageReportedCalls: number;
    /** 工具调用被用户拒绝次数 */
    /** 是否触达模型切换上限 */
    hitModelSwitchCeiling: boolean;
}

interface ToolExecutionResult {
    toolCall: AiToolCall;
    input?: string;
    result: string;
    persistedResult?: string;
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
          usageReportedCalls: number;
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
          usageReportedCalls: number;
          modelSwitchCount: number;
          hitModelSwitchCeiling: boolean;
      };

export type AttemptFailureResult = Extract<AttemptExecutionResult, { type: 'failed' }>;

export interface RunAttemptOptions extends RequestExecutionCallbacks {
    startCheckpoint: AttemptCheckpoint;
    persister: PersistenceProjector;
    parentSpan?: Span;
    privateState?: RequestPrivateState;
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
    private readonly contextWindow = new ContextWindow();
    private readonly cacheNamespace = crypto.randomUUID();
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

    private async summarizeContext(
        runtime: AttemptRuntime,
        request: AiRequestOptions
    ): Promise<SummaryResult> {
        const startedAt = Date.now();
        const controller = new AbortController();
        const signal = controller.signal;
        const forwardAbort = () => controller.abort(request.signal?.reason);
        if (request.signal?.aborted) forwardAbort();
        else request.signal?.addEventListener('abort', forwardAbort, { once: true });
        let text = '';
        let usage = emptyAiUsage();
        let usageReported = false;
        let finishReason: string | undefined;
        let hasToolCalls = false;
        try {
            throwIfAborted(signal);
            for await (const chunk of runtime.provider.stream({
                ...request,
                signal,
                attachmentRequestIndex: runtime.nextAttachmentRequestIndex++,
            })) {
                if (chunk.done) {
                    usage = chunk.usage ?? emptyAiUsage();
                    usageReported = chunk.usageReported === true;
                    finishReason = chunk.finishReason;
                }
                throwIfAborted(signal);
                text += chunk.content;
                hasToolCalls ||= Boolean(chunk.toolCalls?.length || chunk.toolCallDeltas?.length);
                if (text.length > MAX_SUMMARY_CHARS)
                    throw new AiError(AiErrorCode.CONTEXT_COMPACTION_FAILED);
                if (chunk.done) break;
            }
            return { text, finishReason, hasToolCalls };
        } catch (error) {
            finishReason = request.signal?.aborted ? 'aborted' : 'error';
            throw error;
        } finally {
            request.signal?.removeEventListener('abort', forwardAbort);
            controller.abort();
            runtime.calls.push({
                iteration: runtime.iteration,
                modelId: runtime.activeModel.id,
                modelName: runtime.activeModel.model_id,
                providerId: runtime.activeModel.provider_id,
                providerName: runtime.activeModel.provider_name,
                usage,
                usageReported,
                timing: { durationMs: Date.now() - startedAt },
                finishReason,
                toolCallsInStep: 0,
                toolArgumentErrors: 0,
            });
            runtime.totalUsage = addAiUsage(runtime.totalUsage, usage);
            if (usageReported) runtime.usageReportedCalls++;
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

    /** A rejected call is still conversation history; commit its error before continuing. */
    private async rejectToolCall(options: {
        toolCall: AiToolCall;
        input: string;
        result: string;
        iteration: number;
        toolCallMessageId: number | null;
        sessionId: number | null;
        durationMs: number;
        signal?: AbortSignal;
        onChunk?: RequestExecutionCallbacks['onChunk'];
    }): Promise<ToolExecutionResult> {
        throwIfAborted(options.signal);
        const { toolCall } = options;
        const builtinId = toolCall.name.startsWith('builtin__')
            ? toolCall.name.slice('builtin__'.length)
            : undefined;
        const mcp = toolCall.name.match(/^mcp__(\d+)__(.+)$/);
        const serverId = mcp ? Number(mcp[1]) : NaN;
        // Only real, exactly represented server identities can be remapped on import.
        const server =
            mcp && Number.isSafeInteger(serverId) && String(serverId) === mcp[1]
                ? await findMcpServerById(serverId)
                : undefined;
        const identity =
            builtinId !== undefined
                ? { tool_id: builtinId }
                : server
                  ? { server_id: server.id, tool_name: mcp![2]! }
                  : { server_id: null, tool_name: toolCall.name, requestedName: toolCall.name };
        const result = serializeAuditPayload(options.result);
        throwIfAborted(options.signal);
        const saved = await createToolPart(builtinId !== undefined ? 'builtin' : 'mcp', {
            ...identity,
            tool_call_id: toolCall.id,
            session_id: options.sessionId,
            message_id: options.toolCallMessageId,
            iteration: options.iteration,
            input: options.input,
            output: result,
            status: 'error',
            duration_ms: options.durationMs,
            error_message: result,
        });
        throwIfAborted(options.signal);
        this.emitToolEvent(options.onChunk, {
            type: 'call_end',
            callId: toolCall.id,
            result,
            isError: true,
            durationMs: options.durationMs,
            finalStatus: 'error',
        });
        return { toolCall, input: options.input, result, isError: true, toolLogId: saved.id };
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
    }): Promise<ToolExecutionResult> {
        const callStartTime = Date.now();
        const mapping = await mcpManager.resolveToolCall(options.toolCall.name);

        if (!mapping) {
            return this.rejectToolCall({
                ...options,
                input: serializeAuditPayload(options.toolArgs),
                result: formatToolNotFoundError(options.toolCall.name),
                durationMs: Date.now() - callStartTime,
            });
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
        let cancellation: AiError | undefined;
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
            if (
                options.signal?.aborted ||
                (error instanceof AiError && error.is(AiErrorCode.REQUEST_CANCELLED)) ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                cancellation = new AiError(AiErrorCode.REQUEST_CANCELLED, undefined, undefined, {
                    cause: error,
                });
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            if (!cancellation) {
                log.error(
                    `[AiRequestExecutor] MCP tool execution failed: ${options.toolCall.name}`,
                    error
                );
            }
            toolResult = {
                result: formatToolExecutionFailedError(errorMessage),
                isError: true,
            };
        }

        if (options.signal?.aborted) cancellation ??= new AiError(AiErrorCode.REQUEST_CANCELLED);

        const durationMs = Date.now() - callStartTime;
        this.emitToolEvent(options.onChunk, {
            type: 'call_end',
            callId: options.toolCall.id,
            result: toolResult.result,
            isError: toolResult.isError,
            durationMs,
            finalStatus: toolResult.isError ? 'error' : 'completed',
        });

        if (toolLogId !== null)
            await updateMcpToolLogById(toolLogId, {
                output: serializeAuditPayload(toolResult.result),
                status: toolResult.isError ? 'error' : 'success',
                duration_ms: durationMs,
                error_message: toolResult.isError ? serializeAuditPayload(toolResult.result) : null,
            }).catch((error) => {
                log.error('[AiRequestExecutor] Failed to update MCP tool log:', error);
            });

        if (cancellation) throw cancellation;

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
            messages: snapshotAiMessages(options.baseMessages),
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
        startCheckpoint: AttemptCheckpoint,
        sessionId: number | null,
        privateState: RequestPrivateState
    ): Promise<AttemptRuntime> {
        const { activeModel, modelLanguageContext, modelSwitchCount } = startCheckpoint;

        return {
            promptCacheKey: `${this.cacheNamespace}:${sessionId ?? crypto.randomUUID()}`,
            nextAttachmentRequestIndex: startCheckpoint.iteration,
            activeModel,
            provider: this.createProviderForModel(activeModel),
            tools: await resolveToolDefinitions(activeModel, {
                excludedToolNames:
                    modelSwitchCount >= MAX_REQUEST_MODEL_SWITCHES
                        ? MODEL_SWITCH_EXCLUDED_TOOL_NAMES
                        : undefined,
            }),
            messages: snapshotAiMessages(startCheckpoint.messages),
            privateMessageContents: new Map(privateState.messageContents),
            privateMessageToolCalls: new Map(privateState.messageToolCalls),
            privateState,
            response: startCheckpoint.response,
            reasoning: startCheckpoint.reasoning,
            iteration: startCheckpoint.iteration,
            modelSwitchCount,
            modelLanguageContext,
            hasVisibleOutputSinceCheckpoint: false,
            hasToolActivitySinceCheckpoint: false,
            legacyExecutedBuiltInToolIds: [...startCheckpoint.executedBuiltInToolIds],
            outputParts: normalizeOutputParts(startCheckpoint.outputParts),
            currentStepOutputParts: [],
            currentStepReasoningStartedAt: null,
            calls: [],
            totalUsage: emptyAiUsage(),
            firstTtftMs: null,
            firstTextMs: null,
            toolArgumentErrors: 0,
            usageReportedCalls: 0,
            hitModelSwitchCeiling: false,
        };
    }

    private createCheckpoint(runtime: AttemptRuntime): AttemptCheckpoint {
        return {
            activeModel: runtime.activeModel,
            messages: snapshotAiMessages(runtime.messages),
            response: runtime.response,
            reasoning: runtime.reasoning,
            iteration: runtime.iteration,
            modelSwitchCount: runtime.modelSwitchCount,
            modelLanguageContext: runtime.modelLanguageContext,
            executedBuiltInToolIds: [...runtime.legacyExecutedBuiltInToolIds],
            outputParts: normalizeOutputParts(runtime.outputParts),
        };
    }

    private commitCheckpoint(runtime: AttemptRuntime): AttemptCheckpoint {
        const checkpoint = this.createCheckpoint(runtime);
        runtime.hasVisibleOutputSinceCheckpoint = false;
        runtime.hasToolActivitySinceCheckpoint = false;
        return checkpoint;
    }

    private syncPrivateCheckpoint(runtime: AttemptRuntime): void {
        runtime.privateState.messageContents.clear();
        for (const [index, content] of runtime.privateMessageContents) {
            runtime.privateState.messageContents.set(index, content);
        }
        runtime.privateState.messageToolCalls.clear();
        for (const [index, calls] of runtime.privateMessageToolCalls) {
            runtime.privateState.messageToolCalls.set(index, calls);
        }
    }

    private async consumeModelStep(
        runtime: AttemptRuntime,
        options: Pick<
            RequestExecutionCallbacks,
            'signal' | 'onChunk' | 'onAttachmentManifestResolved'
        > & {
            persister: PersistenceProjector;
            onContextPrepared: () => void;
        }
    ): Promise<AttemptStepResult> {
        runtime.currentStepOutputParts = [];
        runtime.currentStepReasoningStartedAt = null;
        // Relay metadata is not authoritative: some models report reasoning=0
        // while still requiring an explicit reasoning option to expose reasoning.
        // The executor always passes TouchAI's canonical level; each provider
        // driver translates it into the vendor-specific request parameter.
        runtime.messages = snapshotAiMessages(runtime.messages);
        for (const message of runtime.messages) {
            if (message.contextSummary) await options.persister.validateContextSummary(message);
        }
        const privateMessageValues = new WeakMap<
            AiMessage,
            { content?: AiMessage['content']; tool_calls?: AiToolCall[] }
        >();
        for (const [index, message] of runtime.messages.entries()) {
            const content = runtime.privateMessageContents.get(index);
            const toolCalls = runtime.privateMessageToolCalls.get(index);
            if (content !== undefined || toolCalls !== undefined) {
                privateMessageValues.set(message, {
                    ...(content !== undefined ? { content } : {}),
                    ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
                });
            }
        }
        const transportMessages = new WeakMap<AiMessage, AiMessage>();
        const projectForTransport = (message: AiMessage): AiMessage => {
            const privateValues = privateMessageValues.get(message);
            if (!privateValues) return message;
            let transport = transportMessages.get(message);
            if (!transport) {
                transport = snapshotAiMessages([{ ...message, ...privateValues }])[0]!;
                transportMessages.set(message, transport);
            }
            return transport;
        };
        const activeAttachments = runtime.messages.flatMap((message) =>
            Array.isArray(message.content)
                ? message.content.filter((part) => part.type === 'image' || part.type === 'file')
                : []
        );
        const unsupported = getUnsupportedAttachmentTypes(
            activeAttachments,
            getModelAttachmentCapabilities(runtime.activeModel)
        );
        if (unsupported.length)
            throw new AiError(AiErrorCode.UNSUPPORTED_INPUT, {
                unsupportedAttachmentTypes: unsupported,
                modelId: runtime.activeModel.model_id,
                providerId: runtime.activeModel.provider_id,
            });
        const request: AiRequestOptions = {
            model: runtime.activeModel.model_id,
            providerId: runtime.activeModel.provider_id,
            messages: runtime.messages,
            tools: runtime.tools,
            modelLanguageContext: runtime.modelLanguageContext,
            signal: options.signal,
            onAttachmentManifestResolved: options.onAttachmentManifestResolved,
            supportsReasoning: runtime.activeModel.reasoning === 1,
            reasoningLevel: DEFAULT_REASONING_LEVEL,
            reasoningOptions: parseReasoningOptions(runtime.activeModel.reasoning_options),
            promptCacheKey: runtime.promptCacheKey,
        };
        // Anthropic renders tool choice and thinking budgets into the cache prefix.
        // The summary stream never executes tools, even with automatic tool choice.
        const preserveReasoningCache =
            runtime.activeModel.provider_driver === 'anthropic' ||
            runtime.activeModel.provider_driver === 'anthropic-compatible';
        const prepared = await this.contextWindow.prepare({
            request,
            projectForTransport,
            contextLimit: runtime.activeModel.context_limit,
            outputLimit: runtime.activeModel.output_limit,
            preserveSummaryOutputBudget: preserveReasoningCache,
            saveSummary: (summary, source) =>
                options.persister.persistContextSummary(summary, runtime.calls, source),
            onCompaction: (contextCompaction) =>
                options.onChunk?.({ content: '', done: false, contextCompaction }),
            summarize: (summaryRequest) =>
                this.summarizeContext(runtime, {
                    ...summaryRequest,
                    toolChoice: preserveReasoningCache ? 'auto' : summaryRequest.toolChoice,
                }),
        });
        if (prepared.messages.some((message) => message.contextSummary)) {
            runtime.privateMessageContents.clear();
            runtime.privateMessageToolCalls.clear();
            for (const [index, message] of prepared.messages.entries()) {
                const privateValues = privateMessageValues.get(message);
                if (privateValues?.content !== undefined)
                    runtime.privateMessageContents.set(index, privateValues.content);
                if (privateValues?.tool_calls !== undefined)
                    runtime.privateMessageToolCalls.set(index, privateValues.tool_calls);
            }
            runtime.messages = snapshotAiMessages(prepared.messages);
            this.syncPrivateCheckpoint(runtime);
            options.onContextPrepared();
        }
        const modelRequest = {
            ...request,
            messages: prepared.messages.map(projectForTransport),
            maxOutputTokens: prepared.maxOutputTokens,
            attachmentRequestIndex: runtime.nextAttachmentRequestIndex++,
        };
        let finishReason: string | undefined;
        let toolCalls: AiToolCall[] | undefined;
        let finalUsage: AiUsage | undefined;
        let usageReported = false;
        // Each model/tool-loop round is an independent persisted message part.
        // Keep the aggregate on `runtime.outputParts`, but never leak the
        // previous round into this round's final-step result.

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
        let streamError: unknown;
        let streamFailed = false;
        try {
            for await (const chunk of runtime.provider.stream(modelRequest)) {
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
                if (chunk.done) {
                    finishReason = chunk.finishReason;
                    toolCalls = chunk.toolCalls;
                    finalUsage = chunk.usage;
                    usageReported = chunk.usageReported === true;
                }
                options.onChunk?.(
                    await publicWidgetChunk(chunk, runtime.privateState.widgetSkillAccess)
                );
                if (chunk.done) {
                    break;
                }
            }
        } catch (error) {
            streamFailed = true;
            streamError = error;
            finishReason =
                options.signal?.aborted ||
                AiError.fromError(error).is(AiErrorCode.REQUEST_CANCELLED)
                    ? 'aborted'
                    : 'error';
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
            usageReported,
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
        // `usage` is normalized to zeros even when the provider reported nothing,
        // so the explicit stream signal is the only evidence of a real report;
        // token sums must never be used to infer it.
        if (usageReported) {
            runtime.usageReportedCalls += 1;
            this.contextWindow.observe(modelRequest, usage);
        }
        runtime.toolArgumentErrors += stepToolArgumentErrors;
        if (runtime.firstTtftMs === null && call.timing.ttftMs !== undefined) {
            runtime.firstTtftMs = call.timing.ttftMs;
            runtime.firstTextMs = call.timing.firstTextMs ?? null;
        }

        if (streamFailed) throw streamError;

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

        if (options.toolCall.name === BUILT_IN_SKILL_TOOL_NAME) {
            if (runtime.privateState.skillActivationAttempts >= MAX_SELECTED_SKILLS) {
                const result = t('skills.contextLimit', { count: MAX_SELECTED_SKILLS });
                this.emitToolEvent(options.onChunk, {
                    type: 'call_end',
                    callId: options.toolCall.id,
                    result,
                    isError: true,
                    durationMs: 0,
                    finalStatus: 'error',
                });
                return { toolCall: options.toolCall, result, isError: true, toolLogId: null };
            }
            runtime.privateState.skillActivationAttempts++;
        }

        const parsedToolArguments = parseToolCallArguments(options.toolCall);
        if (!parsedToolArguments.ok) {
            // 参数解析失败是「结构化输出能力」的直接信号，计入 attempt 级计数。
            runtime.toolArgumentErrors += 1;
            return this.rejectToolCall({
                ...options,
                iteration: runtime.iteration,
                sessionId: options.persister.getSessionId(),
                input: serializeAuditPayload(options.toolCall.arguments),
                result: parsedToolArguments.errorResult,
                durationMs: 0,
            });
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
        const input = serializeAuditPayload(sanitizedToolArgs);

        const builtInResult = await builtInToolService.executeTool({
            toolCall: options.toolCall,
            toolArgs: sanitizedToolArgs,
            iteration: runtime.iteration,
            currentModel: runtime.activeModel,
            widgetSkillAccess: runtime.privateState.widgetSkillAccess,
            signal: options.signal,
            toolCallMessageId: options.toolCallMessageId,
            sessionId: options.persister.getSessionId(),
            requestToolApproval: options.requestToolApproval,
            requestUserQuestions: options.requestUserQuestions,
            emitToolEvent: (toolEvent) => this.emitToolEvent(options.onChunk, toolEvent),
            requestedTimeoutMs,
        });

        if (builtInResult) {
            return {
                ...builtInResult,
                input:
                    builtInResult.builtInToolId === 'show_widget'
                        ? serializeAuditPayload(publicWidgetArguments(sanitizedToolArgs))
                        : input,
            };
        }

        const result = await this.executeMcpToolCall({
            toolCall: options.toolCall,
            toolArgs: sanitizedToolArgs,
            iteration: runtime.iteration,
            signal: options.signal,
            toolCallMessageId: options.toolCallMessageId,
            sessionId: options.persister.getSessionId(),
            onChunk: options.onChunk,
            requestedTimeoutMs,
        });
        return { ...result, input };
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

        const publicCalls = options.step.toolCalls.map(publicToolCall);
        if (publicCalls.some((call, index) => call !== options.step.toolCalls[index])) {
            runtime.privateMessageToolCalls.set(runtime.messages.length, options.step.toolCalls);
        }
        runtime.messages.push(
            buildAssistantToolCallHistoryMessage(options.step.outputParts, publicCalls)
        );

        const toolCallMessageId = await options.persister.persistToolCallMessage(
            options.step.outputParts
        );
        runtime.currentStepOutputParts = [];
        runtime.currentStepReasoningStartedAt = null;

        const toolResults = await Promise.all(
            options.step.toolCalls.map((toolCall) =>
                withSpan(
                    'touchai.tool',
                    {
                        [ATTR.toolCallId]: toolCall.id,
                        [ATTR.toolName]: toolCall.name,
                    },
                    async () => {
                        const startedAt = performance.now();
                        try {
                            const result = await this.executeToolCall(runtime, {
                                toolCall,
                                toolCallMessageId,
                                persister: options.persister,
                                signal: options.signal,
                                onChunk: options.onChunk,
                                requestToolApproval: options.requestToolApproval,
                                requestUserQuestions: options.requestUserQuestions,
                            });
                            options.analytics?.noteToolCompleted({
                                category: toolCategoryForName(toolCall.name),
                                result: result.isError ? 'failure' : 'success',
                                durationMs: performance.now() - startedAt,
                            });
                            return result;
                        } catch (error) {
                            const aiError = AiError.fromError(error);
                            options.analytics?.noteToolCompleted({
                                category: toolCategoryForName(toolCall.name),
                                result: aiError.is(AiErrorCode.REQUEST_CANCELLED)
                                    ? 'cancelled'
                                    : 'failure',
                                durationMs: performance.now() - startedAt,
                            });
                            throw error;
                        }
                    },
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
            result,
            persistedResult,
            isError,
            toolLogId,
            attachments,
        } of toolResults) {
            throwIfAttachmentsUnsupportedByModel(attachments, nextModel);

            if (persistedResult !== undefined && persistedResult !== result) {
                runtime.privateMessageContents.set(
                    runtime.messages.length,
                    await buildToolResultMessageContent(result, attachments)
                );
            }
            runtime.messages.push({
                role: 'tool',
                content: await buildToolResultMessageContent(
                    persistedResult ?? result,
                    attachments
                ),
                tool_call_id: toolCall.id,
                name: toolCall.name,
                isError,
            });

            await options.persister.persistToolResult({
                result: persistedResult ?? result,
                toolCallId: toolCall.id,
                toolCallPartId: toolLogId,
                toolCallMessageId,
                attachments,
            });

            event('agent.tool.completed', {
                [ATTR.toolCallId]: toolCall.id,
                [ATTR.toolName]: toolCall.name,
                'tool.success': !isError,
            });
        }

        const source = await options.persister.getContextMessageSource(toolCallMessageId, {
            outputParts: options.step.outputParts,
            results: toolResults.map((result) => ({
                ...result,
                result: result.persistedResult ?? result.result,
            })),
        });
        if (source) {
            const start = runtime.messages.length - options.step.toolCalls.length - 1;
            for (let index = start; index < runtime.messages.length; index++) {
                runtime.messages[index] = {
                    ...runtime.messages[index]!,
                    contextSource: source,
                };
            }
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
        const privateState = options.privateState ?? {
            messageContents: new Map<number, AiMessage['content']>(),
            messageToolCalls: new Map<number, AiToolCall[]>(),
            skillActivationAttempts: 0,
            widgetSkillAccess: new WidgetSkillAccess(),
        };
        const runtime = await this.createAttemptRuntime(
            options.startCheckpoint,
            options.persister.getSessionId(),
            privateState
        );
        // One mutable cursor releases archived payloads for all owners at each safe boundary.
        const resumeCheckpoint = options.startCheckpoint;
        try {
            while (true) {
                throwIfAborted(options.signal);

                const leaveStreaming = options.analytics?.enterPhase('streaming');
                let step: AttemptStepResult;
                try {
                    step = await withSpan(
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
                                onContextPrepared: () => {
                                    resumeCheckpoint.messages = snapshotAiMessages(
                                        runtime.messages
                                    );
                                    if (options.taskId)
                                        options.onTurnEvent?.({
                                            type: 'checkpoint_committed',
                                            taskId: options.taskId,
                                            checkpoint: resumeCheckpoint,
                                        });
                                },
                                onAttachmentManifestResolved: async (request) => {
                                    try {
                                        await options.persister.syncDeliveryManifestRequest(
                                            request
                                        );
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
                } finally {
                    if (options.signal?.aborted) options.analytics?.noteAbort();
                    leaveStreaming?.();
                }

                if (step.type === 'done') {
                    break;
                }

                const leaveTool = options.analytics?.enterPhase('tool');
                try {
                    await this.runToolRound(runtime, {
                        step,
                        persister: options.persister,
                        parentSpan: options.parentSpan,
                        signal: options.signal,
                        onChunk: options.onChunk,
                        analytics: options.analytics,
                        requestToolApproval: options.requestToolApproval,
                        requestUserQuestions: options.requestUserQuestions,
                    });
                } finally {
                    if (options.signal?.aborted) options.analytics?.noteAbort();
                    leaveTool?.();
                }

                runtime.iteration += 1;
                Object.assign(resumeCheckpoint, this.commitCheckpoint(runtime));
                this.syncPrivateCheckpoint(runtime);
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
                usageReportedCalls: runtime.usageReportedCalls,
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
                    options.signal?.aborted ||
                    (unwrapped instanceof AiError && unwrapped.is(AiErrorCode.REQUEST_CANCELLED))
                        ? new AiError(AiErrorCode.REQUEST_CANCELLED, undefined, undefined, {
                              cause: unwrapped,
                          })
                        : (runtime.provider.classifyError?.(unwrapped) ??
                          AiError.fromError(unwrapped));
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
                usageReportedCalls: runtime.usageReportedCalls,
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
