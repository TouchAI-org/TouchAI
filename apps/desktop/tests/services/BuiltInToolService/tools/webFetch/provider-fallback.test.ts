import { createWebFetchToolsFixture } from '@tests/utils/webFetchTools';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tauriFetchMock, readSettingsMock } = vi.hoisted(() => ({
    tauriFetchMock: vi.fn(),
    readSettingsMock: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: tauriFetchMock }));

function context(): Parameters<typeof executeWebFetchTool>[2] {
    return { signal: new AbortController().signal, callId: 'fetch', iteration: 1 };
}

function settingsOf(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        fetchStrategy: 'fallback',
        providers: { deepseek: { enabled: true, apiKey: 'ds-key' } },
        providerPriority: ['deepseek'],
        ...overrides,
    });
}

function json(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('user reads a page through a configured search engine', () => {
    it.each(['https://gateway.example/firecrawl', 'https://gateway.example/firecrawl/v2/search'])(
        'user reads through the configured Firecrawl gateway when its search endpoint is %s',
        async (endpoint) => {
            readSettingsMock.mockResolvedValue(
                settingsOf({
                    fetchStrategy: 'prefer',
                    providers: { firecrawl: { enabled: true, apiKey: 'firecrawl-key', endpoint } },
                    providerPriority: ['firecrawl'],
                })
            );
            tauriFetchMock.mockResolvedValueOnce(json({ data: { markdown: 'gateway page' } }));

            const result = await executeWebFetchTool(
                { url: 'https://example.com/a', mode: 'page_text', maxChars: 2000 },
                {},
                context()
            );

            expect(result.isError).toBe(false);
            expect(result.result).toContain('gateway page');
            expect(tauriFetchMock.mock.calls[0]?.[0]).toBe(
                'https://gateway.example/firecrawl/v2/scrape'
            );
            expect(tauriFetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
                Authorization: 'Bearer firecrawl-key',
            });
        }
    );
    it('user recovers from an engine error without leaving its response stream allocated', async () => {
        readSettingsMock.mockResolvedValue(
            settingsOf({ fetchStrategy: 'prefer', providerPriority: ['anysearch', 'tavily'] })
        );
        const cancelled = vi.fn();
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                controller.enqueue(new TextEncoder().encode('busy'));
            },
            cancel: cancelled,
        });
        tauriFetchMock
            .mockResolvedValueOnce(new Response(stream, { status: 429 }))
            .mockResolvedValueOnce(json({ results: [{ raw_content: 'Recovered page' }] }));
        const result = await executeWebFetchTool(
            { url: 'https://example.com/a', mode: 'page_text', maxChars: 2000 },
            {},
            context()
        );
        expect(result.isError).toBe(false);
        expect(result.result).toContain('Recovered page');
        expect(cancelled).toHaveBeenCalledOnce();
    });
    it('user gets engine-extracted content when direct fetch is rate limited', async () => {
        readSettingsMock.mockResolvedValue(settingsOf());
        tauriFetchMock
            .mockResolvedValueOnce(
                new Response('blocked', {
                    status: 429,
                    statusText: 'Too Many Requests',
                    headers: { 'content-type': 'text/html' },
                })
            )
            .mockResolvedValueOnce(
                json({ title: 'Example', content: '# Example\n\nFull page text.' })
            );

        const result = await executeWebFetchTool(
            { url: 'https://example.com/a', mode: 'page_text', maxChars: 2000 },
            {},
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('Full page text.');
        expect(tauriFetchMock.mock.calls[1]?.[0]).toContain('/v1/tools/fetch');
        expect(
            (tauriFetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>).Authorization
        ).toBe('Bearer ds-key');
    });

    it('user gets engine content first when the prefer strategy is selected', async () => {
        readSettingsMock.mockResolvedValue(settingsOf({ fetchStrategy: 'prefer' }));
        tauriFetchMock.mockResolvedValueOnce(json({ title: 'T', content: 'engine body' }));

        const result = await executeWebFetchTool(
            { url: 'https://example.com/b', mode: 'page_text', maxChars: 2000 },
            {},
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('engine body');
        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
    });

    it('user gets AnySearch extract when it is the only enabled engine', async () => {
        readSettingsMock.mockResolvedValue(
            settingsOf({
                providers: { anysearch: { enabled: true, apiKey: '' } },
                providerPriority: ['anysearch'],
            })
        );
        tauriFetchMock
            .mockResolvedValueOnce(new Response('busy', { status: 503 }))
            .mockResolvedValueOnce(json({ data: { title: 'Any', content: 'anysearch body' } }));

        const result = await executeWebFetchTool(
            { url: 'https://example.com/d', mode: 'page_text', maxChars: 2000 },
            {},
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('anysearch body');
        expect(tauriFetchMock.mock.calls[1]?.[0]).toContain('/v1/extract');
    });

    it('user gets Serper scrape content when it is the first configured engine', async () => {
        readSettingsMock.mockResolvedValue(
            settingsOf({
                providers: { serper: { enabled: true, apiKey: 'serper-key' } },
                providerPriority: ['serper'],
            })
        );
        tauriFetchMock
            .mockResolvedValueOnce(new Response('blocked', { status: 403 }))
            .mockResolvedValueOnce(
                json({ markdown: 'serper body', metadata: { title: 'Serper' } })
            );

        const result = await executeWebFetchTool(
            { url: 'https://example.com/e', mode: 'page_text', maxChars: 2000 },
            {},
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('serper body');
        expect(
            (tauriFetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)['X-API-KEY']
        ).toBe('serper-key');
    });

    it('user gets only direct fetch when the direct strategy is selected', async () => {
        readSettingsMock.mockResolvedValue(settingsOf({ fetchStrategy: 'direct' }));
        tauriFetchMock.mockResolvedValueOnce(
            new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } })
        );

        const result = await executeWebFetchTool(
            { url: 'https://example.com/c', mode: 'page_text', maxChars: 2000 },
            {},
            context()
        );

        expect(result.isError).toBe(false);
        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
    });
});

describe('user explicitly selects a fetch engine', () => {
    it('user gets the requested engine even when the direct strategy is selected', async () => {
        readSettingsMock.mockResolvedValue(
            settingsOf({
                fetchStrategy: 'direct',
                providers: {
                    exa: { enabled: true, apiKey: 'exa-key', fetchEnabled: true },
                },
                providerPriority: ['exa'],
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            json({
                results: [
                    {
                        title: 'Exa page',
                        url: 'https://example.com/exa',
                        text: 'exa extracted body',
                    },
                ],
            })
        );

        const result = await executeWebFetchTool(
            {
                url: 'https://example.com/a',
                mode: 'reader',
                maxChars: 2000,
                provider: 'exa',
            },
            {},
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('exa extracted body');
        expect(tauriFetchMock.mock.calls[0]?.[0]).toContain('/contents');
        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
    });

    it('user falls back to direct fetch when the requested engine is disabled for fetching', async () => {
        readSettingsMock.mockResolvedValue(
            settingsOf({
                fetchStrategy: 'direct',
                providers: {
                    exa: { enabled: true, apiKey: 'exa-key', fetchEnabled: false },
                },
                providerPriority: ['exa'],
            })
        );
        tauriFetchMock.mockResolvedValueOnce(
            new Response('direct body', {
                status: 200,
                headers: { 'content-type': 'text/plain' },
            })
        );

        const result = await executeWebFetchTool(
            {
                url: 'https://example.com/a',
                mode: 'page_text',
                maxChars: 2000,
                provider: 'exa',
            },
            {},
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('direct body');
        expect(tauriFetchMock).toHaveBeenCalledTimes(1);
        expect(tauriFetchMock.mock.calls[0]?.[0]).toBe('https://example.com/a');
    });
});

const { execute: executeWebFetchTool } = createWebFetchToolsFixture({ read: readSettingsMock });
