import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createWebFetchTools, createWebSearchTools } from '@/modules/tools';

const { http } = vi.hoisted(() => ({ http: vi.fn() }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: http }));

const scope = { callId: 'review', iteration: 0 };
const messages = { t: (key: string) => key, tt: (text: string) => text };
const pageUrl = 'https://example.test/article';
const source = { title: 'Recovered source', url: pageUrl, content: 'evidence' };
const json = (value: unknown) => Response.json(value);
const nativeError = () =>
    new Response(
        new ReadableStream({
            start(controller) {
                controller.error('error sending request: connection reset by peer');
            },
        })
    );

async function search(settings: Record<string, unknown>, args: Record<string, unknown>) {
    const [descriptor] = createWebSearchTools({
        configuration: { read: async () => JSON.stringify(settings) },
    });
    const tool = await descriptor!.prepareForTurn({});
    return tool.execute({ query: 'fixture', ...args }, {}, scope);
}

function fetchPage(settings: Record<string, unknown>, args: Record<string, unknown> = {}) {
    const [tool] = createWebFetchTools({
        messages,
        configuration: { read: async () => JSON.stringify(settings) },
    });
    return tool!.execute({ url: pageUrl, mode: 'page_text', maxChars: 2000, ...args }, {}, scope);
}

beforeEach(() => http.mockReset());

describe('given native search responses fail while reading their bodies', () => {
    it.each(['anysearch', 'exa'])(
        'user receives fallback evidence after %s body transport fails',
        async (first) => {
            http.mockResolvedValueOnce(nativeError()).mockResolvedValueOnce(
                json({ results: [source] })
            );
            const result = await search(
                {
                    routingStrategy: 'priority',
                    providerPriority: [first, 'tavily'],
                    fallbackEnabled: true,
                },
                {}
            );
            expect(result.isError).toBe(false);
            expect(result.result).toContain('Recovered source');
            expect(result.structuredPayload).toMatchObject({ provider: 'tavily' });
        }
    );

    it('user sees malformed JSON as a provider error without silently switching engines', async () => {
        http.mockResolvedValueOnce(new Response('{broken'));
        const result = await search(
            { routingStrategy: 'priority', providerPriority: ['anysearch', 'tavily'] },
            {}
        );
        expect(result.isError).toBe(true);
        expect(http.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
            'api.anysearch.com',
        ]);
    });

    it('user cancels during body reading and no fallback request starts', async () => {
        const controller = new AbortController();
        http.mockImplementationOnce(
            () =>
                new Response(
                    new ReadableStream({
                        pull(stream) {
                            controller.abort(new DOMException('cancelled by user', 'AbortError'));
                            stream.error('native cancellation');
                        },
                    })
                )
        );
        const [descriptor] = createWebSearchTools({
            configuration: {
                read: async () =>
                    JSON.stringify({
                        routingStrategy: 'priority',
                        providerPriority: ['anysearch', 'tavily'],
                    }),
            },
        });
        const tool = await descriptor!.prepareForTurn({});
        const result = await tool.execute(
            { query: 'fixture' },
            {},
            { ...scope, signal: controller.signal }
        );
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toContain('cancelled by user');
        expect(http.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
            'api.anysearch.com',
        ]);
    });
});

describe('given a prepared search has a newly disabled first choice', () => {
    it.each([true, false])(
        'user can recover only when automatic fallback is %s',
        async (fallbackEnabled) => {
            let disabled = false;
            const [descriptor] = createWebSearchTools({
                configuration: {
                    read: async () =>
                        JSON.stringify({
                            routingStrategy: 'priority',
                            providerPriority: ['anysearch', 'tavily'],
                            fallbackEnabled,
                            providers: { anysearch: { enabled: !disabled } },
                        }),
                },
            });
            const tool = await descriptor!.prepareForTurn({});
            disabled = true;
            http.mockResolvedValueOnce(json({ results: [source] }));
            const result = await tool.execute({ query: 'fixture' }, {}, scope);
            expect(result.isError).toBe(!fallbackEnabled);
            expect(http.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual(
                fallbackEnabled ? ['api.tavily.com'] : []
            );
        }
    );
});

describe('given provider-specific search options and long documents', () => {
    it.each(['issues', 'commits'])(
        'user gets bounded summaries and budgeted full text for GitHub %s',
        async (searchType) => {
            const longText = 'evidence '.repeat(7000);
            http.mockResolvedValueOnce(
                json({
                    items: [
                        {
                            title: 'Issue',
                            sha: 'commit',
                            html_url: pageUrl,
                            body: longText,
                            commit: { message: longText },
                        },
                    ],
                })
            );
            const result = await search(
                {},
                {
                    provider: 'github',
                    includeContent: true,
                    providerOptions: { github: { searchType } },
                }
            );
            expect(result.isError).toBe(false);
            expect(result.result).toContain('evidence');
            expect(result.result.length).toBeLessThan(12000);
            expect(JSON.stringify(result.structuredPayload).length).toBeLessThan(2000);
        }
    );

    it('user combines Doubao native filters with domain restrictions and native field precedence', async () => {
        http.mockResolvedValueOnce(json({ Result: { WebResults: [] } }));
        const result = await search(
            { providers: { doubao: { enabled: true, apiKey: 'fixture-key' } } },
            {
                provider: 'doubao',
                domains: ['original.test'],
                excludeDomains: ['ads.test'],
                providerOptions: { doubao: { Filter: { Sites: 'native.test', AuthInfoLevel: 1 } } },
            }
        );
        expect(result.isError).toBe(false);
        expect(JSON.parse(http.mock.calls[0]![1].body).Filter).toEqual({
            Sites: 'native.test',
            BlockHosts: 'ads.test',
            AuthInfoLevel: 1,
        });
    });

    it.each(['', 'https://api.search.tinyfish.ai/', 'https://api.fetch.tinyfish.ai/'])(
        'user searches at the TinySearch root when endpoint is %s',
        async (endpoint) => {
            http.mockResolvedValueOnce(json({ results: [source] }));
            const result = await search(
                { providers: { tinyfish: { enabled: true, apiKey: 'fixture-key', endpoint } } },
                { provider: 'tinyfish' }
            );
            expect(result.isError).toBe(false);
            const url = new URL(http.mock.calls[0]![0]);
            expect(url.origin + url.pathname).toBe('https://api.search.tinyfish.ai/');
        }
    );
});

describe('given engine fetches must respect request limits and selections', () => {
    it.each([
        'anysearch',
        'deepseek',
        'exa',
        'tavily',
        'firecrawl',
        'keenable',
        'doubao',
        'tinyfish',
        'serper',
    ])(
        'user stops oversized %s responses before parsing and recovers through direct reading',
        async (provider) => {
            const bytes = new TextEncoder().encode(
                JSON.stringify({ content: '正文'.repeat(40000) })
            );
            const cancelled = vi.fn();
            let offset = 0;
            http.mockResolvedValueOnce(
                new Response(
                    new ReadableStream<Uint8Array>(
                        {
                            pull(controller) {
                                if (offset >= bytes.length) {
                                    controller.close();
                                    return;
                                }
                                controller.enqueue(bytes.slice(offset, offset + 4096));
                                offset += 4096;
                            },
                            cancel: cancelled,
                        },
                        { highWaterMark: 0 }
                    )
                )
            ).mockResolvedValueOnce(
                new Response('direct recovery', { headers: { 'content-type': 'text/plain' } })
            );
            const result = await fetchPage(
                {
                    fetchStrategy: 'direct',
                    providers: { [provider]: { enabled: true, apiKey: 'fixture-key' } },
                },
                { provider, maxResponseBytes: 50000 }
            );
            expect(result.isError).toBe(false);
            expect(result.result).toContain('direct recovery');
            expect(cancelled).toHaveBeenCalledOnce();
            expect(offset).toBeLessThan(60000);
        }
    );

    it('user accepts an engine response exactly at the byte limit', async () => {
        const content = 'x'.repeat(50000 - JSON.stringify({ content: '' }).length);
        http.mockResolvedValueOnce(json({ content }));
        const result = await fetchPage(
            {
                fetchStrategy: 'prefer',
                providers: { deepseek: { enabled: true, apiKey: 'key' } },
                providerPriority: ['deepseek'],
            },
            { maxResponseBytes: 50000 }
        );
        expect(result.isError).toBe(false);
        expect(result.result).toContain('x'.repeat(2000));
    });

    it.each(['prefer', 'fallback', 'direct'])(
        'user keeps an explicit engine choice under the %s strategy even when it is disabled',
        async (fetchStrategy) => {
            http.mockImplementation(async (url: string) => {
                if (url === pageUrl)
                    return new Response('direct page', {
                        headers: { 'content-type': 'text/plain' },
                    });
                return json({ data: { content: 'other engine' } });
            });
            const result = await fetchPage(
                {
                    fetchStrategy,
                    providers: { exa: { enabled: true, apiKey: 'key', fetchEnabled: false } },
                },
                { provider: 'exa' }
            );
            expect(result.result).toContain('direct page');
            expect(http.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
        }
    );

    it('user sees the direct failure after an explicit engine fails without another engine taking over', async () => {
        // Only the engine and page requests fail; fixture teardown may probe the same mock.
        http.mockImplementation(async (url: string) => {
            if (url === pageUrl || url === 'https://api.exa.ai/contents') {
                throw new TypeError('connection failed');
            }
            return new Response('');
        });
        const result = await fetchPage(
            { fetchStrategy: 'fallback', providers: { exa: { enabled: true, apiKey: 'key' } } },
            { provider: 'exa' }
        );
        expect(result.isError).toBe(true);
        expect(http.mock.calls.map(([url]) => url)).toEqual([
            'https://api.exa.ai/contents',
            pageUrl,
        ]);
    });

    it.each([
        '',
        'https://api.search.tinyfish.ai/',
        'https://api.fetch.tinyfish.ai/',
        'https://gateway.test/tinyfish/v1/search',
    ])('user fetches at the TinyFetch endpoint corresponding to %s', async (endpoint) => {
        http.mockResolvedValueOnce(json({ results: [{ text: 'TinyFish body' }] }));
        const result = await fetchPage({
            fetchStrategy: 'prefer',
            providers: { tinyfish: { enabled: true, apiKey: 'key', endpoint } },
            providerPriority: ['tinyfish'],
        });
        expect(result.isError).toBe(false);
        expect(http.mock.calls[0]![0]).toBe(
            endpoint.includes('gateway')
                ? 'https://gateway.test/tinyfish/v1/fetch'
                : 'https://api.fetch.tinyfish.ai/'
        );
    });

    it.each(['page_text', 'page_markdown', 'reader'])(
        'user gets the requested %s representation before applying the character limit',
        async (mode) => {
            http.mockResolvedValueOnce(
                json({
                    content:
                        '# Heading\n\n[Link](https://example.com) and **strong** text.\n\n`literal_code`',
                })
            );
            const result = await fetchPage(
                {
                    fetchStrategy: 'prefer',
                    providers: { deepseek: { enabled: true, apiKey: 'key' } },
                    providerPriority: ['deepseek'],
                },
                { mode }
            );
            expect(result.isError).toBe(false);
            expect(result.result).toContain('Heading');
            expect(result.result).toContain('literal_code');
            if (mode === 'page_text') {
                expect(result.result).not.toContain('# Heading');
                expect(result.result).not.toContain('[Link]');
                expect(result.result).not.toContain('**strong**');
                expect(result.result).toContain('text/plain');
            } else {
                expect(result.result).toContain('# Heading');
                expect(result.result).toContain('[Link](https://example.com)');
            }
        }
    );

    it('user receives plain text when reading a direct Markdown response in text mode', async () => {
        http.mockResolvedValueOnce(
            new Response('# Heading\n\n[Link](https://example.com)', {
                headers: { 'content-type': 'text/markdown' },
            })
        );
        const result = await fetchPage({ fetchStrategy: 'direct' });
        expect(result.isError).toBe(false);
        expect(result.result).not.toContain('# Heading');
        expect(result.result).not.toContain('[Link]');
    });
});

describe('given provider response contracts differ from the generic mapping', () => {
    it('user omits stream for Exa lite searches', async () => {
        http.mockResolvedValueOnce(json({ results: [source] }));
        const result = await search(
            { providers: { exa: { enabled: true, apiKey: 'exa-key' } } },
            { provider: 'exa', mode: 'fast' }
        );
        expect(result.isError).toBe(false);
        const request = JSON.parse(String(http.mock.calls[0]![1].body)) as Record<string, unknown>;
        expect(request.type).toBe('lite');
        expect(request).not.toHaveProperty('stream');
    });

    it('user keeps stream:false for non-lite Exa searches', async () => {
        http.mockResolvedValueOnce(json({ results: [source] }));
        await search(
            { providers: { exa: { enabled: true, apiKey: 'exa-key' } } },
            { provider: 'exa', mode: 'balanced' }
        );
        const request = JSON.parse(String(http.mock.calls[0]![1].body)) as Record<string, unknown>;
        expect(request.stream).toBe(false);
    });

    it('user gets GitHub topics as topic pages instead of losing every row', async () => {
        http.mockResolvedValueOnce(json({ items: [{ name: 'typescript' }] }));
        const result = await search(
            {},
            {
                provider: 'github',
                providerOptions: { github: { searchType: 'topics' } },
            }
        );
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({
            sources: [{ url: 'https://github.com/topics/typescript' }],
        });
    });

    it.each(['scholar', 'patents'])('user gets Serper %s rows from organic', async (searchType) => {
        http.mockResolvedValueOnce(
            json({ organic: [{ title: 'Paper', link: 'https://paper.test/1' }] })
        );
        const result = await search(
            { providers: { serper: { enabled: true, apiKey: 'serper-key' } } },
            { provider: 'serper', providerOptions: { serper: { searchType } } }
        );
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({
            sources: [{ url: 'https://paper.test/1' }],
        });
    });

    it('user gets Serper place links from website or a Maps fallback', async () => {
        http.mockResolvedValueOnce(
            json({
                places: [
                    { title: 'Cafe', address: '1 Road', website: 'https://cafe.test' },
                    { title: 'Park', address: '2 Road', latitude: 31.2, longitude: 121.4 },
                ],
            })
        );
        const result = await search(
            { providers: { serper: { enabled: true, apiKey: 'serper-key' } } },
            { provider: 'serper', providerOptions: { serper: { searchType: 'places' } } }
        );
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({
            sources: [
                { url: 'https://cafe.test' },
                { url: 'https://www.google.com/maps/search/?api=1&query=31.2%2C121.4' },
            ],
        });
    });

    it('user omits TinyFish recency when searching research papers', async () => {
        http.mockResolvedValueOnce(json({ results: [source] }));
        const result = await search(
            { providers: { tinyfish: { enabled: true, apiKey: 'tiny-key' } } },
            { provider: 'tinyfish', source: 'academic', recencyDays: 7 }
        );
        expect(result.isError).toBe(false);
        const url = new URL(String(http.mock.calls[0]![0]));
        expect(url.searchParams.get('domain_type')).toBe('research_paper');
        expect(url.searchParams.get('recency_minutes')).toBeNull();
        expect(url.searchParams.get('pub_year_min')).toMatch(/^\d{4}$/);
    });

    it('user falls back to the next engine when Yuanbao rate-limits', async () => {
        http.mockResolvedValueOnce(
            json({ Response: { Error: { Code: 'RequestLimitExceeded', Message: 'rate limited' } } })
        ).mockResolvedValueOnce(json({ results: [source] }));
        const result = await search(
            {
                routingStrategy: 'priority',
                providerPriority: ['yuanbao', 'tavily'],
                fallbackEnabled: true,
                providers: { yuanbao: { enabled: true, apiKey: 'yuanbao-key' } },
            },
            {}
        );
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({ provider: 'tavily' });
        expect(http.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
            'api.wsa.cloud.tencent.com',
            'api.tavily.com',
        ]);
    });

    it('user falls back when DeepSeek rejects a long query', async () => {
        http.mockResolvedValueOnce(json({ results: [source] }));
        const result = await search(
            {
                routingStrategy: 'priority',
                providerPriority: ['deepseek', 'tavily'],
                fallbackEnabled: true,
                providers: { deepseek: { enabled: true, apiKey: 'deepseek-key' } },
            },
            { query: 'q'.repeat(200) }
        );
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({ provider: 'tavily' });
        expect(http.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
            'api.tavily.com',
        ]);
    });

    it('user is told when providerOptions target a disabled engine', async () => {
        const result = await search(
            { providers: { grok: { enabled: false } } },
            { provider: 'auto', providerOptions: { grok: { extra: true } } }
        );
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toContain('disabled engines');
        expect(http).not.toHaveBeenCalled();
    });
});

describe('given an engine fetch endpoint is configured for search', () => {
    it('user reads Serper pages through the scrape route', async () => {
        http.mockResolvedValueOnce(
            json({ markdown: 'scraped body', metadata: { sourceURL: pageUrl } })
        );
        const result = await fetchPage(
            {
                fetchStrategy: 'prefer',
                providerPriority: ['serper'],
                providers: {
                    serper: {
                        enabled: true,
                        apiKey: 'serper-key',
                        endpoint: 'https://google.serper.dev/search',
                    },
                },
            },
            { maxResponseBytes: 100000 }
        );
        expect(result.isError).toBe(false);
        expect(result.result).toContain('scraped body');
        expect(http.mock.calls[0]![0]).toBe('https://scrape.serper.dev');
    });
});
