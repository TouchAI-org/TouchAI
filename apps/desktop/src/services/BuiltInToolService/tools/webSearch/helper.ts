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
}

export interface WebSearchResult {
    title: string;
    url: string;
    snippet?: string;
    source: string;
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

    results.forEach((result, index) => {
        lines.push(`${index + 1}. ${result.title}`);
        lines.push(`   URL: ${result.url}`);
        lines.push(`   Source: ${result.source}`);
        if (result.snippet) {
            lines.push(`   Snippet: ${result.snippet}`);
        }
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
