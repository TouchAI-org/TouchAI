// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 行内引用的来源注入通道。
 *
 * `markstream-vue` 的自定义 `link` 节点拿不到当前消息的搜索来源，
 * 因此由上层 provide 一份查找表，链接节点按 URL 反查。
 */

import type { InjectionKey } from 'vue';

import type { WebSearchSource } from '@/services/BuiltInToolService/tools/webSearch/sources';

export interface WebSearchCitationRegistry {
    findByUrl(url: string): WebSearchSource | undefined;
    indexOf(source: WebSearchSource): number | undefined;
}

export const WEB_SEARCH_CITATIONS_KEY: InjectionKey<WebSearchCitationRegistry> =
    Symbol('web-search-citations');

/**
 * 忽略协议、`www.`、尾斜杠与 hash。
 *
 * 模型复述链接时经常丢 `https://` 或多带一个 `/`，严格比较会让一半引用匹配不上。
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

/** 页内锚点、相对链接、邮件链接不参与替换。 */
export function isExternalHttpUrl(raw: string): boolean {
    return /^https?:|^\/\//i.test(raw.trim());
}

const WRAPPED_CITATION = /[（(]\[([^\]]+)\]\(([^)\s]+)\)[）)]([。！？；，、：…]?)/g;

/**
 * 去掉包裹引用的括号，把句读提到前面：`（[标题](url)）。` → `。[标题](url)`。
 *
 * `isCitationUrl` 限定范围，避免改动正文里的普通括号引用。
 */
export function normalizeWrappedCitations(
    content: string,
    isCitationUrl: (url: string) => boolean
): string {
    if (!content.includes('（[') && !content.includes('([')) {
        return content;
    }

    return content.replace(
        WRAPPED_CITATION,
        (match, text: string, url: string, punctuation: string) =>
            isCitationUrl(normalizeCitationUrl(url)) ? `${punctuation}[${text}](${url})` : match
    );
}
