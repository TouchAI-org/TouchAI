// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 搜索来源的结构化载荷。
 *
 * 工具结果文本是给模型看的；来源卡片和行内引用需要**结构化**数据，
 * 因此把结果数组额外序列化进 `attachments`，由前端解析后渲染。
 * 这样既不污染模型可见的文本，也不必改动 attachment 表结构。
 */

/** 前端可直接消费的搜索来源。 */
export interface WebSearchSource {
    /** 会话内稳定标识，用于行内引用 `[n]` 与卡片一一对应。 */
    id: string;
    /** 在结果列表中的序号，从 1 开始。 */
    index: number;
    title: string;
    url: string;
    snippet?: string;
    /** 展示用站点名（优先 DeepSeek `site_name`，否则回退到 hostname）。 */
    siteName?: string;
    favicon?: string;
    publishedAt?: string;
    score?: number;
    authority?: number;
}

/** 搜索工具产出的结构化来源载荷。 */
export interface WebSearchSourcesPayload {
    query: string;
    provider: string;
    status: 'searching' | 'done';
    sources: WebSearchSource[];
}

/** attachment 中标记来源载荷的稳定 identifier 前缀。 */
export const WEB_SEARCH_SOURCES_ATTACHMENT_PREFIX = 'web-search-sources:';

/** 把来源载荷序列化为 attachment identifier。 */
export function serializeWebSearchSources(payload: WebSearchSourcesPayload): string {
    return `${WEB_SEARCH_SOURCES_ATTACHMENT_PREFIX}${JSON.stringify(payload)}`;
}

/**
 * 从 attachment identifier 还原来源载荷。
 *
 * 解析失败返回 `null`，调用方应当静默忽略——来源卡片是增强展示，
 * 不该因为一次序列化异常让整条消息渲染失败。
 */
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

/** 站点名的展示形式：去掉 `www.`，多级域名取主域。 */
export function webSearchHostname(url: string): string {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

/** 把 hostname 收敛成人类习惯的站点名，例如 `developer.mozilla.org` → `mozilla`。 */
export function webSearchSiteName(url: string): string {
    const parts = webSearchHostname(url).split('.');
    return (parts.length > 1 ? parts[parts.length - 2] : parts[0]) ?? webSearchHostname(url);
}
