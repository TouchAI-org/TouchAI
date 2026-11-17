import type { WebSearchResult } from '../helper';
import { nativeSearchOptions, recencyStartDate, searchSource } from './common';
import { createSearchProviderAdapter } from './define';

const XAI_API_ROOT = 'https://api.x.ai';

/** Search runs as a server-side tool of the Responses API. */
export const GROK_SEARCH_MODEL = 'grok-4.7';

/** Each domain filter accepts at most five entries. */
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
    const label = title?.trim();
    // xAI annotations may use a citation number instead of a page title.
    results.push({
        title: label && !/^\d+$/.test(label) ? label : hostnameOf(url),
        url,
        source: 'Grok',
    });
}

/**
 * Grok returns a synthesis and citations rather than a standalone results page.
 * Preserve cited URLs as sources; page text can be fetched separately.
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

        if (
            (item?.type === 'web_search_call' || item?.type === 'x_search_call') &&
            Array.isArray(item.action?.sources)
        ) {
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

        const domains = request.domains.map((domain) => domain.trim()).filter(Boolean);
        if (domains.length > 0 && request.excludeDomains.length > 0) {
            throw new Error(
                'Grok web search cannot combine allowed and excluded domains in one call. Use one filter mode or separate searches.'
            );
        }
        if (
            domains.length > GROK_MAX_FILTER_DOMAINS ||
            request.excludeDomains.length > GROK_MAX_FILTER_DOMAINS
        ) {
            throw new Error(
                'Grok web search supports at most 5 allowed or excluded domains per call. Split the search into several calls.'
            );
        }
        const after = recencyStartDate(request.recencyDays);
        const options = nativeSearchOptions(request, 'grok');
        const body: Record<string, unknown> = {
            model: GROK_SEARCH_MODEL,
            input: buildGrokInput(
                `${request.query}${after ? `\nFind sources published since ${after.slice(0, 10)}.` : ''}${request.language !== 'any' ? `\nPrefer ${request.language === 'zh' ? 'Chinese' : 'English'} sources.` : ''}\nFind up to ${request.maxResults} distinct sources.`
            ),
            instructions:
                'You are a web search backend. Search the web and summarize the most relevant sources briefly.',
            tool_choice: 'required',
            tools: [
                {
                    type: 'web_search',
                    ...(domains.length > 0
                        ? { filters: { allowed_domains: domains } }
                        : request.excludeDomains.length > 0
                          ? {
                                filters: {
                                    excluded_domains: request.excludeDomains,
                                },
                            }
                          : {}),
                },
                ...(searchSource(request) === 'realtime' || searchSource(request) === 'community'
                    ? [{ type: 'x_search', ...(after ? { from_date: after.slice(0, 10) } : {}) }]
                    : []),
            ],
            ...options,
            stream: false,
            background: false,
            store: false,
        };
        if (
            !Array.isArray(body.tools) ||
            body.tools.some(
                (tool: unknown) =>
                    !tool ||
                    typeof tool !== 'object' ||
                    !['web_search', 'x_search'].includes(String((tool as { type?: unknown }).type))
            )
        ) {
            throw new Error('Grok search supports only web_search and x_search tools.');
        }

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

        const parsed = payload as {
            error?: { message?: string };
            status?: string;
            output?: GrokOutputItem[];
        };
        if (parsed.error) throw new Error(parsed.error.message ?? 'Grok search failed.');
        const results = toGrokResults(payload).slice(0, request.maxResults);
        if (request.includeContent && results.length > 0) {
            const summary = (parsed.output ?? [])
                .flatMap((item) =>
                    item.type === 'message' && Array.isArray(item.content)
                        ? (item.content as GrokContent[])
                        : []
                )
                .filter(
                    (content) => content.type === 'output_text' && typeof content.text === 'string'
                )
                .map((content) => content.text)
                .join('\n');
            if (summary)
                results[0] = {
                    ...results[0]!,
                    content: `Grok cited synthesis (not page text):\n${summary}`,
                };
        }
        return results;
    },
});
