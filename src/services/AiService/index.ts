// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    createMcpToolLog,
    findDefaultModelWithProvider,
    findModelByProviderAndModelId,
    updateMcpToolLogByCallId,
    updateModelLastUsed,
} from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import { getSettingValue } from '@database/queries/settings';
import type { ProviderType } from '@database/schema';
import { SettingKey } from '@database/schema';
import type { AiRequestEntity } from '@database/types';
import type { Index } from '@services/AiService/attachments';

import { AiError, AiErrorCode } from './errors';
import { mcpManager } from './mcp';
import { buildRequestMessages } from './messages';
import { Persister } from './persister';
import { createProviderFromRegistry, normalizeProviderEndpoint } from './provider';
import type { AiMessage, AiProvider, AiStreamChunk, AiToolCall, AiToolDefinition } from './types';

export interface ExecuteRequestOptions {
    prompt: string;
    sessionId?: number;
    modelId?: string;
    providerId?: number;
    attachments?: Index[];
    signal?: AbortSignal;
    onChunk?: (chunk: AiStreamChunk) => void;
}

export interface ExecuteRequestResult {
    model: ModelWithProvider;
    response: string;
    reasoning: string;
    request: AiRequestEntity | null;
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
        providerType: ProviderType,
        apiEndpoint: string,
        apiKey?: string | null
    ): AiProvider {
        const normalizedEndpoint = normalizeProviderEndpoint(providerType, apiEndpoint);
        return createProviderFromRegistry(providerType, {
            apiEndpoint: normalizedEndpoint,
            apiKey: apiKey || undefined,
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

    /**
     * 执行AI请求流程：模型解析、流消费、分阶段持久化。
     * 支持工具调用的 Agent Loop。
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
        } = options;

        // 1. 获得模型配置
        const model = await this.resolveModel(modelId, providerId);

        // 2. 创建 Provider 实例
        const provider = this.createProviderInstance(
            model.provider_type as ProviderType,
            model.api_endpoint,
            model.api_key
        );

        // 3. 构建请求消息
        const messages = await buildRequestMessages({
            prompt,
            sessionId,
            attachments,
        });

        // 4. 初始化持久化管理器
        const persister = new Persister({
            prompt,
            model,
            sessionId: sessionId ?? null,
            buildSessionTitle,
        });

        // 5. 异步记录请求开始（不阻塞主流程）
        const requestStartRecordPromise = persister.recordRequestStart().catch((error) => {
            console.error('[AiServiceManager] Failed to record request start:', error);
        });

        try {
            // 6. 从设置中获取最大迭代次数
            const maxIterationsStr = await getSettingValue({ key: SettingKey.MCP_MAX_ITERATIONS });
            const maxIterations = maxIterationsStr ? parseInt(maxIterationsStr, 10) : 10;

            // 7. 如果模型支持工具调用，获取工具列表
            let tools: AiToolDefinition[] | undefined;
            if (model.tool_call === 1) {
                tools = await mcpManager.getEnabledToolDefinitions();
            }

            // 8. Agent 循环
            const startedAt = Date.now();
            let response = '';
            let reasoning = '';
            let iteration = 0;

            while (iteration < maxIterations) {
                if (signal?.aborted) {
                    throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                }

                // 从 provider 获取流式响应
                const stream = this.stream(
                    provider,
                    model.model_id,
                    messages,
                    tools,
                    signal,
                    model.output_limit ?? undefined
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
                    }

                    if (chunk.content) {
                        chunkResponse += chunk.content;
                        response += chunk.content;
                    }

                    onChunk?.(chunk);

                    if (chunk.done) {
                        finishReason = chunk.finishReason;
                        toolCalls = chunk.toolCalls;
                        break;
                    }
                }

                // 检查是否需要继续循环
                const isToolRelated = finishReason === 'tool_calls' || finishReason === 'tool_use';

                if (!isToolRelated || !toolCalls || toolCalls.length === 0) {
                    // 无工具调用，退出循环
                    break;
                }

                // 发送迭代开始事件（仅当工具调用将被执行时）
                onChunk?.({
                    content: '',
                    done: false,
                    toolEvent: { type: 'iteration_start', iteration },
                });

                // 追加带 tool_calls 的助手消息
                messages.push({
                    role: 'assistant',
                    content: chunkResponse,
                    tool_calls: toolCalls,
                });

                // 持久化工具调用消息
                const toolCallMessageId = await persister.persistToolCallMessage(chunkResponse);

                // 执行每个工具调用
                for (const toolCall of toolCalls) {
                    if (signal?.aborted) {
                        throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                    }

                    const callStartTime = Date.now();
                    let toolArgs: Record<string, unknown>;

                    try {
                        toolArgs = JSON.parse(toolCall.arguments);
                    } catch {
                        toolArgs = {};
                    }

                    // 解析工具映射
                    const mapping = await mcpManager.resolveToolCall(toolCall.name);

                    if (!mapping) {
                        console.error(
                            `[AiServiceManager] Failed to resolve tool: ${toolCall.name}`
                        );
                        const errorResult = `Tool not found: ${toolCall.name}`;
                        const durationMs = Date.now() - callStartTime;

                        // 发送调用结束事件（含错误）
                        onChunk?.({
                            content: '',
                            done: false,
                            toolEvent: {
                                type: 'call_end',
                                callId: toolCall.id,
                                result: errorResult,
                                isError: true,
                                durationMs,
                            },
                        });

                        // 追加错误结果消息
                        messages.push({
                            role: 'tool',
                            content: errorResult,
                            tool_call_id: toolCall.id,
                            name: toolCall.name,
                        });

                        await persister.persistToolResultMessage(errorResult, null);

                        continue;
                    }

                    // 发送调用开始事件
                    onChunk?.({
                        content: '',
                        done: false,
                        toolEvent: {
                            type: 'call_start',
                            callId: toolCall.id,
                            toolName: mapping.originalName,
                            namespacedName: toolCall.name,
                            serverId: mapping.serverId,
                            arguments: toolArgs,
                        },
                    });

                    // 记录工具日志开始（await 确保记录存在后再更新）
                    let toolLogId: number | null = null;
                    try {
                        const toolLog = await createMcpToolLog({
                            server_id: mapping.serverId,
                            tool_name: mapping.originalName,
                            tool_call_id: toolCall.id,
                            session_id: persister.getSessionId(),
                            message_id: toolCallMessageId,
                            iteration,
                            input: JSON.stringify(toolArgs),
                            status: 'pending',
                        });
                        toolLogId = toolLog.id;
                    } catch (err) {
                        console.error('[AiServiceManager] Failed to create tool log:', err);
                    }

                    // 执行工具
                    const toolResult = await mcpManager.executeTool(toolCall.name, toolArgs, {
                        signal,
                        iteration,
                        resolved: {
                            serverId: mapping.serverId,
                            originalName: mapping.originalName,
                            toolTimeout: mapping.toolTimeout,
                        },
                    });

                    const durationMs = Date.now() - callStartTime;

                    // 发送调用结束事件
                    onChunk?.({
                        content: '',
                        done: false,
                        toolEvent: {
                            type: 'call_end',
                            callId: toolCall.id,
                            result: toolResult.result,
                            isError: toolResult.isError,
                            durationMs,
                        },
                    });

                    // 用结果更新工具日志
                    updateMcpToolLogByCallId(toolCall.id, {
                        output: toolResult.result,
                        status: toolResult.isError ? 'error' : 'success',
                        duration_ms: durationMs,
                        error_message: toolResult.isError ? toolResult.result : null,
                    }).catch((err) => {
                        console.error('[AiServiceManager] Failed to update tool log:', err);
                    });

                    // 追加工具结果消息
                    messages.push({
                        role: 'tool',
                        content: toolResult.result,
                        tool_call_id: toolCall.id,
                        name: toolCall.name,
                    });

                    // 持久化工具结果消息
                    await persister.persistToolResultMessage(toolResult.result, toolLogId);
                }

                // 发送迭代结束事件
                onChunk?.({
                    content: '',
                    done: false,
                    toolEvent: { type: 'iteration_end', iteration },
                });

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

            await updateModelLastUsed({ id: model.id });

            return {
                model,
                response,
                reasoning,
                request: persister.getRequest(),
            };
        } catch (error) {
            console.warn('[AiServiceManager] Request failed:', error, typeof error);

            const aiError = AiError.fromError(error);

            await requestStartRecordPromise;

            if (aiError.is(AiErrorCode.REQUEST_CANCELLED)) {
                await persister.markCancelled();
                throw aiError;
            }

            await persister.markFailed(aiError.message);
            throw aiError;
        }
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
    const normalized = prompt.trim().replace(/\s+/g, ' ');
    if (!normalized) {
        return '新会话';
    }

    if (normalized.length <= 40) {
        return normalized;
    }

    return `${normalized.slice(0, 40)}...`;
}

// 导出单例
export const aiService = new AiServiceManager();

// 导出错误类和错误码
export { AiError, AiErrorCode } from './errors';

// 导出会话管理函数
export { createSession, getSessionMessages } from './session';
