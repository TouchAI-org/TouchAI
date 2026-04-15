// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createMcpToolLog, updateMcpToolLogByCallId } from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import type { ProviderDriver, ToolLogKind } from '@database/schema';

import {
    type BuiltInToolControlSignal,
    type BuiltInToolId,
    builtInToolService,
} from '@/services/BuiltInToolService';
import { z } from '@/utils/zod';

import { createProviderForModel, getModel, resolveToolDefinitions } from '../catalog';
import { AiError, AiErrorCode } from '../contracts/errors';
import type { AiMessage, AiStreamChunk } from '../contracts/protocol';
import type {
    AiToolCall,
    AiToolDefinition,
    ToolApprovalDecisionRequest,
    ToolEventModelSummary,
} from '../contracts/tooling';
import { type AttachmentIndex, buildAttachmentParts } from '../infrastructure/attachments';
import { mcpManager } from '../infrastructure/mcp';
import {
    type AiProvider,
    createProviderFromRegistry,
    parseProviderConfigJson,
} from '../infrastructure/providers';
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
    `工具参数协议错误：${toolName} 返回了无效的 JSON 参数。`;
const formatToolArgumentShapeError = (toolName: string, issues: string): string =>
    `工具参数协议错误：${toolName} 必须接收 JSON 对象。\n${issues}`;
const formatToolNotFoundError = (toolName: string): string => `未找到工具：${toolName}`;
const formatToolExecutionFailedError = (errorMessage: string): string =>
    `工具执行失败：${errorMessage}`;

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
}

export interface AttemptCheckpoint {
    activeModel: ModelWithProvider;
    messages: AiMessage[];
    response: string;
    reasoning: string;
    iteration: number;
    modelSwitchCount: number;
    executedBuiltInToolIds: BuiltInToolId[];
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
    hasVisibleOutputSinceCheckpoint: boolean;
    hasToolActivitySinceCheckpoint: boolean;
    executedBuiltInTools: Set<BuiltInToolId>;
}

interface ToolExecutionResult {
    toolCall: AiToolCall;
    result: string;
    isError: boolean;
    toolLogId: number | null;
    toolLogKind: ToolLogKind | null;
    attachments?: AttachmentIndex[];
    builtInToolId?: BuiltInToolId;
    controlSignal?: BuiltInToolControlSignal;
}

type AttemptStepResult =
    | { type: 'done' }
    | {
          type: 'tool_calls';
          chunkResponse: string;
          toolCalls: AiToolCall[];
      };

export type AttemptExecutionResult =
    | {
          type: 'completed';
          model: ModelWithProvider;
          response: string;
          reasoning: string;
      }
    | {
          type: 'failed';
          error: AiError;
          response: string;
          resumeCheckpoint: AttemptCheckpoint;
          hasVisibleOutputSinceCheckpoint: boolean;
          hasToolActivitySinceCheckpoint: boolean;
          providerErrorDetails: ProviderErrorDetails | null;
      };

export type AttemptFailureResult = Extract<AttemptExecutionResult, { type: 'failed' }>;

export interface RunAttemptOptions extends RequestExecutionCallbacks {
    startCheckpoint: AttemptCheckpoint;
    maxIterations: number;
    persister: PersistenceProjector;
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

function cloneAiMessages(messages: AiMessage[]): AiMessage[] {
    return JSON.parse(JSON.stringify(messages)) as AiMessage[];
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
        signal?: AbortSignal,
        maxTokens?: number,
        attachmentRequestIndex?: number,
        onAttachmentManifestResolved?: RequestExecutionCallbacks['onAttachmentManifestResolved']
    ): AsyncGenerator<AiStreamChunk, void, unknown> {
        console.debug(
            `[AiRequestExecutor] Start stream request, model=${modelId}, messages=${messages.length}, tools=${tools?.length ?? 0}`
        );
        for await (const chunk of provider.stream({
            model: modelId,
            providerId,
            messages,
            tools,
            signal,
            maxTokens,
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
    }): Promise<{
        toolCall: AiToolCall;
        result: string;
        isError: boolean;
        toolLogId: number | null;
        toolLogKind: ToolLogKind | null;
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
                toolLogKind: null,
                controlSignal: undefined,
            };
        }

        this.emitToolEvent(options.onChunk, {
            type: 'call_start',
            callId: options.toolCall.id,
            toolName: mapping.originalName,
            namespacedName: options.toolCall.name,
            source: 'mcp',
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
                input: JSON.stringify(options.toolArgs),
                status: 'pending',
            });
            toolLogId = toolLog.id;
        } catch (error) {
            console.error('[AiRequestExecutor] Failed to create MCP tool log:', error);
        }

        let toolResult: { result: string; isError: boolean; attachments?: AttachmentIndex[] };
        try {
            toolResult = await mcpManager.executeTool(options.toolCall.name, options.toolArgs, {
                signal: options.signal,
                iteration: options.iteration,
                toolCallId: options.toolCall.id,
                resolved: {
                    serverId: mapping.serverId,
                    originalName: mapping.originalName,
                    toolTimeout: mapping.toolTimeout,
                },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(
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
            output: toolResult.result,
            status: toolResult.isError ? 'error' : 'success',
            duration_ms: durationMs,
            error_message: toolResult.isError ? toolResult.result : null,
        }).catch((error) => {
            console.error('[AiRequestExecutor] Failed to update MCP tool log:', error);
        });

        return {
            toolCall: options.toolCall,
            result: toolResult.result,
            isError: toolResult.isError,
            toolLogId,
            toolLogKind: 'mcp',
            attachments: toolResult.attachments,
            controlSignal: undefined,
        };
    }

    createInitialCheckpoint(options: {
        initialModel: ModelWithProvider;
        baseMessages: AiMessage[];
    }): AttemptCheckpoint {
        return {
            activeModel: options.initialModel,
            messages: cloneAiMessages(options.baseMessages),
            response: '',
            reasoning: '',
            iteration: 0,
            modelSwitchCount: 0,
            executedBuiltInToolIds: [],
        };
    }

    private async createAttemptRuntime(
        startCheckpoint: AttemptCheckpoint
    ): Promise<AttemptRuntime> {
        const { activeModel, modelSwitchCount } = startCheckpoint;

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
            hasVisibleOutputSinceCheckpoint: false,
            hasToolActivitySinceCheckpoint: false,
            executedBuiltInTools: new Set(startCheckpoint.executedBuiltInToolIds),
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
            executedBuiltInToolIds: [...runtime.executedBuiltInTools],
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
        >
    ): Promise<AttemptStepResult> {
        const stream = this.stream(
            runtime.provider,
            runtime.activeModel.provider_id,
            runtime.activeModel.model_id,
            runtime.messages,
            runtime.tools,
            options.signal,
            runtime.activeModel.output_limit ?? undefined,
            runtime.iteration,
            options.onAttachmentManifestResolved
        );
        let chunkResponse = '';
        let finishReason: string | undefined;
        let toolCalls: AiToolCall[] | undefined;

        for await (const chunk of stream) {
            throwIfAborted(options.signal);

            if (chunk.reasoning) {
                runtime.reasoning += chunk.reasoning;
                runtime.hasVisibleOutputSinceCheckpoint = true;
            }

            if (chunk.content) {
                chunkResponse += chunk.content;
                runtime.response += chunk.content;
                runtime.hasVisibleOutputSinceCheckpoint = true;
            }

            if (
                chunk.toolEvent ||
                (chunk.toolCallDeltas && chunk.toolCallDeltas.length > 0) ||
                (chunk.done && chunk.toolCalls && chunk.toolCalls.length > 0)
            ) {
                runtime.hasToolActivitySinceCheckpoint = true;
            }

            options.onChunk?.(chunk);

            if (chunk.done) {
                finishReason = chunk.finishReason;
                toolCalls = chunk.toolCalls;
                break;
            }
        }

        const isToolRelated = finishReason === 'tool_calls' || finishReason === 'tool_use';
        if (!isToolRelated || !toolCalls || toolCalls.length === 0) {
            return { type: 'done' };
        }

        runtime.hasToolActivitySinceCheckpoint = true;
        return {
            type: 'tool_calls',
            chunkResponse,
            toolCalls,
        };
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
                toolLogKind: null,
            };
        }

        const { toolArgs } = parsedToolArguments;
        const builtInResult = await builtInToolService.executeTool({
            toolCall: options.toolCall,
            toolArgs,
            iteration: runtime.iteration,
            currentModel: runtime.activeModel,
            hasExecutedBuiltInTool: (toolId) => runtime.executedBuiltInTools.has(toolId),
            signal: options.signal,
            toolCallMessageId: options.toolCallMessageId,
            sessionId: options.persister.getSessionId(),
            requestToolApproval: options.requestToolApproval,
            emitToolEvent: (toolEvent) => this.emitToolEvent(options.onChunk, toolEvent),
        });

        if (builtInResult) {
            return builtInResult;
        }

        return this.executeMcpToolCall({
            toolCall: options.toolCall,
            toolArgs,
            iteration: runtime.iteration,
            signal: options.signal,
            toolCallMessageId: options.toolCallMessageId,
            sessionId: options.persister.getSessionId(),
            onChunk: options.onChunk,
        });
    }

    private async runToolRound(
        runtime: AttemptRuntime,
        options: {
            step: Extract<AttemptStepResult, { type: 'tool_calls' }>;
            persister: PersistenceProjector;
        } & RequestExecutionCallbacks
    ): Promise<void> {
        this.emitToolEvent(options.onChunk, {
            type: 'iteration_start',
            iteration: runtime.iteration,
        });

        runtime.messages.push({
            role: 'assistant',
            content: options.step.chunkResponse,
            tool_calls: options.step.toolCalls,
        });

        const toolCallMessageId = await options.persister.persistToolCallMessage(
            options.step.chunkResponse
        );

        const toolResults = await Promise.all(
            options.step.toolCalls.map((toolCall) =>
                this.executeToolCall(runtime, {
                    toolCall,
                    toolCallMessageId,
                    persister: options.persister,
                    signal: options.signal,
                    onChunk: options.onChunk,
                    requestToolApproval: options.requestToolApproval,
                })
            )
        );

        let requestedModelSwitch: BuiltInToolControlSignal | null = null;
        for (const {
            toolCall,
            builtInToolId,
            result,
            isError,
            toolLogId,
            toolLogKind,
            attachments,
            controlSignal,
        } of toolResults) {
            runtime.messages.push({
                role: 'tool',
                content: await buildToolResultMessageContent(result, attachments),
                tool_call_id: toolCall.id,
                name: toolCall.name,
                isError,
            });

            await options.persister.persistToolResultMessage(
                result,
                toolLogId,
                toolLogKind,
                attachments
            );

            if (builtInToolId && !isError) {
                runtime.executedBuiltInTools.add(builtInToolId);
            }

            if (!requestedModelSwitch && controlSignal?.type === 'upgrade_model') {
                requestedModelSwitch = controlSignal;
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
            while (runtime.iteration < options.maxIterations) {
                throwIfAborted(options.signal);

                const step = await this.consumeModelStep(runtime, {
                    signal: options.signal,
                    onChunk: options.onChunk,
                    onAttachmentManifestResolved: async (request) => {
                        try {
                            await options.persister.syncDeliveryManifestRequest(request);
                        } catch (error) {
                            console.error(
                                '[AiRequestExecutor] Failed to persist attachment delivery manifest request:',
                                error
                            );
                        }
                    },
                });

                if (step.type === 'done') {
                    break;
                }

                await this.runToolRound(runtime, {
                    step,
                    persister: options.persister,
                    signal: options.signal,
                    onChunk: options.onChunk,
                    requestToolApproval: options.requestToolApproval,
                });

                runtime.iteration += 1;
                resumeCheckpoint = this.commitCheckpoint(runtime);
                await options.persister.persistCheckpoint(resumeCheckpoint).catch((error) => {
                    console.error('[AiRequestExecutor] Failed to persist checkpoint:', error);
                });
                if (options.taskId) {
                    options.onTurnEvent?.({
                        type: 'checkpoint_committed',
                        taskId: options.taskId,
                        checkpoint: resumeCheckpoint,
                    });
                }
            }

            if (runtime.iteration >= options.maxIterations) {
                console.warn('[AiRequestExecutor] Max iterations reached');
                runtime.response += `\n\n[${AiError.getMessage(AiErrorCode.MCP_MAX_ITERATIONS_REACHED)}]`;
            }

            throwIfAborted(options.signal);

            if (!runtime.response.trim() && !runtime.reasoning.trim()) {
                throw new AiError(AiErrorCode.EMPTY_RESPONSE);
            }

            return {
                type: 'completed',
                model: runtime.activeModel,
                response: runtime.response,
                reasoning: runtime.reasoning,
            };
        } catch (error) {
            // AI SDK RetryError 包装了真正的错误——解包后传递给分类器
            const unwrapped = unwrapRetryError(error);
            console.warn('[AiRequestExecutor] Request failed:', unwrapped, typeof unwrapped);
            const providerErrorDetails = extractProviderErrorDetails(unwrapped);
            if (providerErrorDetails) {
                console.warn('[AiRequestExecutor] Provider error details:', providerErrorDetails);
            }

            // 先让 provider 自己分类，再 fallback 到通用启发式
            const classifiedError =
                runtime.provider.classifyError?.(unwrapped) ?? AiError.fromError(unwrapped);

            return {
                type: 'failed',
                error: classifiedError,
                response: runtime.response,
                resumeCheckpoint,
                hasVisibleOutputSinceCheckpoint: runtime.hasVisibleOutputSinceCheckpoint,
                hasToolActivitySinceCheckpoint: runtime.hasToolActivitySinceCheckpoint,
                providerErrorDetails,
            };
        }
    }
}

export type { ModelWithProvider };
