// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import type { ModelModalities } from '@/utils/modelSchemas';

import type { AiError } from '../../contracts/errors';
import type { AiRequestOptions, AiResponse, AiStreamChunk } from '../../contracts/protocol';
import type { AttachmentTransportMode } from '../../contracts/protocol';
import type { ReasoningMode, ReasoningOption, ReasoningProtocol } from '../../contracts/reasoning';

/**
 * 上游 `/models` 自己声明的模型能力，领域形状。
 *
 * 列名与 JSON 序列化只发生在持久化边界（`infrastructure/modelMetadata`），
 * provider 与 adapter 不感知模型表结构。
 */
export interface ModelCapabilities {
    contextLimit?: number;
    outputLimit?: number;
    modalities?: ModelModalities;
    /** 上游声明支持附件；声明了文件类输入模态时同样算支持。 */
    attachment?: boolean;
    reasoning?: boolean;
    reasoningOptions?: ReasoningOption[];
    toolCall?: boolean;
}

export interface ModelInfo {
    id: string;
    name: string;
    /** 上游 /models 声明的能力（如有），刷新模型时优先于 models.dev 兜底值。 */
    capabilities?: ModelCapabilities;
}

export interface ProviderReasoningConfig {
    /** 显式指定编码格式；缺省时由 driver 推断。 */
    format?: ReasoningProtocol;
    /** 模型未声明 reasoning 能力时的 fallback 行为，默认 auto。 */
    mode?: ReasoningMode;
}

export interface ProviderConfigJson {
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
    reasoning?: ProviderReasoningConfig;
}

export interface ProviderApiTargets {
    normalizedBaseUrl: string;
    sdkBaseUrl: string;
    generationTarget: string;
    discoveryTarget: string;
}

export type ProviderAttachmentFileRefStrategy = 'none' | 'openai-file-id' | 'url';

export interface ProviderAttachmentCapabilities {
    supportsImageInput: boolean;
    supportsDocumentInput: boolean;
    supportsExternalUrl: boolean;
    supportsProviderFileRef: boolean;
    supportsMediaInToolResults: boolean;
    prefersFileRefForPdf: boolean;
    maxInlineRequestBytes: number;
    fileRefStrategy: ProviderAttachmentFileRefStrategy;
    remoteRefTransportMode: Extract<AttachmentTransportMode, 'provider-file-ref'>;
}

/**
 * 不同模型服务商适配器需要实现的统一接口。
 */
export interface AiProvider {
    name: string;
    driver: ProviderDriver;
    request(options: AiRequestOptions): Promise<AiResponse>;
    stream(options: AiRequestOptions): AsyncGenerator<AiStreamChunk, void, unknown>;
    testConnection(): Promise<boolean>;
    listModels(): Promise<ModelInfo[]>;
    getApiTargets(): ProviderApiTargets;
    classifyError?(error: unknown): AiError | null;
}

export interface AiProviderConfig {
    apiEndpoint: string;
    apiKey?: string;
    config?: ProviderConfigJson | null;
}
