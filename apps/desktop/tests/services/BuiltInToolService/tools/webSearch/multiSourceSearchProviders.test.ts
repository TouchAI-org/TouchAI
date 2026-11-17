import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeWebSearchTool } from '@/services/BuiltInToolService/tools/webSearch';
import type { WebSearchRequest } from '@/services/BuiltInToolService/tools/webSearch/helper';
import {
    buildGrokInput,
    buildGrokResponsesUrl,
    toGrokResults,
} from '@/services/BuiltInToolService/tools/webSearch/providers/grok';
import {
    buildKeenableQuery,
    buildKeenableSearchUrl,
    KEENABLE_APP_TITLE,
    toKeenableResult,
} from '@/services/BuiltInToolService/tools/webSearch/providers/keenable';
import {
    buildYuanbaoFreshness,
    buildYuanbaoSearchUrl,
    readYuanbaoPages,
} from '@/services/BuiltInToolService/tools/webSearch/providers/yuanbao';
import {
    buildZhihuFilter,
    buildZhihuSearchUrl,
    readZhihuItems,
    stripZhihuHighlight,
    toZhihuResult,
} from '@/services/BuiltInToolService/tools/webSearch/providers/zhihu';

const { readEffectiveSettingValueMock, tauriFetchMock } = vi.hoisted(() => ({
    readEffectiveSettingValueMock: vi.fn<() => Promise<string | null>>(async () => null),
    tauriFetchMock: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService/settingsReader', () => ({
    readEffectiveSettingValue: readEffectiveSettingValueMock,
}));

vi.mock('@/services/HttpService', () => ({
    createTauriFetch: () => tauriFetchMock,
    cancelResponseBody: vi.fn(async () => {}),
}));

function createExecutionContext(): Parameters<typeof executeWebSearchTool>[2] {
    return { signal: new AbortController().signal, callId: 'search', iteration: 1 };
}

function baseRequest(overrides: Partial<WebSearchRequest> = {}): WebSearchRequest {
    return {
        query: 'agent search',
        provider: 'auto',
        intent: 'general',
        language: 'any',
        mode: 'balanced',
        domains: [],
        excludeDomains: [],
        maxResults: 6,
        timeoutMs: 15_000,
        ...overrides,
    };
}

function jsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function settingsOf(config: Record<string, unknown>): string {
    return JSON.stringify(config);
}

describe('user searches with Keenable', () => {
    it('user gets the keyless public path and an app identifier when no key is set', () => {
        const url = buildKeenableSearchUrl(undefined, false);

        expect(url.toString()).toBe('https://api.keenable.ai/v1/search/public');
        expect(KEENABLE_APP_TITLE).toBe('TouchAI');
    });

    it('user gets the keyed path when an API key is configured', () => {
        expect(buildKeenableSearchUrl('https://proxy.local/', true).toString()).toBe(
            'https://proxy.local/v1/search'
        );
    });

    it('user sees several domains folded into site operators and one domain kept for the site filter', () => {
        expect(buildKeenableQuery(baseRequest({ domains: ['a.com', 'b.com'] }))).toBe(
            'agent search (site:a.com OR site:b.com)'
        );
        expect(buildKeenableQuery(baseRequest({ domains: ['a.com'] }))).toBe('agent search');
    });

    it('user sees results mapped with publish dates and drops non-http urls', () => {
        expect(
            toKeenableResult({
                title: 'Search infra',
                url: 'https://example.com/post',
                snippet: 'Clean snippet',
                published_at: '2026-10-30T00:00:00Z',
            })
        ).toMatchObject({ source: 'Keenable', publishedAt: '2026-10-30T00:00:00Z' });
        expect(toKeenableResult({ title: 'bad', url: 'javascript:alert(1)' })).toBeNull();
    });

    it('user gets keyless results through the whole tool path', async () => {
        readEffectiveSettingValueMock.mockResolvedValue(
            settingsOf({ defaultProvider: 'keenable', providers: { keenable: { enabled: true } } })
        );
        tauriFetchMock.mockResolvedValue(
            jsonResponse({
                results: [{ title: 'A', url: 'https://a.com', snippet: 's' }],
            })
        );

        const result = await executeWebSearchTool({ query: 'a' }, {}, createExecutionContext());

        expect(result.structuredPayload).toMatchObject({ provider: 'keenable' });
        const headers = tauriFetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(headers['X-Keenable-Title']).toBe(KEENABLE_APP_TITLE);
        expect(headers.Authorization).toBeUndefined();
    });
});

describe('user searches with Zhihu', () => {
    it('user gets the global endpoint with a time filter when a recency window is set', () => {
        const { url, siteOnly } = buildZhihuSearchUrl(
            baseRequest({ domains: ['example.com'], recencyDays: 7 }),
            undefined
        );

        expect(siteOnly).toBe(false);
        expect(url.pathname).toBe('/api/v1/content/global_search');
        expect(url.searchParams.get('SearchDB')).toBe('all');
        expect(url.searchParams.get('Filter')).toContain('host=="example.com"');
        expect(url.searchParams.get('Filter')).toMatch(/publish_time>=\d+/);
        expect(url.searchParams.get('Count')).toBe('6');
    });

    it('user gets the site search when the only domain is zhihu.com', () => {
        const { url, siteOnly } = buildZhihuSearchUrl(
            baseRequest({ domains: ['www.zhihu.com'] }),
            undefined
        );

        expect(siteOnly).toBe(true);
        expect(url.pathname).toBe('/api/v1/content/zhihu_search');
        expect(url.searchParams.get('Filter')).toBeNull();
    });

    it('user gets host filters joined with OR and no filter without conditions', () => {
        expect(buildZhihuFilter(baseRequest({ domains: ['a.com', 'b.com'] }))).toBe(
            'host=="a.com" OR host=="b.com"'
        );
        expect(buildZhihuFilter(baseRequest())).toBeUndefined();
    });

    it('user sees highlights stripped and authority mapped', () => {
        expect(stripZhihuHighlight('A <em>RAG</em> guide&nbsp;here')).toBe('A RAG guide here');
        expect(
            toZhihuResult({
                Title: 'Question',
                Url: 'https://www.zhihu.com/answer/1',
                ContentText: 'Answer',
                AuthorityLevel: '3',
                RankingScore: 0.9,
                EditTime: 1_700_000_000,
            })
        ).toMatchObject({ source: 'Zhihu', authority: 3, score: 0.9 });
    });

    it('user is told when Zhihu answers with an error code instead of silently getting nothing', () => {
        expect(() => readZhihuItems({ Code: 20001, Message: 'auth failed' })).toThrow(
            /auth failed/
        );
    });

    it('user sees the Access Secret sent as a bearer token with a timestamp', async () => {
        readEffectiveSettingValueMock.mockResolvedValue(
            settingsOf({
                defaultProvider: 'zhihu',
                providers: { zhihu: { enabled: true, apiKey: 'secret' } },
            })
        );
        tauriFetchMock.mockResolvedValue(
            jsonResponse({ Code: 0, Data: { Items: [{ Title: 'T', Url: 'https://zhihu.com/1' }] } })
        );

        const result = await executeWebSearchTool({ query: 'q' }, {}, createExecutionContext());

        const headers = tauriFetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer secret');
        expect(Number(headers['X-Request-Timestamp'])).toBeGreaterThan(1_600_000_000);
        expect(result.structuredPayload).toMatchObject({ provider: 'zhihu' });
    });
});

describe('user searches with Yuanbao', () => {
    it('user gets the SearchPro path and a freshness value the API accepts', () => {
        expect(buildYuanbaoSearchUrl(undefined).toString()).toBe(
            'https://api.wsa.cloud.tencent.com/SearchPro'
        );
        expect(buildYuanbaoFreshness(3)).toBe('d3');
        expect(buildYuanbaoFreshness(61)).toBe('m3');
        expect(buildYuanbaoFreshness(800)).toBe('y3');
        expect(buildYuanbaoFreshness(undefined)).toBeUndefined();
    });

    it('user sees JSON-in-string pages mapped with site, authority and favicon', () => {
        const results = readYuanbaoPages({
            Response: {
                Pages: [
                    JSON.stringify({
                        title: '三星堆',
                        url: 'https://news.qq.com/a',
                        site: '腾讯新闻',
                        passage: '摘要',
                        content: '<strong>正文</strong>',
                        date: '2026-10-01 10:00:00',
                        score: 0.9,
                        authority_level: 4,
                        favicon: 'https://news.qq.com/favicon.ico',
                    }),
                ],
            },
        });

        expect(results[0]).toMatchObject({
            title: '三星堆',
            source: '腾讯新闻',
            authority: 4,
            favicon: 'https://news.qq.com/favicon.ico',
        });
    });

    it('user is told when the Yuanbao response carries an error', () => {
        expect(() =>
            readYuanbaoPages({ Response: { Error: { Code: 'AuthFailure', Message: 'bad key' } } })
        ).toThrow(/bad key/);
    });

    it('user sees the service API key sent as a bearer token', async () => {
        readEffectiveSettingValueMock.mockResolvedValue(
            settingsOf({
                defaultProvider: 'yuanbao',
                providers: { yuanbao: { enabled: true, apiKey: 'sk-test' } },
            })
        );
        tauriFetchMock.mockResolvedValue(
            jsonResponse({ Response: { Pages: ['{"title":"T","url":"https://qq.com/a"}'] } })
        );

        const result = await executeWebSearchTool(
            { query: 'q', intent: 'news' },
            {},
            createExecutionContext()
        );

        const [url, init] = tauriFetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/SearchPro');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
        expect(JSON.parse(String(init.body))).toMatchObject({ Industry: 'news', Mode: 2 });
        expect(result.structuredPayload).toMatchObject({ provider: 'yuanbao' });
    });
});

describe('user searches with Grok', () => {
    it('user gets the responses endpoint with the web_search tool', () => {
        expect(buildGrokResponsesUrl(undefined).toString()).toBe('https://api.x.ai/v1/responses');
        expect(buildGrokResponsesUrl('https://api.x.ai/v1').toString()).toBe(
            'https://api.x.ai/v1/responses'
        );
        expect(buildGrokInput('q')[0]?.content).toContain('q');
    });

    it('user sees citation annotations and search sources deduplicated', () => {
        const results = toGrokResults({
            output: [
                {
                    type: 'message',
                    content: [
                        {
                            type: 'output_text',
                            text: 'answer',
                            annotations: [
                                {
                                    type: 'url_citation',
                                    url: 'https://a.com/x',
                                    title: 'A title',
                                },
                            ],
                        },
                    ],
                },
                {
                    type: 'web_search_call',
                    action: { sources: [{ url: 'https://a.com/x' }, { url: 'https://b.com/y' }] },
                },
            ],
            citations: ['https://b.com/y', 'https://c.com/z'],
        });

        expect(results.map((result) => result.url)).toEqual([
            'https://a.com/x',
            'https://b.com/y',
            'https://c.com/z',
        ]);
        expect(results[0]).toMatchObject({ title: 'A title' });
    });

    it('user sees the source domain when Grok returns a numbered citation label', () => {
        const results = toGrokResults({
            output: [
                {
                    type: 'message',
                    content: [
                        {
                            type: 'output_text',
                            annotations: [
                                { type: 'url_citation', url: 'https://docs.x.ai/a', title: '1' },
                                { type: 'url_citation', url: 'https://x.com/b', title: ' 2 ' },
                                {
                                    type: 'url_citation',
                                    url: 'https://example.com/c',
                                    title: 'Page title',
                                },
                            ],
                        },
                    ],
                },
            ],
        });

        expect(results.map((result) => result.title)).toEqual(['docs.x.ai', 'x.com', 'Page title']);
    });

    it('user sees the xAI key used and only url citations returned as sources', async () => {
        readEffectiveSettingValueMock.mockResolvedValue(
            settingsOf({
                defaultProvider: 'grok',
                providers: { grok: { enabled: true, apiKey: 'xai-key' } },
            })
        );
        tauriFetchMock.mockResolvedValue(
            jsonResponse({
                output: [
                    {
                        type: 'message',
                        content: [
                            {
                                type: 'output_text',
                                annotations: [
                                    {
                                        type: 'url_citation',
                                        url: 'https://example.com/a',
                                        title: 'Example',
                                    },
                                ],
                            },
                        ],
                    },
                ],
            })
        );

        const result = await executeWebSearchTool({ query: 'q' }, {}, createExecutionContext());

        const [url, init] = tauriFetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toContain('/v1/responses');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xai-key');
        expect(JSON.parse(String(init.body))).toMatchObject({
            tool_choice: 'required',
            tools: [{ type: 'web_search' }],
            stream: false,
            store: false,
        });
        expect(result.structuredPayload).toMatchObject({ provider: 'grok' });
    });
});

beforeEach(() => {
    vi.clearAllMocks();
    readEffectiveSettingValueMock.mockResolvedValue(null);
});
