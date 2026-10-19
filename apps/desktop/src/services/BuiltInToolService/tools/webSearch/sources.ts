// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 搜索结果的结构化载荷。
 *
 * 工具结果文本是给模型读的；来源卡片与行内引用需要结构化数据，
 * 因此把结果数组单独序列化，避免污染模型可见的文本。
 */

export interface WebSearchSource {
    /** 会话内稳定标识，用于行内引用与卡片一一对应。 */
    id: string;
    index: number;
    title: string;
    url: string;
    snippet?: string;
    /** 展示用站点名，缺失时由 hostname 推导。 */
    siteName?: string;
    favicon?: string;
    publishedAt?: string;
    score?: number;
    authority?: number;
}

export interface WebSearchSourcesPayload {
    query: string;
    provider: string;
    status: 'searching' | 'done';
    sources: WebSearchSource[];
}

export const WEB_SEARCH_SOURCES_ATTACHMENT_PREFIX = 'web-search-sources:';

export function serializeWebSearchSources(payload: WebSearchSourcesPayload): string {
    return `${WEB_SEARCH_SOURCES_ATTACHMENT_PREFIX}${JSON.stringify(payload)}`;
}

/** 解析失败返回 `null`：来源卡片是增强展示，不该让整条消息渲染失败。 */
export function parseWebSearchSources(identifier: string): WebSearchSourcesPayload | null {
    if (!identifier.startsWith(WEB_SEARCH_SOURCES_ATTACHMENT_PREFIX)) {
        return null;
    }

    try {
        const parsed = JSON.parse(
            identifier.slice(WEB_SEARCH_SOURCES_ATTACHMENT_PREFIX.length)
        ) as WebSearchSourcesPayload;
        if (!parsed || !Array.isArray(parsed.sources)) {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

/** 去掉 `www.`，其余保持原样。 */
export function webSearchHostname(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/** 收敛成人类习惯的站点名，例如 `developer.mozilla.org` → `mozilla`。 */
export function webSearchSiteName(url: string): string {
    const parts = webSearchHostname(url).split('.');
    return (parts.length > 1 ? parts[parts.length - 2] : parts[0]) ?? webSearchHostname(url);
}
