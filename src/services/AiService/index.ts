// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    createMcpToolLog,
    findDefaultModelWithProvider,
    findModelByProviderAndModelId,
    updateMcpToolLogByCallId,
    updateModelLastUsed,
} from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import type { ProviderDriver, ToolLogKind } from '@database/schema';
import type { SessionTurnEntity } from '@database/types';
import type { Index } from '@services/AiService/attachments';

import { type BuiltInToolId, builtInToolService } from '@/services/BuiltInToolService';
import { useSettingsStore } from '@/stores/settings';
import { collapseWhitespace, truncateText } from '@/utils/text';
import { z } from '@/utils/zod';

import { AiError, AiErrorCode } from './errors';
import { mcpManager } from './mcp';
import { buildRequestMessages } from './messages';
import { Persister } from './persister';
import { createProviderFromRegistry } from './provider';
import { parseProviderConfigJson } from './providers/shared/ai-sdk-base';
import { getRetryDelayMs, MAX_REQUEST_RETRIES, shouldRetryRequestFailure } from './retry';
import type {
    AiMessage,
    AiProvider,
    AiStreamChunk,
    AiToolCall,
    AiToolDefinition,
    ToolApprovalDecisionRequest,
    ToolEventModelSummary,
} from './types';

const BUILT_IN_UPGRADE_TOOL_NAME = 'builtin__upgrade_model';
const MAX_REQUEST_MODEL_SWITCHES = 4;
const toolArgumentsSchema = z.record(z.string(), z.unknown());
const TOOL_DISCIPLINE_SYSTEM_PROMPT = [
    '你可以使用本轮请求提供的工具。',
    '当用户明确要求“调用工具”或要求执行某个必须依赖工具的动作时，必须实际发起对应工具调用，不能只用文字承诺自己会去做。',
    '当用户要求升级模型、切换到更强模型、切到更高一级模型，且 `builtin__upgrade_model` 可用时，必须直接调用 `builtin__upgrade_model`，参数为 {}。',
    '不要先输出“我来帮你升级模型”这类占位文本；应先调用工具，再基于工具结果继续回复。',
].join('\n');

interface ProviderErrorDetails {
    statusCode?: number;
    url?: string;
    responseBody?: unknown;
    requestBodyValues?: unknown;
    data?: unknown;
}

function isProviderErrorDetails(value: unknown): value is ProviderErrorDetails {
    return !!value && typeof value === 'object';
}

/**
 * 提取 provider SDK 错误里的关键诊断字段。
 * Vercel AI SDK 的 APICallError 会把 responseBody / requestBodyValues 挂在错误对象上。
 */
function extractProviderErrorDetails(error: unknown): ProviderErrorDetails | null {
    if (!isProviderErrorDetails(error)) {
        return null;
    }

    const details: ProviderErrorDetails = {};

    if (typeof error.statusCode === 'number') {
        details.statusCode = error.statusCode;
    }
    if (typeof error.url === 'string') {
        details.url = error.url;
    }
    if ('responseBody' in error) {
        details.responseBody = error.responseBody;
    }
    if ('requestBodyValues' in error) {
        details.requestBodyValues = error.requestBodyValues;
    }
    if ('data' in error) {
        details.data = error.data;
    }

    return Object.keys(details).length > 0 ? details : null;
}

function cloneAiMessages(messages: AiMessage[]): AiMessage[] {
    return JSON.parse(JSON.stringify(messages)) as AiMessage[];
}

async function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
    if (delayMs <= 0) {
        return;
    }

    if (signal?.aborted) {
        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
    }

    await new Promise<void>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            signal?.removeEventListener('abort', handleAbort);
            resolve();
        }, delayMs);

        const handleAbort = () => {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', handleAbort);
            reject(new AiError(AiErrorCode.REQUEST_CANCELLED));
        };

        signal?.addEventListener('abort', handleAbort, { once: true });
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
            errorResult: `Tool argument protocol error: ${toolCall.name} returned invalid JSON arguments.`,
        };
    }

    const result = toolArgumentsSchema.safeParse(parsedArguments);
    if (!result.success) {
        return {
            ok: false,
            errorResult: `Tool argument protocol error: ${toolCall.name} must receive a JSON object.\n${formatToolArgumentsIssues(result.error)}`,
        };
    }

    return {
        ok: true,
        toolArgs: result.data,
    };
}

export interface ExecuteRequestOptions {
    prompt: string;
    sessionId?: number;
    modelId?: string;
    providerId?: number;
    attachments?: Index[];
    signal?: AbortSignal;
    onChunk?: (chunk: AiStreamChunk) => void;
    requestToolApproval?: (payload: ToolApprovalDecisionRequest) => Promise<boolean>;
}

export interface ExecuteRequestResult {
    model: ModelWithProvider;
    response: string;
    reasoning: string;
    turn: SessionTurnEntity | null;
}

/**
 * 模型与服务商信息的联合类型
 */
export type { ModelWithProvider };

/**
 * AI 服务管理器
 * 负责模型解析与流式请求编排。
 */
export class AiServiceManager {
    /**
     * 获取模型（统一入口）
     * - 不传参数：返回默认模型
     * - 传 providerId + modelId：返回指定模型
     */
    async getModel(options?: {
        providerId?: number;
        modelId?: string;
    }): Promise<ModelWithProvider> {
        // 精确查找指定模型
        if (options?.providerId && options?.modelId) {
            const model = await findModelByProviderAndModelId({
                providerId: options.providerId,
                modelId: options.modelId,
            });

            if (!model) {
                throw new AiError(AiErrorCode.MODEL_NOT_FOUND, {
                    providerId: options.providerId,
                    modelId: options.modelId,
                });
            }

            if (model.provider_enabled === 0) {
                throw new AiError(AiErrorCode.PROVIDER_DISABLED, {
                    providerId: options.providerId,
                    modelId: options.modelId,
                });
            }

            return model;
        }

        // 获取默认模型
        const defaultModel = await findDefaultModelWithProvider();

        if (!defaultModel) {
            console.warn('[AiServiceManager] No default model found or provider disabled');
            throw new AiError(AiErrorCode.NO_ACTIVE_MODEL);
        }

        return defaultModel;
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

    /**
     * 流式 AI 响应（纯粹的流式生成器）
     */
    private async *stream(
        provider: AiProvider,
        modelId: string,
        messages: AiMessage[],
        tools?: AiToolDefinition[],
        signal?: AbortSignal,
        maxTokens?: number
    ): AsyncGenerator<AiStreamChunk, void, unknown> {
        console.debug(
            `[AIService] Start stream request, model=${modelId}, messages=${messages.length}, tools=${tools?.length ?? 0}`
        );
        for await (const chunk of provider.stream({
            model: modelId,
            messages,
            tools,
            signal,
            maxTokens,
        })) {
            yield chunk;
        }
    }

    private emitToolEvent(
        onChunk: ExecuteRequestOptions['onChunk'],
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

    private async resolveToolDefinitions(
        model: ModelWithProvider,
        options: { disableUpgradeModel?: boolean } = {}
    ): Promise<AiToolDefinition[] | undefined> {
        if (model.tool_call !== 1) {
            return undefined;
        }

        const [mcpTools, builtInTools] = await Promise.all([
            mcpManager.getEnabledToolDefinitions(),
            builtInToolService.getEnabledToolDefinitions(),
        ]);
        // upgrade_model 可以在一次请求里触发“切模后继续当前上下文”。
        // 达到切换上限后要从工具列表里移除，避免模型在升级链上自触发循环。
        const filteredBuiltInTools = options.disableUpgradeModel
            ? builtInTools.filter((tool) => tool.name !== BUILT_IN_UPGRADE_TOOL_NAME)
            : builtInTools;

        return [...mcpTools, ...filteredBuiltInTools];
    }

    private async executeMcpToolCall(options: {
        toolCall: AiToolCall;
        toolArgs: Record<string, unknown>;
        iteration: number;
        signal?: AbortSignal;
        toolCallMessageId: number | null;
        sessionId: number | null;
        onChunk?: ExecuteRequestOptions['onChunk'];
    }): Promise<{
        toolCall: AiToolCall;
        result: string;
        isError: boolean;
        toolLogId: number | null;
        toolLogKind: ToolLogKind | null;
        builtInToolId?: undefined;
        controlSignal?: undefined;
    }> {
        const callStartTime = Date.now();
        const mapping = await mcpManager.resolveToolCall(options.toolCall.name);

        if (!mapping) {
            const errorResult = `Tool not found: ${options.toolCall.name}`;
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
            console.error('[AiServiceManager] Failed to create MCP tool log:', error);
        }

        let toolResult: { result: string; isError: boolean };
        try {
            toolResult = await mcpManager.executeTool(options.toolCall.name, options.toolArgs, {
                signal: options.signal,
                iteration: options.iteration,
                resolved: {
                    serverId: mapping.serverId,
                    originalName: mapping.originalName,
                    toolTimeout: mapping.toolTimeout,
                },
            });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(
                `[AiServiceManager] MCP tool execution failed: ${options.toolCall.name}`,
                error
            );
            toolResult = {
                result: `Tool execution failed: ${errorMessage}`,
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
            console.error('[AiServiceManager] Failed to update MCP tool log:', error);
        });

        return {
            toolCall: options.toolCall,
            result: toolResult.result,
            isError: toolResult.isError,
            toolLogId,
            toolLogKind: 'mcp',
            controlSignal: undefined,
        };
    }

    /**
     * 执行 AI 请求流程：模型解析、流消费、分阶段持久化。
     * 支持工具调用循环。
     */
    async run(options: ExecuteRequestOptions): Promise<ExecuteRequestResult> {
        const {
            prompt,
            sessionId,
            modelId,
            providerId,
            attachments = [],
            signal,
            onChunk,
            requestToolApproval,
        } = options;

        // 1. 获得模型配置
        const initialModel = await this.resolveModel(modelId, providerId);

        // 2. 构建请求消息
        const baseMessages = await buildRequestMessages({
            prompt,
            sessionId,
            attachments,
            supportsAttachments: initialModel.attachment === 1,
        });
        baseMessages.unshift({
            role: 'system',
            content: TOOL_DISCIPLINE_SYSTEM_PROMPT,
        });

        // 3. 初始化持久化管理器
        const persister = new Persister({
            prompt,
            attachments,
            model: initialModel,
            sessionId: sessionId ?? null,
            maxRetries: MAX_REQUEST_RETRIES,
            buildSessionTitle,
        });

        // 4. 异步记录请求开始（不阻塞主流程）
        const requestStartRecordPromise = persister.recordTurnStart().catch((error) => {
            console.error('[AiServiceManager] Failed to record request start:', error);
        });
        const startedAt = Date.now();
        let requestFinalized = false;

        try {
            // 5. 从设置中获取最大迭代次数
            const settingsStore = useSettingsStore();
            await settingsStore.initialize();
            const maxIterations = settingsStore.mcpMaxIterations;

            for (let retryAttempt = 0; retryAttempt <= MAX_REQUEST_RETRIES; retryAttempt += 1) {
                let activeModel = initialModel;
                let provider = this.createProviderInstance(
                    activeModel.provider_driver as ProviderDriver,
                    activeModel.api_endpoint,
                    activeModel.api_key,
                    activeModel.provider_config_json
                );
                let modelSwitchCount = 0;
                let tools = await this.resolveToolDefinitions(activeModel);
                const executedBuiltInTools = new Set<BuiltInToolId>();
                // 仅在重试时克隆消息，首次尝试直接复用基础消息
                const messages = retryAttempt === 0 ? baseMessages : cloneAiMessages(baseMessages);
                let response = '';
                let reasoning = '';
                let iteration = 0;
                let attemptHasVisibleOutput = false;
                let attemptHasToolActivity = false;

                try {
                    while (iteration < maxIterations) {
                        if (signal?.aborted) {
                            throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                        }

                        // 从提供方实例获取流式响应
                        const stream = this.stream(
                            provider,
                            activeModel.model_id,
                            messages,
                            tools,
                            signal,
                            activeModel.output_limit ?? undefined
                        );
                        let chunkResponse = '';
                        let finishReason: string | undefined;
                        let toolCalls: AiToolCall[] | undefined;

                        for await (const chunk of stream) {
                            if (signal?.aborted) {
                                throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                            }

                            if (chunk.reasoning) {
                                reasoning += chunk.reasoning;
                                attemptHasVisibleOutput = true;
                            }

                            if (chunk.content) {
                                chunkResponse += chunk.content;
                                response += chunk.content;
                                attemptHasVisibleOutput = true;
                            }

                            if (
                                chunk.toolEvent ||
                                (chunk.toolCallDeltas && chunk.toolCallDeltas.length > 0) ||
                                (chunk.done && chunk.toolCalls && chunk.toolCalls.length > 0)
                            ) {
                                attemptHasToolActivity = true;
                            }

                            onChunk?.(chunk);

                            if (chunk.done) {
                                finishReason = chunk.finishReason;
                                toolCalls = chunk.toolCalls;
                                break;
                            }
                        }

                        // 检查是否需要继续循环
                        const isToolRelated =
                            finishReason === 'tool_calls' || finishReason === 'tool_use';

                        if (!isToolRelated || !toolCalls || toolCalls.length === 0) {
                            // 无工具调用，退出循环
                            break;
                        }

                        attemptHasToolActivity = true;

                        // 发送迭代开始事件（仅当工具调用将被执行时）
                        onChunk?.({
                            content: '',
                            done: false,
                            toolEvent: { type: 'iteration_start', iteration },
                        });

                        // 追加携带工具调用列表的助手消息
                        messages.push({
                            role: 'assistant',
                            content: chunkResponse,
                            tool_calls: toolCalls,
                        });

                        // 持久化工具调用消息
                        const toolCallMessageId =
                            await persister.persistToolCallMessage(chunkResponse);

                        // 工具执行可以并行，但把结果写回消息数组时仍按原始顺序串回，
                        // 这样下一轮请求看到的工具结果顺序才和助手声明的工具调用顺序一致。
                        const toolExecutionPromises = toolCalls.map(async (toolCall) => {
                            if (signal?.aborted) {
                                throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                            }

                            const parsedToolArguments = parseToolCallArguments(toolCall);
                            if (!parsedToolArguments.ok) {
                                this.emitToolEvent(onChunk, {
                                    type: 'call_end',
                                    callId: toolCall.id,
                                    result: parsedToolArguments.errorResult,
                                    isError: true,
                                    durationMs: 0,
                                    finalStatus: 'error',
                                });

                                return {
                                    toolCall,
                                    result: parsedToolArguments.errorResult,
                                    isError: true,
                                    toolLogId: null,
                                    toolLogKind: null,
                                    controlSignal: undefined,
                                };
                            }

                            const { toolArgs } = parsedToolArguments;

                            const builtInResult = await builtInToolService.executeTool({
                                toolCall,
                                toolArgs,
                                iteration,
                                currentModel: activeModel,
                                hasExecutedBuiltInTool: (toolId) =>
                                    executedBuiltInTools.has(toolId),
                                signal,
                                toolCallMessageId,
                                sessionId: persister.getSessionId(),
                                requestToolApproval,
                                emitToolEvent: (toolEvent) =>
                                    this.emitToolEvent(onChunk, toolEvent),
                            });

                            if (builtInResult) {
                                return builtInResult;
                            }

                            return this.executeMcpToolCall({
                                toolCall,
                                toolArgs,
                                iteration,
                                signal,
                                toolCallMessageId,
                                sessionId: persister.getSessionId(),
                                onChunk,
                            });
                        });

                        // 等待所有工具执行完成
                        const toolResults = await Promise.all(toolExecutionPromises);

                        // 按顺序处理结果（保持消息顺序一致）
                        let requestedModelSwitch: NonNullable<
                            (typeof toolResults)[number]['controlSignal']
                        > | null = null;
                        for (const {
                            toolCall,
                            builtInToolId,
                            result,
                            isError,
                            toolLogId,
                            toolLogKind,
                            controlSignal,
                        } of toolResults) {
                            // 追加工具结果消息
                            messages.push({
                                role: 'tool',
                                content: result,
                                tool_call_id: toolCall.id,
                                name: toolCall.name,
                                isError,
                            });

                            // 持久化工具结果消息
                            await persister.persistToolResultMessage(
                                result,
                                toolLogId,
                                toolLogKind
                            );

                            if (builtInToolId && !isError) {
                                executedBuiltInTools.add(builtInToolId);
                            }

                            // 同一轮只接受第一个切模信号，避免多个工具同时要求切模时反复覆盖当前激活模型。
                            if (!requestedModelSwitch && controlSignal?.type === 'upgrade_model') {
                                requestedModelSwitch = controlSignal;
                            }
                        }

                        // 发送迭代结束事件
                        onChunk?.({
                            content: '',
                            done: false,
                            toolEvent: { type: 'iteration_end', iteration },
                        });

                        if (requestedModelSwitch?.type === 'upgrade_model') {
                            const previousModel = activeModel;
                            activeModel = requestedModelSwitch.targetModel;
                            modelSwitchCount += 1;

                            provider = this.createProviderInstance(
                                activeModel.provider_driver as ProviderDriver,
                                activeModel.api_endpoint,
                                activeModel.api_key,
                                activeModel.provider_config_json
                            );
                            tools = await this.resolveToolDefinitions(activeModel, {
                                disableUpgradeModel: modelSwitchCount >= MAX_REQUEST_MODEL_SWITCHES,
                            });

                            this.emitToolEvent(onChunk, {
                                type: 'model_switched',
                                fromModel: this.buildToolEventModelSummary(previousModel),
                                toModel: this.buildToolEventModelSummary(activeModel),
                                restart: requestedModelSwitch.restartCurrentRequest,
                            });

                            // 模型切换沿用当前上下文继续，但当前工具调用仍计入本轮迭代。
                            iteration++;
                            continue;
                        }

                        iteration++;
                    }

                    // 检查是否达到最大迭代次数 - 追加警告而非抛出异常
                    if (iteration >= maxIterations) {
                        console.warn('[AiServiceManager] Max iterations reached');
                        response += `\n\n[${AiError.getMessage(AiErrorCode.MCP_MAX_ITERATIONS_REACHED)}]`;
                    }

                    if (signal?.aborted) {
                        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                    }

                    if (!response.trim() && !reasoning.trim()) {
                        throw new AiError(AiErrorCode.EMPTY_RESPONSE);
                    }

                    // 9. 持久化相关状态
                    await requestStartRecordPromise;
                    await persister.markCompleted({
                        response,
                        durationMs: Date.now() - startedAt,
                    });
                    requestFinalized = true;

                    await updateModelLastUsed({ id: activeModel.id }).catch((error) => {
                        console.error(
                            '[AiServiceManager] Failed to update model last used:',
                            error
                        );
                    });

                    return {
                        model: activeModel,
                        response,
                        reasoning,
                        turn: persister.getTurn(),
                    };
                } catch (error) {
                    console.warn('[AiServiceManager] Request failed:', error, typeof error);
                    const providerErrorDetails = extractProviderErrorDetails(error);
                    if (providerErrorDetails) {
                        console.warn(
                            '[AiServiceManager] Provider error details:',
                            providerErrorDetails
                        );
                    }

                    const aiError = AiError.fromError(error);

                    await requestStartRecordPromise;

                    if (aiError.is(AiErrorCode.REQUEST_CANCELLED)) {
                        await persister.markCancelled();
                        requestFinalized = true;
                        throw aiError;
                    }

                    const canRetry =
                        retryAttempt < MAX_REQUEST_RETRIES &&
                        !attemptHasVisibleOutput &&
                        !attemptHasToolActivity &&
                        shouldRetryRequestFailure(aiError, providerErrorDetails);

                    if (canRetry) {
                        const nextAttempt = retryAttempt + 1;
                        await persister.beginNextAttempt(aiError.message);
                        onChunk?.({
                            content: '',
                            done: false,
                            toolEvent: {
                                type: 'request_retry',
                                attempt: nextAttempt,
                                maxRetries: MAX_REQUEST_RETRIES,
                                reason: aiError.message,
                            },
                        });
                        await waitForRetryDelay(getRetryDelayMs(nextAttempt), signal);
                        continue;
                    }

                    await persister.markFailed(aiError.message, response);
                    requestFinalized = true;
                    throw aiError;
                }
            }
        } catch (error) {
            const aiError = AiError.fromError(error);
            await requestStartRecordPromise;

            if (!requestFinalized) {
                if (aiError.is(AiErrorCode.REQUEST_CANCELLED)) {
                    await persister.markCancelled();
                } else {
                    await persister.markFailed(aiError.message);
                }
            }

            throw aiError;
        }

        throw new AiError(AiErrorCode.UNKNOWN, undefined, '请求重试耗尽后未返回结果');
    }

    private async resolveModel(modelId?: string, providerId?: number): Promise<ModelWithProvider> {
        if (modelId && providerId) {
            return this.getModel({
                providerId,
                modelId,
            });
        }

        return this.getModel();
    }
}

function buildSessionTitle(prompt: string): string {
    const normalized = collapseWhitespace(prompt);
    if (!normalized) {
        return '新会话';
    }

    return truncateText(normalized, 40);
}

// 导出单例
export const aiService = new AiServiceManager();

// 导出错误类和错误码
export { AiError, AiErrorCode } from './errors';

// 导出会话管理函数
export { createSession, getSessionConversation, listSessions } from './session';
