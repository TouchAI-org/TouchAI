// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ProviderDriver } from '@database/schema';
import { type FinishReason, type LanguageModel, streamText } from 'ai';

import { safeParseJsonWithSchema, z } from '@/utils/zod';

import { AiError, AiErrorCode } from '../../../contracts/errors';
import type { AiRequestOptions, AiResponse, JsonObject } from '../../../contracts/protocol';
import type {
    AiProvider,
    AiProviderConfig,
    ModelInfo,
    ProviderApiTargets,
    ProviderConfigJson,
} from '../types';
import type { ProviderAttachmentRequestContext } from './attachments';
import { buildModelMessages, buildToolSet } from './messages';
import { createAiSdkStreamProcessor } from './stream';
import { createTauriFetch } from './tauriFetch';

const providerConfigJsonSchema = z.object({
    headers: z.record(z.string(), z.string()).optional(),
    queryParams: z.record(z.string(), z.string()).optional(),
});

/**
 * base URL 只负责移除尾部斜杠，绝不追加供应商路径。
 */
export function normalizeProviderBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

export function parseProviderConfigJson(configJson?: string | null): ProviderConfigJson {
    return safeParseJsonWithSchema(providerConfigJsonSchema, configJson, {});
}

function buildUrlWithQueryParams(target: string, queryParams: Record<string, string>): string {
    if (Object.keys(queryParams).length === 0 || !target) {
        return target;
    }

    const url = new URL(target);
    for (const [key, value] of Object.entries(queryParams)) {
        url.searchParams.set(key, value);
    }

    return url.toString();
}

function normalizeFinishReason(reason: FinishReason | undefined): FinishReason {
    return reason ?? 'stop';
}

// ── Error classification helpers ──

interface ApiCallErrorLike {
    statusCode?: number;
    responseBody?: string;
    data?: unknown;
    message: string;
}

/**
 * 从 AI SDK 的 APICallError / RetryError 中提取结构化错误信息。
 * 使用鸭子类型检测，不依赖 AI SDK 内部类型。
 */
export function extractApiCallError(error: unknown): ApiCallErrorLike | null {
    // 解包 RetryError → lastError
    const target =
        error != null &&
        typeof error === 'object' &&
        'lastError' in error &&
        error.lastError != null &&
        typeof error.lastError === 'object'
            ? (error.lastError as Record<string, unknown>)
            : error;

    if (target == null || typeof target !== 'object') return null;

    const record = target as Record<string, unknown>;
    if ('statusCode' in record || 'responseBody' in record) {
        return {
            statusCode: typeof record.statusCode === 'number' ? record.statusCode : undefined,
            responseBody: typeof record.responseBody === 'string' ? record.responseBody : undefined,
            data: record.data,
            message:
                typeof record.message === 'string' ? record.message : String(record.message ?? ''),
        };
    }

    return null;
}

/**
 * HTTP 状态码 → AiError 通用映射。
 */
export function mapHttpStatusToAiError(
    statusCode: number | undefined,
    message: string
): AiError | null {
    switch (statusCode) {
        case 401:
        case 403:
            return new AiError(AiErrorCode.UNAUTHORIZED, undefined, message);
        case 408:
            return new AiError(AiErrorCode.TIMEOUT, undefined, message);
        case 429:
            return new AiError(AiErrorCode.RATE_LIMIT, undefined, message);
        case 502:
            return new AiError(AiErrorCode.BAD_GATEWAY, undefined, message);
        case 503:
            return new AiError(AiErrorCode.SERVICE_UNAVAILABLE, undefined, message);
        case 504:
            return new AiError(AiErrorCode.GATEWAY_TIMEOUT, undefined, message);
        default:
            if (statusCode && statusCode >= 500)
                return new AiError(AiErrorCode.API_ERROR, undefined, message);
            return null;
    }
}

/**
 * 从 API 响应的结构化 data 中提取人可读的错误消息。
 * 覆盖常见格式：
 * - OpenAI / Alibaba: `{ error: { message } }`
 * - Google: `{ error: { message } }`
 * - Anthropic: `{ error: { message } }`
 * - 顶层: `{ message }`
 */
function extractDetailMessage(data: unknown): string | null {
    if (data == null || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;

    // { error: { message: "..." } }
    if (record.error != null && typeof record.error === 'object') {
        const errorObj = record.error as Record<string, unknown>;
        if (typeof errorObj.message === 'string' && errorObj.message) {
            return errorObj.message;
        }
    }

    // { message: "..." }
    if (typeof record.message === 'string' && record.message) {
        return record.message;
    }

    return null;
}

/**
 * 当 AI SDK 的 errorSchema 解析失败导致 `data` 为空时，
 * 尝试手动从 responseBody JSON 字符串恢复结构化数据。
 */
function recoverDataFromResponseBody(apiError: ApiCallErrorLike): unknown {
    if (apiError.data != null) return apiError.data;
    if (!apiError.responseBody) return null;

    try {
        return JSON.parse(apiError.responseBody);
    } catch {
        return null;
    }
}

/**
 * 从结构化 data 中识别跨 provider 通用的错误码。
 * 覆盖常见的 OpenAI-compatible 格式，代理网关也经常返回此格式。
 * 只做错误码分类，始终保留 API 返回的原始消息。
 */
function classifyCommonErrorData(data: unknown): AiError | null {
    if (data == null || typeof data !== 'object') return null;
    const record = data as Record<string, unknown>;
    const error =
        record.error != null && typeof record.error === 'object'
            ? (record.error as Record<string, unknown>)
            : null;
    if (!error) return null;

    const code = typeof error.code === 'string' ? error.code : undefined;
    const type = typeof error.type === 'string' ? error.type : undefined;
    const message = typeof error.message === 'string' ? error.message : undefined;

    // API Key 无效
    if (code === 'invalid_api_key' || code === 'InvalidApiKey') {
        return new AiError(AiErrorCode.INVALID_API_KEY, undefined, message);
    }

    // 配额不足
    if (type === 'insufficient_quota') {
        return new AiError(AiErrorCode.RATE_LIMIT, undefined, message);
    }

    return null;
}

/**
 * Vercel AI SDK provider 适配层基类。
 *
 * 公共职责只保留在这里：base URL 规范化、Tauri fetch、headers/query params、
 * 目标 API 预览，以及统一的 listModels / testConnection / stream 包装。
 */
export abstract class AiSdkProviderBase implements AiProvider {
    readonly normalizedBaseUrl: string;
    protected readonly apiKey?: string;
    protected readonly config: ProviderConfigJson;
    protected readonly fetch: typeof fetch;

    abstract readonly name: string;
    abstract readonly driver: ProviderDriver;

    constructor(config: AiProviderConfig) {
        this.normalizedBaseUrl = normalizeProviderBaseUrl(config.apiEndpoint);
        this.apiKey = config.apiKey?.trim() || undefined;
        this.config = config.config ?? {};
        this.fetch = this.createProviderFetch();
    }

    async request(options: AiRequestOptions): Promise<AiResponse> {
        let content = '';
        let finishReason: string | undefined;

        for await (const chunk of this.stream(options)) {
            content += chunk.content;
            if (chunk.done) {
                finishReason = chunk.finishReason;
            }
        }

        return {
            content,
            finishReason,
        };
    }

    async *stream(options: AiRequestOptions) {
        const processor = createAiSdkStreamProcessor();
        const attachmentContext: ProviderAttachmentRequestContext = {
            driver: this.driver,
            providerId: options.providerId,
            modelId: options.model,
            apiTargets: this.getApiTargets(),
            apiKey: this.apiKey,
            customHeaders: this.getCustomHeaders(),
            fetch: this.fetch,
        };
        const { messages, manifestRequest } = await buildModelMessages({
            messages: options.messages,
            providerDriver: this.driver,
            providerId: options.providerId,
            modelId: options.model,
            attachmentContext,
            attachmentRequestIndex: options.attachmentRequestIndex,
        });
        await options.onAttachmentManifestResolved?.(manifestRequest);
        const result = streamText({
            model: this.createLanguageModel(options.model),
            messages,
            tools: buildToolSet(options.tools),
            abortSignal: options.signal,
            maxOutputTokens: options.maxTokens,
            providerOptions: this.getStreamProviderOptions(options),
            includeRawChunks: this.shouldIncludeRawChunks(),
            // 禁用 AI SDK 内部重试，由应用层 runtime 统一管理重试与 UI 反馈
            maxRetries: 0,
        });

        for await (const part of result.fullStream) {
            if (part.type === 'finish') {
                yield processor.buildFinishChunk(normalizeFinishReason(part.finishReason));
                return;
            }

            for (const chunk of processor.consumePart(part)) {
                yield chunk;
            }
        }

        yield processor.buildFinishChunk('stop');
    }

    async listModels(): Promise<ModelInfo[]> {
        const { discoveryTarget } = this.getApiTargets();
        if (!discoveryTarget) {
            throw new Error('Provider base URL is empty');
        }

        const response = await this.fetch(discoveryTarget, {
            method: 'GET',
            headers: this.getDiscoveryHeaders(),
        });
        const payload = await this.readJsonResponse(response);
        return this.parseModelList(payload);
    }

    async testConnection(): Promise<boolean> {
        try {
            await this.listModels();
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 从 AI SDK 抛出的错误中提取结构化信息并分类为 AiError。
     * 子类通过 override classifyApiCallError 处理 provider 特有的错误码。
     */
    classifyError(error: unknown): AiError | null {
        const apiError = extractApiCallError(error);
        if (!apiError) return null;

        // AI SDK 的 errorSchema 可能解析失败导致 data 为空，从 responseBody 恢复
        const effectiveData = recoverDataFromResponseBody(apiError);

        // 用结构化 data 分类 provider 特有的错误码
        const classified = this.classifyApiCallError(apiError.statusCode, effectiveData);
        if (classified) return classified;

        // 通用错误码识别
        const common = classifyCommonErrorData(effectiveData);
        if (common) return common;

        // 使用响应体中的详细消息
        const detailMessage = extractDetailMessage(effectiveData) ?? apiError.message;

        // 兜底：HTTP 状态码映射
        return mapHttpStatusToAiError(apiError.statusCode, detailMessage);
    }

    /**
     * 子类 override 此方法以处理 provider 特有的错误码。
     * 返回 null 表示未识别，交给基类 HTTP 状态码映射。
     */
    protected classifyApiCallError(statusCode: number | undefined, data: unknown): AiError | null {
        void statusCode;
        void data;
        return null;
    }

    protected createProviderFetch(): typeof fetch {
        const tauriFetch = createTauriFetch();
        const queryParams = this.config.queryParams ?? {};

        return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const rawUrl =
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.toString()
                      : input.url;
            const requestUrl = buildUrlWithQueryParams(rawUrl, queryParams);
            return tauriFetch(requestUrl, init);
        }) as typeof fetch;
    }

    protected async readJsonResponse(response: Response): Promise<unknown> {
        if (!response.ok) {
            const message = await response.text();
            throw new Error(`HTTP ${response.status}: ${message || response.statusText}`);
        }

        return response.json();
    }

    protected getCustomHeaders(): Record<string, string> {
        return {
            ...(this.config.headers ?? {}),
        };
    }

    /**
     * 允许 provider 在单次请求级别注入 AI SDK providerOptions。
     */
    protected getStreamProviderOptions(
        options: AiRequestOptions
    ): Record<string, JsonObject> | undefined {
        void options;
        return undefined;
    }

    /**
     * 仅在需要 provider 原始 chunk 做协议修补时开启 raw chunks，避免其余 provider 产生额外流噪音。
     */
    protected shouldIncludeRawChunks(): boolean {
        return false;
    }

    protected abstract createLanguageModel(modelId: string): LanguageModel;
    protected abstract getDiscoveryHeaders(): Record<string, string>;
    protected abstract parseModelList(payload: unknown): ModelInfo[];
    abstract getApiTargets(): ProviderApiTargets;
}
