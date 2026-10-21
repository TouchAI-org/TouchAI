import type {
    SearchProviderConfig,
    SearchProviderId,
    SearchSettingsConfig,
} from '@/stores/setting/sections/search';

import type { WebSearchRequest, WebSearchResult } from '../helper';

/**
 * 搜索 provider 在收到非 2xx 响应时抛出的错误。
 *
 * 保留状态码，让适配器可以按官方语义区分「可重试」（408 / 429 / 5xx）
 * 与「不可重试」（400 / 401 / 402 / 403 / 404 / 413）。
 */
export class WebSearchHttpError extends Error {
    readonly status: number;

    /** 服务端 `Retry-After` 解析出的等待毫秒数；不可解析时为 `undefined`。 */
    readonly retryAfterMs?: number;

    constructor(status: number, statusText: string, options: { retryAfterMs?: number } = {}) {
        super(`HTTP ${status} ${statusText}`.trim());
        this.name = 'WebSearchHttpError';
        this.status = status;
        this.retryAfterMs = options.retryAfterMs;
    }
}

export type WebSearchFetchJson = (
    url: URL,
    signal: AbortSignal,
    init?: {
        method?: 'GET' | 'POST';
        headers?: Record<string, string>;
        body?: string;
    }
) => Promise<unknown>;

/**
 * 按文本读取响应。
 *
 * 少数免费端点只提供 SSE 流（如 Exa 的公开 MCP 端点，显式要求
 * `Accept: text/event-stream`，否则返回 406），无法走 `fetchJson`。
 */
export type WebSearchFetchText = (
    url: URL,
    signal: AbortSignal,
    init?: {
        method?: 'GET' | 'POST';
        headers?: Record<string, string>;
        body?: string;
    }
) => Promise<string>;

export interface WebSearchProviderAdapter {
    id: SearchProviderId;
    isConfigured(config: SearchProviderConfig): boolean;
    search(params: {
        request: WebSearchRequest;
        settings: SearchSettingsConfig;
        signal: AbortSignal;
        fetchJson: WebSearchFetchJson;
        fetchText: WebSearchFetchText;
    }): Promise<WebSearchResult[]>;
}
