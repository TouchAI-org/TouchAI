// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';

import type { AiError } from '../../contracts/errors';
import type { AiRequestOptions, AiResponse, AiStreamChunk } from '../../contracts/protocol';

export interface ModelInfo {
    id: string;
    name: string;
}

export interface ProviderConfigJson {
    headers?: Record<string, string>;
    queryParams?: Record<string, string>;
}

export interface ProviderApiTargets {
    normalizedBaseUrl: string;
    sdkBaseUrl: string;
    generationTarget: string;
    discoveryTarget: string;
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
