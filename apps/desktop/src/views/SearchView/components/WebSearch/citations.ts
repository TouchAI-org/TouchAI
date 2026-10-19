// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 行内搜索引用在 Markdown 渲染树里的来源注入通道。
 *
 * `markstream-vue` 的自定义 `link` 节点拿不到"当前这条消息有哪些搜索来源"，
 * 因此由上层（AssistantMessage）`provide` 一份查找表，
 * 链接节点在渲染时按 URL 反查，命中才渲染成引用 chip。
 */

import type { InjectionKey } from 'vue';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';

export interface WebSearchCitationRegistry {
    /** 按归一化后的 URL 查找来源。 */
    findByUrl(url: string): WebSearchSource | undefined;
    /** 是否为该来源分配了稳定的行内序号。 */
    indexOf(source: WebSearchSource): number | undefined;
}

export const WEB_SEARCH_CITATIONS_KEY: InjectionKey<WebSearchCitationRegistry> =
    Symbol('web-search-citations');

/**
 * URL 归一化：忽略协议、`www.`、尾斜杠与 hash。
 *
 * 模型复述链接时经常丢掉 `https://` 或多带一个 `/`，
 * 严格字符串比较会让一半的引用匹配不上。
 */
export function normalizeCitationUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) {
        return '';
    }

    try {
        const url = new URL(trimmed.startsWith('//') ? `https:${trimmed}` : trimmed);
        const host = url.hostname.replace(/^www\./, '').toLowerCase();
        const path = url.pathname.replace(/\/+$/, '');
        return `${host}${path}${url.search}`.toLowerCase();
    } catch {
        return trimmed.toLowerCase();
    }
}

/**
 * 判断一个链接是否应当被渲染成搜索引用。
 *
 * 只有「外部 http(s) 链接」且命中本次搜索来源时才替换；
 * 页内锚点、相对链接、邮件链接保持原样。
 */
export function isExternalHttpUrl(raw: string): boolean {
    return /^https?:|^\/\//i.test(raw.trim());
}

/**
 * 模型把来源写成括号包裹的 Markdown 链接：
 * `（[标题](url)）。`、`。([标题](url))`、`([标题](url))` 都会出现。
 *
 * 引用 chip 自身已经是完整的视觉标记，再套一层括号显得多余，
 * 而且全角括号会把标记推到句号前面；统一规范成 `。[标题](url)`。
 */
const WRAPPED_CITATION = /[（(]\[([^\]]+)\]\(([^)\s]+)\)[）)]([。！？；，、：…]?)/g;

/**
 * 去掉包裹在搜索引用外面的括号，并把句读提到前面。
 *
 * `isCitationUrl` 决定哪些链接算搜索引用 —— 普通括号引用（比如
 * 正文里的「（见 [文档](url)）」）不能被改动。
 */
export function normalizeWrappedCitations(
    content: string,
    isCitationUrl: (url: string) => boolean
): string {
    // 半角与全角括号都要处理，模型两种都会写。
    if (!content.includes('（[') && !content.includes('([')) {
        return content;
    }

    return content.replace(
        WRAPPED_CITATION,
        (match, text: string, url: string, punctuation: string) =>
            isCitationUrl(normalizeCitationUrl(url)) ? `${punctuation}[${text}](${url})` : match
    );
}
