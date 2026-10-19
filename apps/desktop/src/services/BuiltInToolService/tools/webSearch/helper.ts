import { truncateText } from '@/utils/text';

import { parseToolArguments } from '../../utils/toolSchema';
import {
    DEFAULT_WEB_SEARCH_MAX_RESULTS,
    DEFAULT_WEB_SEARCH_TIMEOUT_MS,
    WEB_SEARCH_TOOL_ID,
    webSearchArgsSchema,
    type WebSearchIntent,
    type WebSearchProvider,
} from './constants';

export interface WebSearchRequest {
    query: string;
    provider: WebSearchProvider;
    intent: WebSearchIntent;
    domains: string[];
    recencyDays?: number;
    maxResults: number;
    timeoutMs: number;
    description?: string;
    /** 请求把正文一并返回（目前仅 DeepSeek 支持），可省掉一次 web_fetch 往返。 */
    includeContent?: boolean;
}

export interface WebSearchResult {
    title: string;
    url: string;
    snippet?: string;
    source: string;
    /** 相关性分数（DeepSeek `rerank_score`，0–3）。 */
    score?: number;
    /** 权威分层（DeepSeek `authority`，0–4，≥3 为高权威）。 */
    authority?: number;
    /** 发布时间，RFC 3339（DeepSeek `date`）。 */
    publishedAt?: string;
    /** 站点图标（DeepSeek `site_icon`）。 */
    favicon?: string;
    /** 正文 Markdown（DeepSeek `need_content=true`）。 */
    content?: string;
}

export function parseWebSearchRequest(args: Record<string, unknown>): WebSearchRequest {
    const parsed = parseToolArguments(WEB_SEARCH_TOOL_ID, webSearchArgsSchema, args);
    return {
        query: parsed.query,
        provider: parsed.provider ?? 'auto',
        intent: parsed.intent ?? 'general',
        domains: parsed.domains ?? [],
        recencyDays: parsed.recencyDays,
        maxResults: parsed.maxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS,
        timeoutMs: parsed.timeoutMs ?? DEFAULT_WEB_SEARCH_TIMEOUT_MS,
        description: parsed.description,
        includeContent: parsed.includeContent,
    };
}

export function createSearchSignal(
    upstreamSignal: AbortSignal | undefined,
    timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
    const controller = new AbortController();
    const onAbort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) {
        onAbort();
    } else if (upstreamSignal) {
        upstreamSignal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = globalThis.setTimeout(() => {
        controller.abort(
            new DOMException(`WebSearch timed out after ${timeoutMs}ms`, 'TimeoutError')
        );
    }, timeoutMs);

    return {
        signal: controller.signal,
        cleanup: () => {
            globalThis.clearTimeout(timer);
            upstreamSignal?.removeEventListener('abort', onAbort);
        },
    };
}

/** 单条结果最多内联多少正文字符，防止 need_content 把上下文挤爆。 */
export const WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS = 8_000;

/** 一次搜索结果里所有内联正文的总字符预算。 */
export const WEB_SEARCH_EMBEDDED_CONTENT_TOTAL_CHARS = 30_000;

function truncateEmbeddedContent(
    content: string,
    budget: number
): { content: string; truncated: boolean } {
    if (content.length <= budget) {
        return { content, truncated: false };
    }
    return { content: truncateText(content, Math.max(budget, 1)), truncated: true };
}

function formatResultQualitySignals(result: WebSearchResult): string | null {
    const signals: string[] = [];
    if (result.score !== undefined) {
        signals.push(`Score: ${result.score}`);
    }
    if (result.authority !== undefined) {
        signals.push(`Authority: ${result.authority}`);
    }
    return signals.length > 0 ? signals.join(' · ') : null;
}

function appendResultLines(
    lines: string[],
    result: WebSearchResult,
    contentBudget: { remaining: number }
): void {
    lines.push(`   URL: ${result.url}`);
    lines.push(`   Source: ${result.source}`);
    if (result.publishedAt) {
        lines.push(`   Published: ${result.publishedAt}`);
    }
    const signals = formatResultQualitySignals(result);
    if (signals) {
        lines.push(`   ${signals}`);
    }
    if (result.snippet) {
        lines.push(`   Snippet: ${result.snippet}`);
    }
    if (result.content && contentBudget.remaining > 0) {
        const truncated = truncateEmbeddedContent(
            result.content,
            Math.min(WEB_SEARCH_EMBEDDED_CONTENT_MAX_CHARS, contentBudget.remaining)
        );
        contentBudget.remaining -= truncated.content.length;
        lines.push(`   Content${truncated.truncated ? ' (truncated)' : ''}: ${truncated.content}`);
    }
}

export function formatWebSearchResults(
    request: WebSearchRequest,
    results: WebSearchResult[]
): string {
    const lines = [
        'Web search',
        `Query: ${request.query}`,
        `Intent: ${request.intent}`,
        `Results: ${results.length}`,
        '',
    ];

    if (results.length === 0) {
        lines.push(
            'No candidate sources found. Try a broader query or use browser if the target site is known but search is blocked.'
        );
        return lines.join('\n');
    }

    const contentBudget = { remaining: WEB_SEARCH_EMBEDDED_CONTENT_TOTAL_CHARS };
    results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.title}`);
        appendResultLines(lines, result, contentBudget);
    });

    lines.push('');
    lines.push(
        'Use web_fetch to read a selected URL. Use browser when the page requires rendering, interaction, login state, or access is blocked.'
    );
    return lines.join('\n');
}

export function decodeOpenAlexAbstract(value: unknown): string | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }

    const words: Array<{ word: string; index: number }> = [];
    for (const [word, positions] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(positions)) {
            continue;
        }
        for (const position of positions) {
            if (typeof position === 'number') {
                words.push({ word, index: position });
            }
        }
    }

    return (
        words
            .sort((left, right) => left.index - right.index)
            .map((entry) => entry.word)
            .join(' ')
            .trim() || undefined
    );
}
