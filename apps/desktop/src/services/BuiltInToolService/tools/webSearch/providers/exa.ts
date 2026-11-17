import type { WebSearchRequest, WebSearchResult } from '../helper';
import {
    nativeSearchOptions,
    preserveSearchExtras,
    queryWithDomains,
    readResultItems,
    recencyStartDate,
    resultFromGenericItem,
    resultLimit,
    searchSource,
} from './common';
import { createSearchProviderAdapter } from './define';
import type { WebSearchFetchText } from './types';

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
/** Exa 的公开 MCP 端点，支持匿名调用（无 key）。 */
const EXA_MCP_URL = 'https://mcp.exa.ai/mcp';

interface ExaMcpContentBlock {
    type?: string;
    text?: string;
}

/** 从 SSE 流里取出第一条 `data:` 负载并解析为 JSON。 */
function parseSsePayload(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        /* SSE is the usual MCP transport. */
    }
    for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) {
            continue;
        }
        const payload = line.slice('data:'.length).trim();
        if (!payload) {
            continue;
        }
        try {
            return JSON.parse(payload);
        } catch {
            // 单行解析失败时继续看后续 data 行。
        }
    }
    return null;
}

/**
 * MCP 把结果压成一个 `text` 块，条目形如：
 * ```
 * Title: ...
 * URL: ...
 * Published: ...
 * Highlights:
 * ...
 * ```
 */
function parseExaMcpText(text: string): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    for (const block of text.split(/\n(?=Title:)/)) {
        const url = /^URL:\s*(\S+)$/m.exec(block)?.[1]?.trim();
        if (!url) {
            continue;
        }
        const title = /^Title:\s*(.+)$/m.exec(block)?.[1]?.trim();
        const published = /^Published:\s*(.+)$/m.exec(block)?.[1]?.trim();
        const highlights = block
            .split(/^Highlights:$/m)[1]
            ?.split('\n')
            .map((line) => line.trim())
            .filter((line) => line && !line.startsWith('...'))
            .join(' ');

        results.push({
            title: title || url,
            url,
            ...(highlights ? { snippet: highlights } : {}),
            content: block.split(/^(?:Text|Content):\s*$/m)[1]?.trim(),
            source: 'Exa',
            // 只保留真实日期，过滤 "N/A" 之类占位符。
            ...(published && /^\d{4}-\d{2}-\d{2}/.test(published)
                ? { publishedAt: published }
                : {}),
        });
    }
    return results;
}

async function searchExaMcp(
    request: WebSearchRequest,
    signal: AbortSignal,
    fetchText: WebSearchFetchText
): Promise<WebSearchResult[]> {
    const raw = await fetchText(new URL(EXA_MCP_URL), signal, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            // 该端点强制要求 SSE，只发 application/json 会得到 406。
            Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: {
                name: 'web_search_exa',
                arguments: {
                    query: queryWithDomains(request),
                    numResults: resultLimit(request, 100),
                    ...nativeSearchOptions(request, 'exa'),
                },
            },
        }),
    });

    const payload = parseSsePayload(raw) as {
        error?: { message?: string };
        result?: { content?: ExaMcpContentBlock[]; isError?: boolean };
    } | null;
    if (!payload) {
        return [];
    }
    if (payload.error) {
        throw new Error(payload.error.message ?? 'Exa MCP returned an error');
    }

    const text = (payload.result?.content ?? [])
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text as string)
        .join('\n');
    // MCP 把工具级失败（限流、参数校验、上游错误）放在 result.isError 里，
    // 而不是 JSON-RPC 的 error 字段。不单独处理的话，错误文本会被当成结果去解析，
    // 解析不出 URL 就静默返回空列表，用户只会看到「没有结果」。
    if (payload.result?.isError) {
        throw new Error(`Exa MCP error: ${text.slice(0, 300) || 'unknown error'}`);
    }
    return parseExaMcpText(text);
}

export const exaAdapter = createSearchProviderAdapter({
    id: 'exa',
    async search({ request, settings, signal, fetchJson, fetchText }) {
        const apiKey = settings.providers.exa.apiKey.trim();
        // 无 key 时走公开 MCP 匿名额度，有 key 时走正式 API（支持域名/日期/分类过滤）。
        if (!apiKey) {
            const restOnly = Object.keys(nativeSearchOptions(request, 'exa')).filter(
                (key) =>
                    !['query', 'numResults', 'type', 'livecrawl', 'contextMaxCharacters'].includes(
                        key
                    )
            );
            if (
                restOnly.length > 0 ||
                request.recencyDays !== undefined ||
                request.includeContent
            ) {
                throw new Error(
                    'Exa date filters, full content and REST-only options require an API key. Configure it in Search settings or use another provider.'
                );
            }
            return searchExaMcp(request, signal, fetchText);
        }

        const body: Record<string, unknown> = {
            query: request.query,
            type: request.mode === 'deep' ? 'deep' : request.mode === 'fast' ? 'lite' : 'auto',
            numResults: resultLimit(request, 100),
            contents: request.includeContent === true ? { text: true } : { highlights: true },
        };
        if (request.domains.length > 0) {
            body.includeDomains = request.domains;
        }
        if (request.excludeDomains.length > 0) {
            body.excludeDomains = request.excludeDomains;
        }
        const startPublishedDate = recencyStartDate(request.recencyDays);
        if (startPublishedDate) {
            body.startPublishedDate = startPublishedDate.slice(0, 10);
        }
        if (searchSource(request) === 'academic') {
            body.category = 'research paper';
        } else if (searchSource(request) === 'news') {
            body.category = 'news';
        }
        Object.assign(body, nativeSearchOptions(request, 'exa'), { stream: false });

        const payload = await fetchJson(new URL(EXA_SEARCH_URL), signal, {
            method: 'POST',
            headers: {
                'x-api-key': apiKey,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return preserveSearchExtras(
            readResultItems(payload)
                .map((item) => resultFromGenericItem(item, 'Exa'))
                .filter((result): result is WebSearchResult => Boolean(result)),
            payload
        );
    },
});
