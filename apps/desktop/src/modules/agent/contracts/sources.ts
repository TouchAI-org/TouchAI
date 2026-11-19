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
