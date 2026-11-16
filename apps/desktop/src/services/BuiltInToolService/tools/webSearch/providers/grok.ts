import type { WebSearchResult } from '../helper';
import { createSearchProviderAdapter } from './define';

const XAI_API_ROOT = 'https://api.x.ai';

/** xAI 没有独立的搜索端点，web_search 只能作为 Responses API 的服务端工具运行。 */
export const GROK_SEARCH_MODEL = 'grok-4.7';

/** `allowed_domains` / `excluded_domains` 单次最多 5 个。 */
const GROK_MAX_FILTER_DOMAINS = 5;

export function buildGrokResponsesUrl(endpoint: string | null | undefined): URL {
    const trimmed = (endpoint ?? '').trim().replace(/\/+$/, '');
    const root = trimmed || XAI_API_ROOT;
    return new URL(`${root}${/\/v1$/i.test(root) ? '' : '/v1'}/responses`);
}

export function buildGrokInput(query: string): Array<{ role: 'user'; content: string }> {
    return [
        {
            role: 'user',
            content: `Search the web for: ${query}\nReply with a short factual brief. Cite every claim.`,
        },
    ];
}

interface GrokAnnotation {
    type?: unknown;
    url?: unknown;
    title?: unknown;
}

interface GrokContent {
    type?: unknown;
    text?: unknown;
    annotations?: unknown;
}

interface GrokOutputItem {
    type?: unknown;
    content?: unknown;
    action?: { sources?: unknown };
}

interface GrokPayload {
    output?: unknown;
    citations?: unknown;
}

function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return url;
    }
}

function pushResult(
    results: WebSearchResult[],
    seen: Set<string>,
    url: string,
    title: string | undefined
): void {
    if (!/^https?:\/\//i.test(url) || seen.has(url)) {
        return;
    }
    seen.add(url);
    results.push({ title: title || hostnameOf(url), url, source: 'Grok' });
}

/**
 * Grok 的搜索结果是“答案 + 引用”，没有独立的 SERP。
 * 这里按可信度依次读取 `url_citation` 注解、顶层 `citations` 和 `web_search_call.action.sources`，
 * 只保留 URL 与标题，正文交给 web_fetch。
 */
export function toGrokResults(payload: unknown): WebSearchResult[] {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return [];
    }

    const parsed = payload as GrokPayload;
    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    const output = Array.isArray(parsed.output) ? parsed.output : [];

    for (const item of output as GrokOutputItem[]) {
        if (item?.type === 'message' && Array.isArray(item.content)) {
            for (const content of item.content as GrokContent[]) {
                if (content?.type !== 'output_text' || !Array.isArray(content.annotations)) {
                    continue;
                }
                for (const annotation of content.annotations as GrokAnnotation[]) {
                    if (annotation?.type !== 'url_citation' || typeof annotation.url !== 'string') {
                        continue;
                    }
                    pushResult(
                        results,
                        seen,
                        annotation.url,
                        typeof annotation.title === 'string' ? annotation.title : undefined
                    );
                }
            }
        }

        if (item?.type === 'web_search_call' && Array.isArray(item.action?.sources)) {
            for (const source of item.action.sources as Array<{ url?: unknown }>) {
                if (typeof source?.url === 'string') {
                    pushResult(results, seen, source.url, undefined);
                }
            }
        }
    }

    if (Array.isArray(parsed.citations)) {
        for (const citation of parsed.citations) {
            if (typeof citation === 'string') {
                pushResult(results, seen, citation, undefined);
            }
        }
    }

    return results;
}

export const grokAdapter = createSearchProviderAdapter({
    id: 'grok',
    async search({ request, settings, signal, fetchJson }) {
        const apiKey = settings.providers.grok.apiKey.trim();
        if (!apiKey) {
            throw new Error('Grok search needs an xAI API key. Enter one in Search settings.');
        }

        const domains = request.domains
            .map((domain) => domain.trim())
            .filter(Boolean)
            .slice(0, GROK_MAX_FILTER_DOMAINS);
        const body: Record<string, unknown> = {
            model: GROK_SEARCH_MODEL,
            input: buildGrokInput(request.query),
            instructions:
                'You are a web search backend. Search the web and summarize the most relevant sources briefly.',
            tools: [
                {
                    type: 'web_search',
                    ...(domains.length > 0 ? { filters: { allowed_domains: domains } } : {}),
                },
            ],
            max_output_tokens: 1_200,
            store: false,
        };

        const payload = await fetchJson(
            buildGrokResponsesUrl(settings.providers.grok.endpoint),
            signal,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            }
        );

        return toGrokResults(payload).slice(0, request.maxResults);
    },
});
