import { beforeEach, describe, expect, it, vi } from 'vitest';

import { builtInTools, executeWebSearchTool, webSearchTool } from '@/services/BuiltInToolService/tools/webSearch';

const { getSettingValueMock, tauriFetchMock } = vi.hoisted(() => ({
    getSettingValueMock: vi.fn<() => Promise<string | null>>(async () => null),
    tauriFetchMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    getSettingValue: getSettingValueMock,
}));

vi.mock('@/services/AgentService/infrastructure/providers', () => ({
    createTauriFetch: () => tauriFetchMock,
}));

function createExecutionContext(): Parameters<typeof executeWebSearchTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'web-search-call',
        iteration: 1,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}

describe('WebSearch tool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getSettingValueMock.mockResolvedValue(null);
    });

    it('exports one consolidated search tool without provider-specific tools', () => {
        expect(builtInTools.map((tool) => tool.id)).toEqual(['web_search']);
        expect(webSearchTool.inputSchema.properties).toHaveProperty('provider');
        expect(webSearchTool.inputSchema.properties.provider).toMatchObject({
            enum: [
                'auto',
                'anysearch',
                'brave',
                'tavily',
                'exa',
                'firecrawl',
                'wikipedia',
                'openalex',
                'semantic_scholar',
                'github',
                'searxng',
            ],
        });
    });

    it('builds the provider list from enabled runtime settings', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                providers: {
                    brave: { enabled: true, apiKey: 'brave-key' },
                    tavily: { enabled: true, apiKey: '' },
                    exa: { enabled: true, apiKey: 'exa-key' },
                    firecrawl: { enabled: false, apiKey: 'firecrawl-key' },
                },
            })
        );

        const definition = await webSearchTool.buildToolDefinition('builtin__web_search');
        const providerSchema = definition.input_schema.properties.provider as { enum: string[] };
        expect(definition.input_schema.properties.provider).toMatchObject({
            enum: expect.arrayContaining(['auto', 'brave', 'exa', 'wikipedia', 'github']),
        });
        expect(providerSchema.enum).not.toContain('tavily');
        expect(providerSchema.enum).not.toContain('firecrawl');
        expect(definition.description).toContain('brave: Fresh broad web/news discovery');
        expect(definition.description).toContain('exa: Semantic web discovery');
    });

    it('builds concise initial presentation text', () => {
        const args = {
            query: 'OpenClaw latest updates',
            description: '搜索 OpenClaw 项目信息',
        };

        expect(webSearchTool.buildConversationSemantic(args)).toEqual({
            action: 'search',
            target: 'OpenClaw 项目信息',
        });
    });

    it('routes academic searches to OpenAlex by default', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    results: [
                        {
                            display_name: 'Agentic web research systems',
                            id: 'https://openalex.org/W123',
                            publication_year: 2026,
                            primary_location: {
                                landing_page_url: 'https://example.edu/paper',
                            },
                            abstract_inverted_index: {
                                Agentic: [0],
                                systems: [3],
                            },
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'agentic web research', intent: 'academic', maxResults: 3 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: OpenAlex');
        expect(result.result).toContain('Agentic web research systems');
        expect(result.result).toContain('https://example.edu/paper');
        expect(tauriFetchMock).toHaveBeenCalledWith(
            expect.stringContaining('https://api.openalex.org/works?'),
            expect.anything()
        );
    });

    it('routes technical searches to GitHub repositories', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    items: [
                        {
                            full_name: 'TouchAI/browser-router',
                            html_url: 'https://github.com/TouchAI/browser-router',
                            description: 'Browser routing examples',
                            stargazers_count: 42,
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'browser router', intent: 'technical', maxResults: 2 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: GitHub');
        expect(result.result).toContain('TouchAI/browser-router');
        expect(result.result).toContain('Stars: 42');
        expect(result.conversationSemantic).toEqual({
            action: 'search',
            target: 'browser router · GitHub',
        });
    });

    it('lets the model explicitly choose GitHub without relying on intent routing', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    items: [
                        {
                            full_name: 'openclaw/openclaw',
                            html_url: 'https://github.com/openclaw/openclaw',
                            description: 'OpenClaw repository',
                            stargazers_count: 128,
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            {
                query: 'OpenClaw latest releases',
                provider: 'github',
                description: '搜索 OpenClaw 最新动态',
            },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: GitHub');
        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toContain(
            'https://api.github.com/search/repositories?'
        );
        expect(result.conversationSemantic).toEqual({
            action: 'search',
            target: 'OpenClaw 最新动态 · GitHub',
        });
    });

    it('uses AnySearch for general zero-config discovery by default', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    data: {
                        results: [
                            {
                                title: 'TouchAI browser control',
                                url: 'https://example.com/browser-automation',
                                snippet: 'Desktop AI browser automation',
                            },
                        ],
                    },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'browser automation', maxResults: 2 },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: AnySearch');
        expect(result.result).toContain('TouchAI browser control');
        expect(result.result).toContain('https://example.com/browser-automation');
        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toBe(
            'https://api.anysearch.com/v1/search'
        );
    });

    it('keeps the searched provider in presentation when no results are returned', async () => {
        tauriFetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ data: { results: [] } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );

        const result = await executeWebSearchTool(
            {
                query: 'OpenClaw 2026 latest progress',
                description: '搜索 OpenClaw 2026年的最新进展',
            },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Results: 0');
        expect(result.conversationSemantic).toEqual({
            action: 'search',
            target: 'OpenClaw 2026年的最新进展 · AnySearch',
        });
    });

    it('uses search settings defaults when call arguments omit routing options', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                defaultProvider: 'github',
                maxResults: 4,
                timeoutMs: 25000,
                intentRoutes: {
                    general: 'github',
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    items: [
                        {
                            full_name: 'TouchAI/search-router',
                            html_url: 'https://github.com/TouchAI/search-router',
                            description: 'Search routing examples',
                            stargazers_count: 9,
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'search router' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: GitHub');
        expect(tauriFetchMock).toHaveBeenCalledWith(
            expect.stringContaining('https://api.github.com/search/repositories?'),
            expect.anything()
        );
        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toContain('per_page=4');
    });

    it('routes general searches to AnySearch when selected', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                defaultProvider: 'anysearch',
                providers: {
                    anysearch: { enabled: true, apiKey: 'any-key' },
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    code: 0,
                    message: 'success',
                    data: {
                        results: [
                            {
                                title: 'AnySearch result',
                                url: 'https://example.com/any',
                                snippet: 'Aggregated source',
                            },
                        ],
                    },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'agent search' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: AnySearch');
        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://api.anysearch.com/v1/search',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('agent search'),
            })
        );
        expect(JSON.parse(String(tauriFetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
            query: 'agent search',
            max_results: 6,
        });
        expect(JSON.parse(String(tauriFetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty(
            'limit'
        );
    });

    it('uses Brave when the model selects an enabled Brave provider', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                providers: {
                    brave: { enabled: true, apiKey: 'brave-key' },
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    web: {
                        results: [
                            {
                                title: 'Brave result',
                                url: 'https://example.com/brave',
                                description: 'Fresh result',
                            },
                        ],
                    },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'OpenClaw news', provider: 'brave', intent: 'news' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: Brave');
        expect(tauriFetchMock).toHaveBeenCalledWith(
            expect.stringContaining('https://api.search.brave.com/res/v1/web/search?'),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'X-Subscription-Token': 'brave-key',
                }),
            })
        );
    });

    it('uses Tavily when the model selects an enabled Tavily provider', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                providers: {
                    tavily: { enabled: true, apiKey: 'tavily-key' },
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    results: [
                        {
                            title: 'Tavily result',
                            url: 'https://example.com/tavily',
                            content: 'Research result',
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'OpenClaw latest updates', provider: 'tavily' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: Tavily');
        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://api.tavily.com/search',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('OpenClaw latest updates'),
            })
        );
    });

    it('uses Exa when the model selects an enabled Exa provider', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                providers: {
                    exa: { enabled: true, apiKey: 'exa-key' },
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    results: [
                        {
                            title: 'Exa result',
                            url: 'https://example.com/exa',
                            text: 'Semantic result',
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'OpenClaw project', provider: 'exa' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: Exa');
        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://api.exa.ai/search',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('OpenClaw project'),
            })
        );
    });

    it('uses Firecrawl when the model selects an enabled Firecrawl provider', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                providers: {
                    firecrawl: { enabled: true, apiKey: 'firecrawl-key' },
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            title: 'Firecrawl result',
                            url: 'https://example.com/firecrawl',
                            description: 'Crawl-oriented result',
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'OpenClaw official updates', provider: 'firecrawl' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: Firecrawl');
        expect(tauriFetchMock).toHaveBeenCalledWith(
            'https://api.firecrawl.dev/v2/search',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('OpenClaw official updates'),
            })
        );
    });

    it('routes academic searches to Semantic Scholar when configured', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                intentRoutes: {
                    academic: 'semantic_scholar',
                },
                providers: {
                    semantic_scholar: { enabled: true, apiKey: 'semantic-key' },
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            title: 'Semantic paper',
                            url: 'https://www.semanticscholar.org/paper/123',
                            year: 2026,
                            abstract: 'Paper abstract',
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'semantic search papers', intent: 'academic' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: Semantic Scholar');
        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toContain(
            'https://api.semanticscholar.org/graph/v1/paper/search?'
        );
    });

    it('routes searches to a configured SearXNG instance', async () => {
        getSettingValueMock.mockResolvedValueOnce(
            JSON.stringify({
                defaultProvider: 'searxng',
                providers: {
                    searxng: {
                        enabled: true,
                        endpoint: 'https://search.example.com',
                    },
                },
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    results: [
                        {
                            title: 'SearXNG result',
                            url: 'https://example.com/searxng',
                            content: 'Metasearch source',
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            )
        );

        const result = await executeWebSearchTool(
            { query: 'self hosted search' },
            {},
            createExecutionContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Source: SearXNG');
        expect(String(tauriFetchMock.mock.calls[0]?.[0])).toContain(
            'https://search.example.com/search?'
        );
    });
});
