import { beforeEach, describe, expect, it, vi } from 'vitest';

import { executeWebSearchTool, webSearchTool } from '@/services/BuiltInToolService/tools/webSearch';

const { readSettings, fetchMock } = vi.hoisted(() => ({
    readSettings: vi.fn(),
    fetchMock: vi.fn(),
}));
vi.mock('@/services/BuiltInToolService/settingsReader', () => ({
    readEffectiveSettingValue: readSettings,
}));
vi.mock('@/services/HttpService', () => ({
    createTauriFetch: () => fetchMock,
    cancelResponseBody: vi.fn(),
}));

const context = () => ({
    signal: new AbortController().signal,
    callId: 'capabilities',
    iteration: 1,
});
const response = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
const body = () =>
    JSON.parse(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1]?.body));

beforeEach(() => {
    vi.clearAllMocks();
    readSettings.mockResolvedValue(
        JSON.stringify({
            providers: {
                grok: { enabled: true, apiKey: 'test' },
                exa: { enabled: true, apiKey: 'test' },
                keenable: { enabled: true },
                yuanbao: { enabled: true, apiKey: 'test' },
                zhihu: { enabled: true, apiKey: 'test' },
                github: { enabled: true, apiKey: 'test' },
                brave: { enabled: true, apiKey: 'test' },
            },
        })
    );
});

describe('user requests advanced search capabilities', () => {
    it.each([
        ['web', 20],
        ['news', 50],
        ['images', 200],
        ['videos', 50],
    ])('user can request the documented Brave %s page size of %i', async (searchType, count) => {
        fetchMock.mockResolvedValue(response({ results: [] }));
        await executeWebSearchTool(
            {
                query: 'q',
                provider: 'brave',
                maxResults: 200,
                providerOptions: { brave: { searchType } },
            },
            {},
            context()
        );
        expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('count')).toBe(
            String(count)
        );
    });

    it('user keeps requested AnySearch counts and excluded sites without an application ceiling', async () => {
        fetchMock.mockResolvedValue(response({ results: [] }));
        await executeWebSearchTool(
            {
                query: 'q',
                provider: 'anysearch',
                maxResults: 100,
                excludeDomains: ['example.com'],
                providerOptions: { anysearch: { tag: 'news' } },
            },
            {},
            context()
        );
        expect(body()).toMatchObject({
            query: 'q -site:example.com',
            max_results: 100,
            tag: 'news',
        });
    });

    it('user receives an actionable error for mutually exclusive Grok domain filters', async () => {
        fetchMock.mockResolvedValue(response({ output: [] }));
        const result = await executeWebSearchTool(
            {
                query: 'q',
                provider: 'grok',
                domains: ['example.com'],
                excludeDomains: ['other.com'],
            },
            {},
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('cannot combine');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('user receives an actionable error instead of losing excess Yuanbao exclusions', async () => {
        fetchMock.mockResolvedValue(response({ Response: { Pages: [] } }));
        const result = await executeWebSearchTool(
            {
                query: 'q',
                provider: 'yuanbao',
                excludeDomains: Array.from({ length: 6 }, (_, index) => `s${index}.com`),
            },
            {},
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('at most 5');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('user keeps Keenable structured cards and result metadata when requesting native capabilities', async () => {
        fetchMock.mockResolvedValue(
            response({
                results: [
                    {
                        title: 'Weather card',
                        url: 'https://cards.keenable.ai/w/weather',
                        snippet: '18 degrees',
                        acquired_at: '2026-11-17',
                    },
                ],
            })
        );
        const result = await executeWebSearchTool(
            { query: 'weather', provider: 'keenable' },
            {},
            context()
        );
        expect(result.result).toContain('https://cards.keenable.ai/w/weather');
        expect(result.result).toContain('2026-11-17');
    });

    it('user can request 500 results while each engine keeps its documented page limit', async () => {
        fetchMock.mockResolvedValue(response({ results: [] }));
        await executeWebSearchTool(
            { query: 'papers', provider: 'openalex', maxResults: 500 },
            {},
            context()
        );
        expect(new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get('per-page')).toBe(
            '200'
        );
    });
    it('user receives full Exa text and native options when requesting deep content search', async () => {
        fetchMock.mockResolvedValue(
            response({
                results: [
                    {
                        title: 'Paper',
                        url: 'https://example.com/p',
                        text: 'Full paper',
                        highlights: ['Highlight'],
                        publishedDate: '2026-11-01',
                    },
                ],
            })
        );
        const result = await executeWebSearchTool(
            {
                query: 'papers',
                provider: 'exa',
                source: 'academic',
                mode: 'deep',
                includeContent: true,
                maxResults: 100,
                providerOptions: {
                    exa: { category: 'research paper', contents: { text: true, maxAgeHours: 0 } },
                },
            },
            {},
            context()
        );
        expect(body()).toMatchObject({
            type: 'deep',
            numResults: 100,
            category: 'research paper',
            contents: { text: true, maxAgeHours: 0 },
        });
        expect(result.result).toContain('Content: Full paper');
        expect(result.result).toContain('2026-11-01');
    });

    it('user gets news search and raw content from Tavily when using source instead of intent', async () => {
        fetchMock.mockResolvedValue(
            response({
                results: [
                    {
                        title: 'News',
                        url: 'https://example.com/n',
                        content: 'Snippet',
                        raw_content: 'Article body',
                    },
                ],
            })
        );
        const result = await executeWebSearchTool(
            {
                query: 'news',
                provider: 'tavily',
                source: 'news',
                includeContent: true,
                recencyDays: 7,
            },
            {},
            context()
        );
        expect(body()).toMatchObject({ topic: 'news', days: 7, include_raw_content: true });
        expect(result.result).toContain('Content: Article body');
    });

    it('user gets X search with dates and cited evidence for realtime Grok searches', async () => {
        fetchMock.mockResolvedValue(
            response({
                output: [
                    {
                        type: 'message',
                        content: [
                            {
                                type: 'output_text',
                                text: 'Cited finding',
                                annotations: [
                                    {
                                        type: 'url_citation',
                                        url: 'https://x.com/test/status/1',
                                        title: 'Post',
                                    },
                                ],
                            },
                        ],
                    },
                ],
            })
        );
        const result = await executeWebSearchTool(
            {
                query: 'breaking updates',
                provider: 'grok',
                source: 'realtime',
                recencyDays: 2,
                includeContent: true,
            },
            {},
            context()
        );
        expect(body().tools).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ type: 'x_search', from_date: expect.any(String) }),
            ])
        );
        expect(result.result).toContain('Cited finding');
    });

    it('user gets the government vertical and multiple sites from Yuanbao', async () => {
        fetchMock.mockResolvedValue(response({ Response: { Pages: [] } }));
        await executeWebSearchTool(
            {
                query: 'policy',
                provider: 'yuanbao',
                source: 'official',
                domains: ['gov.cn', 'edu.cn'],
                providerOptions: { yuanbao: { Deeplinks: true } },
            },
            {},
            context()
        );
        expect(body()).toMatchObject({
            Industry: 'gov',
            Query: 'policy (site:gov.cn OR site:edu.cn)',
            Deeplinks: true,
        });
    });

    it('user searches GitHub issues with their token and native paging options', async () => {
        fetchMock.mockResolvedValue(
            response({
                items: [
                    {
                        title: 'Issue title',
                        html_url: 'https://github.com/org/repo/issues/1',
                        body: 'Issue body',
                    },
                ],
            })
        );
        const result = await executeWebSearchTool(
            {
                query: 'repo:org/repo bug',
                provider: 'github',
                providerOptions: { github: { searchType: 'issues', page: 2 } },
            },
            {},
            context()
        );
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/search/issues?');
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('page=2');
        expect(fetchMock.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer test');
        expect(result.result).toContain('Issue title');
    });

    it('user gets the Zhihu index for community questions', async () => {
        fetchMock.mockResolvedValue(response({ Code: 0, Data: { Items: [] } }));
        await executeWebSearchTool(
            { query: 'experience', provider: 'zhihu', source: 'community' },
            {},
            context()
        );
        expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/zhihu_search?');
    });
});

describe('user chooses failure recovery and fusion', () => {
    it('user gets a fallback after a Keenable rate limit without leaking its native options', async () => {
        readSettings.mockResolvedValue(
            JSON.stringify({
                defaultProvider: 'keenable',
                routingStrategy: 'manual',
                fallbackEnabled: true,
                providerPriority: ['keenable', 'tavily'],
                providers: { keenable: { enabled: true } },
            })
        );
        fetchMock.mockImplementation(async (url: string) =>
            url.includes('keenable')
                ? response({}, 429)
                : response({ results: [{ title: 'Recovered', url: 'https://example.com/a' }] })
        );
        const result = await executeWebSearchTool(
            { query: 'q', providerOptions: { keenable: { acquired_after: '7d' } } },
            {},
            context()
        );
        expect(result.isError).toBe(false);
        expect(result.result).toContain('Recovered');
        expect(result.result).toContain('Fallback');
        expect(body()).not.toHaveProperty('acquired_after');
    });

    it('user gets both engines when deep fusion is enabled and keeps an explicit provider single', async () => {
        readSettings.mockResolvedValue(
            JSON.stringify({
                parallelProviders: true,
                parallelProviderCount: 2,
                providerPriority: ['anysearch', 'tavily'],
                routingStrategy: 'manual',
            })
        );
        fetchMock.mockImplementation(async (url: string) =>
            response({
                results: [
                    {
                        title: url.includes('tavily') ? 'Tavily hit' : 'AnySearch hit',
                        url: url.includes('tavily')
                            ? 'https://example.com/t'
                            : 'https://example.com/a',
                    },
                ],
            })
        );
        const result = await executeWebSearchTool({ query: 'q', mode: 'deep' }, {}, context());
        expect(result.result).toContain('Tavily hit');
        expect(result.result).toContain('AnySearch hit');
        const explicit = await executeWebSearchTool(
            { query: 'q', mode: 'deep', provider: 'tavily' },
            {},
            context()
        );
        expect(explicit.result).not.toContain('AnySearch hit');
    });

    it('user sees supported options for every enabled engine in the tool schema', async () => {
        const definition = await webSearchTool.buildToolDefinition('builtin__web_search');
        const providerOptions = definition.input_schema.properties.providerOptions as {
            properties: Record<string, { properties: Record<string, unknown> }>;
            additionalProperties: boolean;
        };
        expect(providerOptions.additionalProperties).toBe(false);
        expect(Object.keys(providerOptions.properties)).toEqual(
            expect.arrayContaining(['anysearch', 'exa', 'tavily', 'brave', 'grok'])
        );
        expect(providerOptions.properties.exa?.properties).toHaveProperty('category');
        expect(providerOptions.properties.brave?.properties).toHaveProperty('searchType');
        expect(definition.description).toContain('enumerated in providerOptions.properties');
    });

    it('user is told when providerOptions names an engine that does not exist', async () => {
        const result = await executeWebSearchTool(
            { query: 'q', providerOptions: { notAnEngine: { page: 2 } } },
            {},
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('Unknown providerOptions key');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('user cancellation stops the search before any fallback request starts', async () => {
        const controller = new AbortController();
        fetchMock.mockImplementation(async () => {
            controller.abort();
            throw new DOMException('Aborted', 'AbortError');
        });
        const result = await executeWebSearchTool(
            { query: 'q' },
            {},
            { ...context(), signal: controller.signal }
        );
        expect(result.isError).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
