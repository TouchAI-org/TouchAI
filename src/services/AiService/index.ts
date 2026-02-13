// Copyright (c) 2026. 千诚. Licensed under GPL v3

import {
    findDefaultModelWithProvider,
    findModelByProviderAndModelId,
    updateModelLastUsed,
} from '@database/queries';
import type { ModelWithProvider } from '@database/queries/models';
import type { ProviderType } from '@database/schema';
import type { AiRequestEntity } from '@database/types';
import type { Index } from '@services/AiService/attachments';

import { AiError, AiErrorCode } from './errors';
import { buildRequestMessages } from './messages';
import { Persister } from './persister';
import { createProviderFromRegistry, normalizeProviderEndpoint } from './provider';
import type { AiMessage, AiProvider, AiStreamChunk } from './types';

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
        signal?: AbortSignal
    ): AsyncGenerator<AiStreamChunk, void, unknown> {
        for await (const chunk of provider.stream({
            model: modelId,
            messages,
            signal,
        })) {
            yield chunk;
        }
    }

    /**
     * 执行AI请求流程：模型解析、流消费、分阶段持久化。
     */
    async executeRequest(options: ExecuteRequestOptions): Promise<ExecuteRequestResult> {
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
            // 6. 创建流式响应
            const stream = this.stream(provider, model.model_id, messages, signal);

            // 7. 消费流式响应
            const startedAt = Date.now();
            let response = '';
            let reasoning = '';

            for await (const chunk of stream) {
                if (signal?.aborted) {
                    throw new AiError(AiErrorCode.REQUEST_CANCELLED);
                }

                if (chunk.reasoning) {
                    reasoning += chunk.reasoning;
                }

                if (chunk.content) {
                    response += chunk.content;
                }

                onChunk?.(chunk);

                if (chunk.done) {
                    break;
                }
            }

            if (signal?.aborted) {
                throw new AiError(AiErrorCode.REQUEST_CANCELLED);
            }

            if (!response.trim() && !reasoning.trim()) {
                throw new AiError(AiErrorCode.EMPTY_RESPONSE);
            }

            // 8. 持久化相关状态
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
