// Copyright (c) 2025. 千诚. Licensed under GPL v3

import {
    findDefaultModelWithProvider,
    findMessagesBySessionId,
    findModelByProviderAndModelId,
    findModelsWithProvider,
    updateModelLastUsed,
} from '@database/queries';
import type { ModelWithProviderAndMetadata } from '@database/queries/models';
import type { ProviderType } from '@database/schema';
import {
    type Index,
    isAttachmentSupported,
    readAttachmentAsBase64,
    readAttachmentAsText,
} from '@services/AiService/attachments';

import { AnthropicProvider } from './providers/anthropic';
import { OpenAiProvider } from './providers/openai';
import type {
    AiContentPart,
    AiMessage,
    AiProvider,
    AiProviderConfig,
    AiResponse,
    AiStreamChunk,
} from './types';

interface ProviderAdapter {
    type: ProviderType;
    normalizeEndpoint: (endpoint: string) => string;
    create: (config: AiProviderConfig) => AiProvider;
}

interface BuildMessagesOptions {
    prompt: string;
    history: Array<Pick<AiMessage, 'role'> & { content: string }>;
    attachments?: Index[];
}

const trimTrailingSlash = (endpoint: string) => endpoint.replace(/\/+$/, '');

const ensureSuffix = (endpoint: string, suffix: string) =>
    endpoint.endsWith(suffix) ? endpoint : `${endpoint}${suffix}`;

const providerRegistry = new Map<ProviderType, ProviderAdapter>();

function registerProvider(adapter: ProviderAdapter): void {
    providerRegistry.set(adapter.type, adapter);
}

registerProvider({
    type: 'openai',
    normalizeEndpoint: (endpoint) => ensureSuffix(trimTrailingSlash(endpoint), '/v1'),
    create: (config) => new OpenAiProvider(config),
});

registerProvider({
    type: 'anthropic',
    normalizeEndpoint: (endpoint) => trimTrailingSlash(endpoint),
    create: (config) => new AnthropicProvider(config),
});

function getProviderAdapter(type: ProviderType): ProviderAdapter {
    const adapter = providerRegistry.get(type);
    if (!adapter) {
        throw new Error(`Unknown provider type: ${type}`);
    }
    return adapter;
}

function normalizeProviderEndpoint(type: ProviderType, endpoint: string): string {
    return getProviderAdapter(type).normalizeEndpoint(endpoint);
}

function createProviderFromRegistry(type: ProviderType, config: AiProviderConfig): AiProvider {
    return getProviderAdapter(type).create(config);
}

async function buildAttachmentParts(attachments: Index[]): Promise<AiContentPart[]> {
    const parts: AiContentPart[] = [];
    const usableAttachments = attachments.filter((attachment) => isAttachmentSupported(attachment));

    for (const attachment of usableAttachments) {
        try {
            if (attachment.type === 'image') {
                const { data, mimeType } = await readAttachmentAsBase64(attachment);
                parts.push({ type: 'image', mimeType, data });
            } else {
                const { content, isBinary } = await readAttachmentAsText(attachment);
                parts.push({
                    type: 'file',
                    name: attachment.name,
                    content,
                    isBinary,
                });
            }
        } catch (error) {
            console.error('[AiServiceManager] Failed to read attachment:', error);
        }
    }

    return parts;
}

async function buildUnifiedMessages(options: BuildMessagesOptions): Promise<AiMessage[]> {
    const { prompt, history, attachments = [] } = options;
    const messages: AiMessage[] = history.map((msg) => ({
        role: msg.role,
        content: msg.content,
    }));

    const attachmentParts = await buildAttachmentParts(attachments);
    const userContent =
        attachmentParts.length > 0
            ? ([{ type: 'text', text: prompt }, ...attachmentParts] as AiContentPart[])
            : prompt;

    messages.push({ role: 'user', content: userContent });
    return messages;
}

/**
 * 模型与服务商信息的联合类型
 */
export type ModelWithProvider = ModelWithProviderAndMetadata;

/**
 * AI 服务管理器
 * 管理 AI 提供商并将请求路由到适当的提供商
 */
export class AiServiceManager {
    // 按服务商 ID 缓存提供商实例
    private providers = new Map<number, AiProvider>();

    /**
     * 获取全局默认模型（包含服务商信息）
     */
    async getActiveModel(): Promise<ModelWithProvider | null> {
        const defaultModel = await findDefaultModelWithProvider();

        if (!defaultModel) {
            console.warn('[AiServiceManager] No default model found or provider disabled');
            return null;
        }

        return defaultModel as ModelWithProvider;
    }

    /**
     * 根据 provider_id 和 model_id 获取模型（包含服务商信息）
     */
    async getModelByProviderAndModelId(
        providerId: number,
        modelId: string
    ): Promise<ModelWithProvider | null> {
        const model = await findModelByProviderAndModelId(providerId, modelId);

        if (!model) {
            console.error(
                `[AiServiceManager] Model "${modelId}" from provider ${providerId} not found`
            );
            return null;
        }

        // 检查服务商是否启用
        if (model.provider_enabled === 0) {
            console.error(`[AiServiceManager] Provider for model "${modelId}" is disabled`);
            return null;
        }

        return model as ModelWithProvider;
    }

    /**
     * 创建服务商的提供商实例（公共方法）
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
     * 清除指定服务商的缓存实例
     */
    clearProviderCache(providerId?: number): void {
        if (providerId !== undefined) {
            this.providers.delete(providerId);
        } else {
            this.providers.clear();
        }
    }

    /**
     * 发送 AI 请求
     */
    async request(
        prompt: string,
        sessionId?: number,
        modelIdOverride?: string,
        providerIdOverride?: number,
        attachments: Index[] = []
    ): Promise<AiResponse> {
        const model = await this.resolveModel(modelIdOverride, providerIdOverride);
        const provider = this.getProviderForModel(model);
        const messages = await this.buildRequestMessages(prompt, sessionId, attachments);

        const response = await provider.request({
            model: model.model_id,
            messages,
        });

        await updateModelLastUsed(model.id);
        return response;
    }

    /**
     * 流式 AI 响应
     */
    async *stream(
        prompt: string,
        sessionId?: number,
        modelIdOverride?: string,
        providerIdOverride?: number,
        attachments: Index[] = []
    ): AsyncGenerator<{ chunk: AiStreamChunk; model: ModelWithProvider }, void, unknown> {
        const model = await this.resolveModel(modelIdOverride, providerIdOverride);
        const provider = this.getProviderForModel(model);
        const messages = await this.buildRequestMessages(prompt, sessionId, attachments);

        for await (const chunk of provider.stream({
            model: model.model_id,
            messages,
        })) {
            yield { chunk, model };
        }

        await updateModelLastUsed(model.id);
    }

    /**
     * 测试模型连接
     */
    async testModel(modelId: number): Promise<boolean> {
        const models = await findModelsWithProvider();
        const model = models.find((m) => m.id === modelId);

        if (!model) {
            throw new Error(`Model with id ${modelId} not found`);
        }

        const provider = this.getProviderForModel(model);
        return provider.testConnection();
    }

    private async resolveModel(
        modelIdOverride?: string,
        providerIdOverride?: number
    ): Promise<ModelWithProvider> {
        if (modelIdOverride && providerIdOverride) {
            const model = await this.getModelByProviderAndModelId(
                providerIdOverride,
                modelIdOverride
            );
            if (!model) {
                throw new Error(
                    `Model "${modelIdOverride}" from provider ${providerIdOverride} not found or disabled`
                );
            }
            return model;
        }

        const activeModel = await this.getActiveModel();
        if (!activeModel) {
            throw new Error('No active AI model configured');
        }

        return activeModel;
    }

    private getProviderForModel(model: ModelWithProvider): AiProvider {
        return this.getProvider(
            model.provider_id,
            model.provider_type as ProviderType,
            model.api_endpoint,
            model.api_key
        );
    }

    private getProvider(
        providerId: number,
        providerType: ProviderType,
        apiEndpoint: string,
        apiKey?: string | null
    ): AiProvider {
        const cached = this.providers.get(providerId);
        if (cached) {
            return cached;
        }

        const provider = this.createProviderInstance(providerType, apiEndpoint, apiKey);
        this.providers.set(providerId, provider);
        return provider;
    }

    private async buildRequestMessages(
        prompt: string,
        sessionId?: number,
        attachments: Index[] = []
    ): Promise<AiMessage[]> {
        const history = sessionId ? await findMessagesBySessionId(sessionId) : [];
        return buildUnifiedMessages({
            prompt,
            history,
            attachments,
        });
    }
}

// 导出单例
export const aiService = new AiServiceManager();
