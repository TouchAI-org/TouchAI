import { normalizeOptionalString } from '@/utils/text';

import type { SearchProviderId, SearchSource } from '../configuration';
import type { WebSearchRequest, WebSearchResult } from '../helper';

export function providerEndpointUrl(
    endpoint: string | null | undefined,
    fallback: string,
    path: string
): URL {
    const root = (endpoint ?? '').trim().replace(/\/+$/, '') || fallback;
    return new URL(root.endsWith(path) ? root : `${root}${path}`);
}

export function resultLimit(
    request: WebSearchRequest,
    maximum = request.maxResults > 0 ? request.maxResults : 50
): number {
    if (request.maxResults <= 0) return maximum;
    return Math.max(1, Math.min(maximum, request.maxResults));
}

export function nativeSearchOptions(
    request: WebSearchRequest,
    provider: SearchProviderId
): Record<string, unknown> {
    return request.providerOptions?.[provider] ?? {};
}

export function searchSource(request: WebSearchRequest): SearchSource {
    return request.source ?? (request.intent === 'technical' ? 'code' : request.intent);
}

export function setSearchParams(url: URL, options: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(options)) {
        if (value !== undefined && value !== null) {
            url.searchParams.set(
                key,
                typeof value === 'object' ? JSON.stringify(value) : String(value)
            );
        }
    }
}

export function queryWithDomains(request: WebSearchRequest): string {
    const include = request.domains.map((domain) => `site:${domain}`).join(' OR ');
    const exclude = request.excludeDomains.map((domain) => `-site:${domain}`).join(' ');
    return [request.query, include ? `(${include})` : '', exclude].filter(Boolean).join(' ');
}

export function resultDetails(
    record: Record<string, unknown>,
    fields: readonly string[]
): Record<string, unknown> | undefined {
    const entries = fields
        .filter((key) => record[key] !== undefined && record[key] !== null)
        .map((key) => [key, record[key]]);
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function preserveSearchExtras(
    results: WebSearchResult[],
    payload: unknown
): WebSearchResult[] {
    if (results.length === 0 || !payload || typeof payload !== 'object') return results;
    const extras = resultDetails(payload as Record<string, unknown>, [
        'answer',
        'output',
        'images',
        'follow_up_questions',
        'warning',
    ]);
    if (extras)
        results[0] = {
            ...results[0]!,
            details: { ...results[0]!.details, searchResponse: extras },
        };
    return results;
}

export function readResultItems(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
        return payload;
    }
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const record = payload as Record<string, unknown>;
    for (const key of ['results', 'data', 'items']) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value;
        }
        if (value && typeof value === 'object') {
            const nested = value as Record<string, unknown>;
            for (const nestedKey of ['results', 'items']) {
                const nestedValue = nested[nestedKey];
                if (Array.isArray(nestedValue)) {
                    return nestedValue;
                }
            }
        }
    }
    return [];
}

export function resultFromGenericItem(item: unknown, source: string): WebSearchResult | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const record = item as Record<string, unknown>;
    const title =
        normalizeOptionalString(record.title) ??
        normalizeOptionalString(record.name) ??
        normalizeOptionalString(record.display_name);
    const url =
        normalizeOptionalString(record.url) ??
        normalizeOptionalString(record.link) ??
        normalizeOptionalString(record.href);
    if (!title || !url) {
        return null;
    }
    const snippet =
        normalizeOptionalString(record.snippet) ??
        normalizeOptionalString(record.description) ??
        (Array.isArray(record.highlights)
            ? record.highlights.filter((value) => typeof value === 'string').join('\n') || undefined
            : undefined) ??
        normalizeOptionalString(record.content) ??
        normalizeOptionalString(record.abstract);
    // 部分 provider 会返回真实站点名（如 `site_name` / `hostname`），
    // 有就优先用它；没有则由上层从 URL 推导。
    const siteName =
        normalizeOptionalString(record.site_name) ??
        normalizeOptionalString(record.siteName) ??
        normalizeOptionalString(record.hostname) ??
        normalizeOptionalString(record.domain);
    return {
        title,
        url,
        snippet,
        source: siteName ?? source,
        content:
            normalizeOptionalString(record.raw_content) ??
            normalizeOptionalString(record.markdown) ??
            normalizeOptionalString(record.text),
        publishedAt:
            normalizeOptionalString(record.publishedDate) ??
            normalizeOptionalString(record.published_date) ??
            normalizeOptionalString(record.published_at),
        favicon: normalizeOptionalString(record.favicon),
        score: typeof record.score === 'number' ? record.score : undefined,
        details: resultDetails(record, [
            'author',
            'image',
            'images',
            'links',
            'extras',
            'subpages',
            'summary',
            'category',
        ]),
    };
}

/**
 * 搜索结果摘要里带的 HTML（`<em>` 高亮等）要还原成纯文本。
 *
 * 线性扫描而不是反复执行多字符正则：遇到 `<` 后只向后找一次 `>`，因此
 * `"<a".repeat(100_000)` 这类没有闭合括号的输入不会退化成二次复杂度。
 * 未闭合的标签直接丢弃尾部（含 `<` 的片段都不再进入纯文本），残留尖括号
 * 也一并移除，避免 `<scr<script>ipt>` 重新拼出可执行标记。
 */
export function stripHtmlText(value: string): string {
    let text = '';
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== '<') {
            text += value[index];
            continue;
        }
        let cursor = index + 1;
        if (value[cursor] === '/') cursor += 1;
        if (!/[a-zA-Z]/.test(value[cursor] ?? '')) continue;
        while (cursor < value.length && value[cursor] !== '>') cursor += 1;
        if (cursor >= value.length) break;
        index = cursor;
    }
    return text
        .replace(/[<>]/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function recencyStartDate(recencyDays: number | undefined): string | undefined {
    if (recencyDays === undefined || !Number.isFinite(recencyDays) || recencyDays < 1) {
        return undefined;
    }
    const date = new Date(Date.now() - recencyDays * 24 * 60 * 60 * 1000);
    return date.toISOString();
}
