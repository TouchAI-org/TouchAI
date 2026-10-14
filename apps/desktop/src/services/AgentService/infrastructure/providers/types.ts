// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import type { AiError } from '../../contracts/errors';
import type { AiRequestOptions, AiResponse, AiStreamChunk } from '../../contracts/protocol';
import type { AttachmentTransportMode } from '../../contracts/protocol';
import type { ReasoningMode, ReasoningOption, ReasoningProtocol } from '../../contracts/reasoning';

export interface ModelInfo {
    id: string;
    name: string;
    /** 上游 /models 返回的 reasoning 能力（如有）。 */
    reasoningOptions?: ReasoningOption[];
}

export interface ProviderReasoningConfig {
    /** 显式指定协议编码器；缺省时由 driver 推断。 */
    protocol?: ReasoningProtocol;
    /** 无 metadata 时的 fallback 行为，默认 auto。 */
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
